/*
 * GitHub Activity widget
 * Adapted for desktop-widgets@r3nhick rendering system
 * Sizes: 2×1 mini, 2×1, 2×2
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';
import { getDataDir, isActorDestroyed, loadJsonFromFileAsync, saveJsonToFile, parseCssColor, cssColorToRgba } from '../../utils/ported.js';

export const type = 'github';
export const label = 'GitHub Activity';
export const defaultSize = 'medium';
export const supportedSizes = ['mini', 'medium', 'large'];

const SECONDARY_OPACITY = 0.55;
const DAY_LABEL_ROWS = { 1: 'Mon', 3: 'Wed', 5: 'Fri' };
const DAY_LABEL_ROWS_MINI = { 1: 'M', 3: 'W', 5: 'F' };
const REFRESH_INTERVAL = 600;
const HTTP_OK = 200;
const WIDGET_PADDING = 16;
const GITHUB_GREEN_COLORS = ['#39d353', '#26a641', '#006d32', '#0e4429'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const decoder = new TextDecoder();

function contributionLevel(count) {
    if (count >= 10) return 4;
    if (count >= 6) return 3;
    if (count >= 3) return 2;
    if (count >= 1) return 1;
    return 0;
}

function formatCount(n) {
    if (n >= 10000) return `${(n / 1000).toFixed(0)}k`;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace('.0', '')}k`;
    return String(n);
}

export function style(theme) {
    const textRgba = (a) => cssColorToRgba(theme.text, a);
    return `background-color: ${theme.background}; border-color: ${textRgba(0.14)}; color: ${theme.text};`;
}

export function render({ body, widget, theme, sizeForWidget, settings }) {
    const textColor = theme.text;
    const accentHex = theme.accent || '#3584e4';
    const textRgba = (a) => cssColorToRgba(textColor, a);

    // Empty cell color is explicitly #454545 so it stands out against the widget background
    const emptyCellColor = '#454545';

    const useGreen = settings?.get_boolean('github-use-green') ?? false;
    const levelColors = useGreen
        ? GITHUB_GREEN_COLORS
        : [
            cssColorToRgba(accentHex, 1.0),
            cssColorToRgba(accentHex, 0.75),
            cssColorToRgba(accentHex, 0.50),
            cssColorToRgba(accentHex, 0.25),
        ];

    const sizeKey = widget?.size ?? 'medium';
    const isMini = sizeKey === 'mini';
    const isLarge = sizeKey === 'large';

    const [refW, refH] = sizeForWidget ? sizeForWidget(widget) : (isMini ? [260, 120] : (isLarge ? [394, 394] : [394, 190]));

    // The .widget style adds 16px padding on each side
    const contentW = refW - WIDGET_PADDING * 2 - 2;
    const contentH = refH - WIDGET_PADDING * 2 - 2;

    const layout = isMini
        ? {
            avatar: 20, username: 13, badge: 12, label: 7, entryWidth: 100,
            footer: 0, month: 0, spacing: 3, gap: 1, daysW: 16,
            footerFont: 0, dayRows: DAY_LABEL_ROWS_MINI, maxWeeks: 22,
        }
        : isLarge
            ? {
                avatar: 34, username: 16, badge: 18, label: 11, entryWidth: 170,
                footer: 14, month: 14, spacing: 6, gap: 2, daysW: 24,
                footerFont: 12, dayRows: DAY_LABEL_ROWS, maxWeeks: 24,
            }
            : {
                avatar: 28, username: 14, badge: 12, label: 10, entryWidth: 150,
                footer: 12, month: 12, spacing: 3, gap: 2, daysW: 24,
                footerFont: 11, dayRows: DAY_LABEL_ROWS, maxWeeks: 24,
            };

    const avatarSize = layout.avatar;
    const cellGap = layout.gap;
    const dayLabelsWidth = layout.daysW;

    const mainGaps = isMini ? layout.spacing : layout.spacing * 2;
    const matrixBudget = contentH - layout.avatar - layout.month - layout.footer - mainGaps - 1;
    const cellMax = isLarge ? 20 : 16;
    const cellSize = Math.max(4, Math.min(cellMax, Math.floor((matrixBudget - 6 * cellGap) / 7)));
    const weeks = Math.max(6, Math.min(layout.maxWeeks, Math.floor((contentW - dayLabelsWidth + cellGap) / (cellSize + cellGap))));

    const dataFilePath = GLib.build_filenamev([getDataDir('github'), `github-${widget?.id}.json`]);

    let username = '';
    let avatarInitials = '?';
    const state = { timerId: null, editing: false, cancellable: new Gio.Cancellable() };
    const session = new Soup.Session();
    let latestByDate = new Map();
    let lastSyncTime = null;
    let currentStreak = 0;
    let longestStreak = 0;
    let todayCount = 0;

    body.set_clip_to_allocation(true);

    const setStatus = (text) => {
        statusLabel.text = text;
    };

    const mainBox = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
        style: `spacing: ${layout.spacing}px;`,
    });
    body.add_child(mainBox);

    // --- HEADER ---
    const headerBox = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        x_align: Clutter.ActorAlign.FILL,
        x_expand: true,
        style: `spacing: ${isMini ? 5 : 8}px;`,
    });

    const avatarWidget = new St.DrawingArea({
        style: `background-color: ${textRgba(0.15)}; border-radius: 999px; width: ${avatarSize}px; height: ${avatarSize}px;`,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: false,
    });

    avatarWidget.connect('repaint', canvas => {
        if (isActorDestroyed(body)) return;
        const ctx = canvas.get_context();
        const [w, h] = canvas.get_surface_size();
        const radius = Math.min(w, h) / 2;
        ctx.newPath();
        ctx.arc(w / 2, h / 2, radius - 0.5, 0, 2 * Math.PI);
        ctx.clip();

        const bg = parseCssColor(textRgba(0.15));
        ctx.setSourceRGBA(bg.r, bg.g, bg.b, bg.a ?? 1);
        ctx.paint();

        if (avatarInitials) {
            const layout = PangoCairo.create_layout(ctx);
            layout.set_text(avatarInitials, -1);
            const fontDesc = Pango.FontDescription.from_string(`700 ${Math.max(6, Math.round(avatarSize * 0.4))}px sans-serif`);
            layout.set_font_description(fontDesc);
            PangoCairo.update_layout(ctx, layout);
            const [tw, th] = layout.get_pixel_size();
            const textC = parseCssColor(textColor);
            ctx.moveTo((w - tw) / 2, (h - th) / 2);
            ctx.setSourceRGBA(textC.r, textC.g, textC.b, 1);
            PangoCairo.show_layout(ctx, layout);
        }
        ctx.$dispose();
    });

    const usernameLabel = new St.Label({
        text: 'Click to set username',
        y_align: Clutter.ActorAlign.CENTER,
        style: `font-size: ${layout.username}px; font-weight: 700; color: ${textColor};`,
        reactive: true,
    });

    const usernameEntry = new St.Entry({
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
        style: `font-size: ${layout.username}px; color: ${textColor}; width: ${layout.entryWidth}px;`,
    });
    usernameEntry.hide();

    const headerSpacer = new St.Widget({ x_expand: true });

    const badgeLabel = new St.Label({
        text: '',
        y_align: Clutter.ActorAlign.CENTER,
        style: `font-size: ${layout.badge || 11}px; font-weight: 700; color: ${textColor};`,
    });

    // In mini the status lives in the header (no footer row)
    const statusLabel = new St.Label({
        text: isMini ? 'Set user' : 'Click username to configure',
        y_align: Clutter.ActorAlign.CENTER,
        style: `font-size: ${isMini ? 8 : layout.footerFont - 1}px; color: ${textColor}; opacity: ${SECONDARY_OPACITY};`,
    });

    headerBox.add_child(avatarWidget);
    headerBox.add_child(usernameLabel);
    headerBox.add_child(usernameEntry);
    headerBox.add_child(headerSpacer);
    headerBox.add_child(badgeLabel);
    mainBox.add_child(headerBox);

    // --- MATRIX ---
    const matrixBox = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: isLarge ? false : true,
    });
    mainBox.add_child(matrixBox);

    const monthLabelsRow = new St.Widget({ x_align: Clutter.ActorAlign.START });
    matrixBox.add_child(monthLabelsRow);

    const matrixBody = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        x_align: Clutter.ActorAlign.FILL,
        x_expand: true,
        y_expand: isLarge ? false : true,
    });
    matrixBox.add_child(matrixBody);

    const dayLabelsColumn = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style: `width: ${dayLabelsWidth}px;`,
    });
    matrixBody.add_child(dayLabelsColumn);

    const gridCanvas = new St.DrawingArea({
        x_expand: false,
        style: `background-color: ${theme.background};`,
    });
    matrixBody.add_child(gridCanvas);

    // --- STATS (for large size only) ---
    let statsBox = null;
    if (isLarge) {
        statsBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style: `spacing: 6px; margin-top: 4px;`,
        });
        mainBox.add_child(statsBox);
    }

    // --- FOOTER (medium and large only) ---
    let footerBox = null;
    if (!isMini) {
        footerBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.FILL,
            x_expand: true,
        });

        footerBox.add_child(statusLabel);

        const legendBox = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
            style: `spacing: 3px;`,
        });

        const lessLabel = new St.Label({
            text: 'Less',
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${layout.footerFont - 1}px; color: ${textColor}; opacity: ${SECONDARY_OPACITY}; margin-right: 3px;`,
        });
        legendBox.add_child(lessLabel);

        const legendColors = [emptyCellColor, ...levelColors.slice().reverse()];
        legendColors.forEach(color => {
            const sq = new St.Widget({
                y_align: Clutter.ActorAlign.CENTER,
                style: `background-color: ${color}; border-radius: 2px; width: 9px; height: 9px;`,
            });
            legendBox.add_child(sq);
        });

        const moreLabel = new St.Label({
            text: 'More',
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${layout.footerFont - 1}px; color: ${textColor}; opacity: ${SECONDARY_OPACITY}; margin-left: 3px;`,
        });
        legendBox.add_child(moreLabel);

        footerBox.add_child(legendBox);
        mainBox.add_child(footerBox);
    }

    // --- MATRIX DRAWING ---
    const matrixGeometry = { size: 0, gap: 0, dataKey: '', cells: [] };

    function traceRoundedRect(ctx, x, y, w, h, radius) {
        ctx.newSubPath();
        ctx.arc(x + radius, y + radius, radius, Math.PI, 1.5 * Math.PI);
        ctx.arc(x + w - radius, y + radius, radius, 1.5 * Math.PI, 2 * Math.PI);
        ctx.arc(x + w - radius, y + h - radius, radius, 2 * Math.PI, 2.5 * Math.PI);
        ctx.arc(x + radius, y + h - radius, radius, 2.5 * Math.PI, 3 * Math.PI);
        ctx.closePath();
    }

    gridCanvas.connect('repaint', canvas => {
        const { size, cells } = matrixGeometry;
        if (size <= 0) return;
        const ctx = canvas.get_context();
        const [cw, ch] = canvas.get_surface_size();
        const radius = isMini ? 1.2 : 2.5;
        for (const cell of cells) {
            if (cell.x + size > cw || cell.y + size > ch) continue;
            const c = parseCssColor(cell.color);
            ctx.setSourceRGBA(c.r, c.g, c.b, c.a !== undefined ? c.a : 1);
            traceRoundedRect(ctx, cell.x, cell.y, size, size, radius);
            ctx.fill();
        }
        ctx.$dispose();
    });

    function renderMonthLabels(weeksToRender, startUnix) {
        if (isMini) return;
        const pitch = cellSize + cellGap;
        monthLabelsRow.destroy_all_children();
        monthLabelsRow.style = `margin-left: ${dayLabelsWidth}px; height: ${layout.month}px;`;
        let curMonth = -1;
        for (let w = 0; w < weeksToRender; w++) {
            if (dayLabelsWidth + w * pitch + 36 > contentW) break;
            const dt = GLib.DateTime.new_from_unix_local(startUnix + w * 7 * 86400);
            const month = dt.get_month() - 1;
            if (month === curMonth) continue;
            curMonth = month;
            const lbl = new St.Label({
                text: MONTH_NAMES[month],
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: ${layout.label}px; color: ${textColor}; opacity: ${SECONDARY_OPACITY};`,
            });
            lbl.translation_x = w * pitch;
            monthLabelsRow.add_child(lbl);
        }
    }

    function renderDayLabels() {
        dayLabelsColumn.destroy_all_children();
        dayLabelsColumn.style = `width: ${dayLabelsWidth}px; spacing: ${cellGap}px;`;
        for (let row = 0; row < 7; row++) {
            const slot = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                width: dayLabelsWidth,
                height: cellSize,
            });
            if (layout.dayRows[row]) {
                const lbl = new St.Label({
                    text: layout.dayRows[row],
                    y_align: Clutter.ActorAlign.CENTER,
                    style: `font-size: ${layout.label}px; color: ${textColor}; opacity: ${SECONDARY_OPACITY};`,
                });
                slot.add_child(lbl);
            }
            dayLabelsColumn.add_child(slot);
        }
    }

    function cellColorFor(level) {
        if (level === 0) return emptyCellColor;
        return levelColors[4 - level];
    }

    function renderMatrix(contributionsByDate) {
        const byDate = contributionsByDate || latestByDate;
        const dataKey = `${cellSize}|${cellGap}|${weeks}|${useGreen}|${contentW}`;
        if (dataKey === matrixGeometry.dataKey && !contributionsByDate) return;

        renderDayLabels();

        const today = GLib.DateTime.new_now_local();
        const daysInGrid = weeks * 7;
        const gridEnd = today.add_days(6 - (today.get_day_of_week() % 7));
        const alignedStart = gridEnd.add_days(-(daysInGrid - 1));

        renderMonthLabels(weeks + 1, alignedStart.to_unix());

        const cells = [];
        for (let i = 0; i < daysInGrid; i++) {
            const date = alignedStart.add_days(i);
            if (date.compare(today) > 0) break;
            const dateKey = date.format('%Y-%m-%d');
            const col = Math.floor(i / 7);
            const row = date.get_day_of_week() % 7;
            const level = contributionLevel(byDate.get(dateKey) ?? 0);
            cells.push({
                x: col * (cellSize + cellGap),
                y: row * (cellSize + cellGap),
                color: cellColorFor(level),
            });
        }

        matrixGeometry.size = cellSize;
        matrixGeometry.gap = cellGap;
        matrixGeometry.dataKey = dataKey;
        matrixGeometry.cells = cells;

        gridCanvas.set_width(Math.max(1, weeks * (cellSize + cellGap) - cellGap));
        gridCanvas.set_height(Math.max(1, 7 * (cellSize + cellGap) - cellGap));
        gridCanvas.queue_repaint();
    }

    // --- STATS RENDERING (for large size only) ---
    function computeStats(byDate) {
        const today = GLib.DateTime.new_now_local();
        const todayKey = today.format('%Y-%m-%d');
        todayCount = byDate.get(todayKey) ?? 0;

        let streak = 0;
        let longest = 0;
        let tempStreak = 0;
        let total = 0;

        // Compute streaks from today backwards
        const checkDate = GLib.DateTime.new_now_local();
        for (let i = 0; i < 365; i++) {
            const d = checkDate.add_days(-i);
            const key = d.format('%Y-%m-%d');
            const count = byDate.get(key) ?? 0;
            total += count;
            if (count > 0) {
                tempStreak++;
                if (tempStreak > longest) longest = tempStreak;
                if (i === 0 || streak === i) streak = tempStreak;
            } else {
                tempStreak = 0;
            }
        }

        currentStreak = streak;
        longestStreak = longest;
    }

    function renderStats() {
        if (!statsBox) return;
        statsBox.destroy_all_children();

        const accentRgb = parseCssColor(accentHex);
        const accentBytes = `${Math.round(accentRgb.r * 255)},${Math.round(accentRgb.g * 255)},${Math.round(accentRgb.b * 255)}`;
        const statBg = `background-color: rgba(${accentBytes},0.08);`;

        const statsData = [
            { icon: 'emoji-recent-symbolic', label: 'Today', value: String(todayCount) },
            { icon: 'media-playlist-consecutive-symbolic', label: 'Current streak', value: `${currentStreak}d` },
            { icon: 'starred-symbolic', label: 'Longest streak', value: `${longestStreak}d` },
        ];

        for (const stat of statsData) {
            const row = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                x_expand: true,
                style: statBg + ` border-radius: 10px; padding: 6px 12px; spacing: 8px;`,
            });

            const icon = new St.Icon({
                icon_name: stat.icon,
                icon_size: 14,
                style: `color: ${accentHex};`,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const labelWidget = new St.Label({
                text: stat.label,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: 12px; color: ${textColor}; opacity: ${SECONDARY_OPACITY};`,
            });

            const valueWidget = new St.Label({
                text: stat.value,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: 14px; font-weight: 700; color: ${textColor};`,
            });

            row.add_child(icon);
            row.add_child(labelWidget);
            row.add_child(valueWidget);
            statsBox.add_child(row);
        }
    }

    // --- NETWORK ---
    function fetchContributions() {
        if (!username) return;
        setStatus(isMini ? '…' : 'Fetching…');
        const url = `https://github-contributions-api.jogruber.de/v4/${encodeURIComponent(username)}`;
        const message = Soup.Message.new('GET', url);
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, state.cancellable, (s, res) => {
            if (isActorDestroyed(body) || mainBox.get_parent() !== body) return;
            try {
                const bytes = s.send_and_read_finish(res);
                if (message.get_status() !== HTTP_OK) throw new Error(`HTTP ${message.get_status()}`);
                const data = JSON.parse(decoder.decode(bytes.get_data()));
                if (!data || !Array.isArray(data.contributions)) throw new Error('bad data');
                const byDate = new Map();
                data.contributions.forEach(d => byDate.set(d.date, d.count || 0));
                const yearKeys = Object.keys(data.total || {});
                const latestYear = yearKeys.length ? yearKeys[yearKeys.length - 1] : null;
                const sumAll = [...byDate.values()].reduce((a, b) => a + b, 0);
                const yearTotal = latestYear !== null ? (data.total[latestYear] ?? sumAll) : sumAll;
                badgeLabel.text = `${formatCount(yearTotal)} commits`;
                lastSyncTime = GLib.DateTime.new_now_local();
                setStatus(isMini
                    ? lastSyncTime.format('%H:%M')
                    : `Synced ${lastSyncTime.format('%H:%M')}`);
                latestByDate = byDate;
                renderMatrix(byDate);

                saveJsonToFile(dataFilePath, {
                    username,
                    total: data.total || {},
                    contributions: data.contributions.map(d => ({ date: d.date, count: d.count || 0 })),
                });

                if (isLarge) {
                    computeStats(byDate);
                    renderStats();
                }
            } catch (err) {
                const cancelled = err.matches && err.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
                if (!cancelled) {
                    const cached = latestByDate.size > 0;
                    setStatus(isMini
                        ? (cached ? 'Cached' : 'Error')
                        : (cached ? 'Offline — cached' : 'Error loading'));
                }
            }
        });
    }

    function updateHeader() {
        usernameLabel.text = username || 'Click to set username';
        avatarInitials = username ? username.slice(0, 2).toUpperCase() : '?';
        avatarWidget.queue_repaint();
    }

    // --- USERNAME EDITING ---
    const startEdit = () => {
        if (state.editing) return;
        state.editing = true;
        usernameEntry.text = username;
        usernameLabel.hide();
        usernameEntry.show();
        global.stage.set_key_focus(usernameEntry);
    };

    const endEdit = (commit) => {
        if (!state.editing) return;
        state.editing = false;
        const submitted = usernameEntry.get_text().trim().replace(/^@/, '');
        usernameEntry.hide();
        usernameLabel.show();
        if (global.stage.get_key_focus() === usernameEntry)
            global.stage.set_key_focus(null);
        if (!commit || submitted === '' || submitted === username) return;
        username = submitted;
        latestByDate = new Map();
        badgeLabel.text = '';
        lastSyncTime = null;
        if (isLarge) {
            currentStreak = 0;
            longestStreak = 0;
            todayCount = 0;
        }
        saveJsonToFile(dataFilePath, { username });
        avatarWidget.queue_repaint();
        updateHeader();
        renderMatrix(new Map());
        if (isLarge) renderStats();
        fetchContributions();
    };

    usernameLabel.connect('button-press-event', (_actor, event) => {
        if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
        startEdit();
        return Clutter.EVENT_STOP;
    });

    usernameEntry.clutter_text.connect('key-press-event', (_actor, event) => {
        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { endEdit(true); return Clutter.EVENT_STOP; }
        if (sym === Clutter.KEY_Escape) { endEdit(false); return Clutter.EVENT_STOP; }
        return Clutter.EVENT_PROPAGATE;
    });
    usernameEntry.clutter_text.connect('key-focus-out', () => endEdit(false));

    // --- REFRESH TIMER ---
    state.timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_INTERVAL, () => {
        if (isActorDestroyed(body) || mainBox.get_parent() !== body) return GLib.SOURCE_REMOVE;
        fetchContributions();
        return GLib.SOURCE_CONTINUE;
    });

    // --- CLEANUP ---
    body.connect('destroy', () => {
        state.cancellable.cancel();
        if (state.timerId) { GLib.source_remove(state.timerId); state.timerId = null; }
        session.abort();
        if (global.stage.get_key_focus() === usernameEntry)
            global.stage.set_key_focus(null);
    });

    // --- INIT ---
    renderMatrix();
    updateHeader();

    loadJsonFromFileAsync(dataFilePath, (savedData, loadError) => {
        if (isActorDestroyed(body) || mainBox.get_parent() !== body) return;
        if (savedData && typeof savedData.username === 'string') {
            username = savedData.username;
            updateHeader();

            if (Array.isArray(savedData.contributions)) {
                const cached = new Map();
                savedData.contributions.forEach(d => {
                    if (d && typeof d.date === 'string')
                        cached.set(d.date, Number(d.count) || 0);
                });
                if (cached.size > 0) {
                    latestByDate = cached;
                    renderMatrix(cached);

                    const yearKeys = Object.keys(savedData.total || {});
                    const latestYear = yearKeys.length ? yearKeys[yearKeys.length - 1] : null;
                    const sumAll = [...cached.values()].reduce((a, b) => a + b, 0);
                    const yearTotal = latestYear !== null ? (savedData.total[latestYear] ?? sumAll) : sumAll;
                    badgeLabel.text = `${formatCount(yearTotal)} commits`;
                    lastSyncTime = null;
                    setStatus(isMini ? 'Cached' : 'Cached offline');

                    if (isLarge) {
                        computeStats(cached);
                        renderStats();
                    }
                }
            }

            fetchContributions();
        } else {
            if (!loadError) saveJsonToFile(dataFilePath, { username });
        }
    });
}