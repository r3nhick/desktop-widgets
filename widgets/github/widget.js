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
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { getDataDir, isActorDestroyed, loadJsonFromFileAsync, saveJsonToFile, parseCssColor, cssColorToRgba } from '../../utils/ported.js';
import { bindHoverShrink } from '../../lib/buttonBounce.js';

export const type = 'github';
export const label = 'GitHub Activity';
export const defaultSize = 'medium';
export const supportedSizes = ['mini', 'medium', 'large'];

const profileUrls = new Map();

export function getProfileUrl(widgetId) {
    return profileUrls.get(widgetId) ?? null;
}

const profileUrlFor = username => username
    ? `https://github.com/${encodeURIComponent(username)}`
    : null;

const SECONDARY_OPACITY = 0.55;
const DAY_LABEL_ROWS = { 1: 'Mon', 3: 'Wed', 5: 'Fri' };
const DAY_LABEL_ROWS_MINI = { 1: 'M', 3: 'W', 5: 'F' };
const REFRESH_INTERVAL = 600;
const HTTP_OK = 200;
const WIDGET_PADDING = 16;
const GITHUB_GREEN_COLORS = ['#39d353', '#26a641', '#006d32', '#0e4429'];
const AVATAR_MAX_AGE_SECONDS = 24 * 60 * 60;
// GitHub logins: letters, digits and single hyphens. Anything else is not a
// valid account and must never end up in a file name (avatar cache path).
const safeFileToken = name => String(name).replace(/[^A-Za-z0-9_-]/g, '_');

const monthNames = () =>
    [_('Jan'), _('Feb'), _('Mar'), _('Apr'), _('May'), _('Jun'),
     _('Jul'), _('Aug'), _('Sep'), _('Oct'), _('Nov'), _('Dec')];

const translateDayRows = rows => {
    const labels = {
        Mon: _('Mon'),
        Wed: _('Wed'),
        Fri: _('Fri'),
        M: _('M'),
        W: _('W'),
        F: _('F'),
    };
    return Object.fromEntries(
        Object.entries(rows).map(([day, label]) => [day, labels[label] ?? label]));
};

const decoder = new TextDecoder();

// A single Soup session is shared by every github widget instance so that
// HTTP connections are pooled instead of torn down and rebuilt per render.
let sharedSession = null;

function getSession() {
    if (!sharedSession)
        sharedSession = new Soup.Session();
    return sharedSession;
}

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
    return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text};`;
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
    const isMiniLarge = sizeKey === 'minilarge';
    const isLarge = sizeKey === 'large';

    const [refW, refH] = sizeForWidget(widget);

    // The .widget style adds 16px padding on each side
    const contentW = refW - WIDGET_PADDING * 2 - 2;
    const contentH = refH - WIDGET_PADDING * 2 - 2;

    const layout = isMini
        ? {
            avatar: 20, username: 15, badge: 14, label: 11, entryWidth: 100,
            footer: 0, month: 0, spacing: 2, gap: 1, daysW: 20,
            footerFont: 0, dayRows: translateDayRows(DAY_LABEL_ROWS_MINI), maxWeeks: 32,
        }
        : isMiniLarge
            ? {
                avatar: 24, username: 14, badge: 14, label: 13, entryWidth: 120,
                footer: 0, month: 11, spacing: 4, gap: 2, daysW: 20,
                footerFont: 0, dayRows: translateDayRows(DAY_LABEL_ROWS), maxWeeks: 30,
            }
        : isLarge
            ? {
                // 2×2: same look as the 2×1 — 2px gaps between squares,
                // full-width grid, month names spread evenly and lifted.
                // Cells 14px with the 2px gap keep the grid height of the old
                // 15+1 pitch (7×16−2 = 110px), so the 5 stats chips still fit;
                // weeks = floor((361−30−7+2)/16) = 20.
                avatar: 34, username: 16, badge: 16, label: 13, entryWidth: 170,
                footer: 14, month: 15, spacing: 6, gap: 2, daysW: 30,
                footerFont: 16, dayRows: translateDayRows(DAY_LABEL_ROWS), maxWeeks: 48, cellMax: 14, monthLabels: 5,
                wholeMonths: false,
                monthLabelSpread: true,
                monthLabelInset: 15,
                monthLift: 2,
                // "Synced …" / Less–More lowered this many px (paint-only).
                footerDrop: 4,
            }
            : {
                // 2×1: exactly 6 whole months (see fitWholeMonths); the cell
                // size follows from the week count (≈10–11px), the height
                // allows up to 11px.
                avatar: 28, username: 14, badge: 12, label: 12, entryWidth: 150,
                footer: 12, month: 14, spacing: 3, gap: 2, daysW: 28,
                footerFont: 11, dayRows: translateDayRows(DAY_LABEL_ROWS), maxWeeks: 60, cellMax: 10, monthLabels: 6,
                // Full-width grid (as many weeks as fit), not cut to whole months.
                wholeMonths: false,
                // Month names raised this many px above the grid (paint-only,
                // the grid does not move).
                monthLift: 2,
                // Month names spread evenly over the whole grid width: equal
                // distance between their CENTERS, first near the left edge,
                // last near the right one. Unset = each name sits over the
                // middle of its own month (2×2).
                monthLabelSpread: true,
                // Inset (px) of the spread row from both grid edges: bigger =
                // names closer together. 0 → ~25px between names; 15 → ~20px.
                monthLabelInset: 15,
            };

    const avatarSize = layout.avatar;
    const cellGap = layout.gap;
    const dayLabelsWidth = layout.daysW;
    // Day-label gap: a clear 7px strip between the Mon/Wed/Fri column and
    // the first column of activity squares (the mini variants already sit
    // at 6). Put on both the month-labels row and the grid row, so the
    // month labels keep the canvas's exact coordinate space and stay
    // centered over the months they belong to.
    const dayLabelGap = isMini ? 6 : 7;

    const mainGaps = isMini ? layout.spacing : layout.spacing * 2;
    const matrixBudget = contentH - layout.avatar - layout.month - layout.footer - mainGaps - 1;
    const cellMax = layout.cellMax ?? (isLarge ? 20 : 16);
    const heightCellCap = Math.max(4, Math.min(cellMax, Math.floor((matrixBudget - 6 * cellGap) / 7)));
    const availGridW = contentW - dayLabelsWidth - (isMini ? 0 : dayLabelGap);
    // Default geometry (mini): as many weeks as fit at the largest cell.
    let cellSize = heightCellCap;
    let weeks = Math.max(6, Math.min(layout.maxWeeks, Math.floor((availGridW + cellGap) / (cellSize + cellGap))));
    // First day drawn (sizes with month labels start on the 1st of a month).
    let gridFirstDay = null;
    // Horizontal centering of the grid + month labels in their slot.
    let gridOffsetX = 0;

    const DAY_US = 86400 * 1e6;
    const dateOnly = dt => GLib.DateTime.new_local(dt.get_year(), dt.get_month(), dt.get_day_of_month(), 0, 0, 0);
    const sundayOf = dt => dt.add_days(-(dt.get_day_of_week() % 7));
    const daysBetween = (later, earlier) => Math.round(later.difference(earlier) / DAY_US);

    // Sizes with month labels show WHOLE months: the grid starts on the 1st
    // of the oldest month instead of mid-month. The old fixed 27 weeks began
    // with 2–3 unlabeled columns of a partial month, so the label row looked
    // shifted right. The cell size is then fitted to the week count.
    function fitWholeMonths(today) {
        if (!Number.isFinite(layout.monthLabels) || layout.wholeMonths === false)
            return;
        const months = layout.monthLabels;
        const endDate = dateOnly(today).add_days(6 - (today.get_day_of_week() % 7));
        const currentFirst = GLib.DateTime.new_local(today.get_year(), today.get_month(), 1, 0, 0, 0);
        const plan = back => {
            const first = currentFirst.add_months(-back);
            const neededWeeks = (daysBetween(endDate, sundayOf(first)) + 1) / 7;
            const fitted = Math.min(heightCellCap, Math.floor((availGridW + cellGap) / neededWeeks) - cellGap);
            return {first, neededWeeks, fitted};
        };
        // A just-started month is too narrow to host its label; then show
        // one more month so N months stay labeled. Label width estimate:
        // three bold glyphs ≈ 2.2em.
        const currentCols = (daysBetween(endDate, sundayOf(currentFirst)) + 1) / 7;
        let {first, neededWeeks, fitted} = plan(months - 1);
        if (currentCols * (fitted + cellGap) - cellGap < layout.month * 2.2)
            ({first, neededWeeks, fitted} = plan(months));
        if (fitted < 4)
            return; // cannot fit: keep the default geometry
        cellSize = fitted;
        weeks = neededWeeks;
        gridFirstDay = first;
        gridOffsetX = Math.max(0, Math.floor((availGridW - (weeks * (cellSize + cellGap) - cellGap)) / 2));
    }

    const dataFilePath = GLib.build_filenamev([getDataDir('github'), `github-${widget?.id}.json`]);

    const settingsUsername = (settings?.get_string('github-username') ?? '').trim().replace(/^@/, '');
    let username = settingsUsername;
    let avatarInitials = '?';
    const state = { timerId: null, editing: false, cancellable: new Gio.Cancellable() };
    const session = getSession();
    let latestByDate = new Map();
    let lastSyncTime = null;
    let currentStreak = 0;
    let longestStreak = 0;
    let todayCount = 0;
    let activeDaysCount = 0;
    let bestDayCount = 0;
    let bestDayLabel = '—';

    const setProfileUrl = valid => {
        const url = valid ? profileUrlFor(username) : null;

        if (url) {
            profileUrls.set(widget.id, url);
        } else {
            profileUrls.delete(widget.id);
        }
    };

    profileUrls.delete(widget.id);

    // A lowered footer reaches into the card's bottom padding, outside the
    // body: no body clip then (the widget wrapper still clips to the card).
    body.set_clip_to_allocation(!layout.footerDrop);

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

    const avatarInitialsLabel = new St.Label({
        text: '',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        style: `font-size: ${Math.max(6, Math.round(avatarSize * 0.4))}px; font-weight: 700; color: ${textColor};`,
    });

    const avatarWidget = new St.Bin({
        child: avatarInitialsLabel,
        style: `background-color: ${textRgba(0.15)}; border-radius: 999px; width: ${avatarSize}px; height: ${avatarSize}px;`,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: false,
    });


    const usernameLabel = new St.Label({
        text: _('Click to set username'),
        y_align: Clutter.ActorAlign.CENTER,
        style: `font-size: ${layout.username}px; font-weight: 700; color: ${textColor};`,
        reactive: true,
    });

    const usernameEntry = new St.Entry({
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
        // Same compact editor chrome as the todo task editor: translucent
        // band, tight paddings, left-flushed text (no fat entry frame).
        style: `font-size: ${layout.username}px; color: ${textColor}; `
            + `background-color: ${textRgba(0.07)}; border-radius: ${Math.round(layout.username * 0.7)}px; `
            + `padding: 3px 8px; width: ${layout.entryWidth}px;`,
    });
    usernameEntry.clutter_text.x_align = Clutter.ActorAlign.START;
    usernameEntry.hide();

    // Accent-名为 checkmark next to the entry (same idea as the accent-color
    // button in preferences): always visible while editing, click = commit.
    const usernameApplyButton = new St.Button({
        reactive: true,
        can_focus: false,
        y_align: Clutter.ActorAlign.CENTER,
        style: `border-radius: 999px; padding: 3px; background-color: ${textRgba(0.2)};`,
        child: new St.Icon({
            icon_name: 'object-select-symbolic',
            icon_size: Math.max(10, Math.round(layout.username * 0.95)),
            style: `color: ${textColor};`,
        }),
    });
    bindHoverShrink(usernameApplyButton);
    usernameApplyButton.hide();

    const headerSpacer = new St.Widget({ x_expand: true });

    const badgeLabel = new St.Label({
        text: '',
        y_align: Clutter.ActorAlign.CENTER,
        style: `font-size: ${layout.badge || 11}px; font-weight: 700; color: ${textColor};`,
    });

    // In mini the status lives in the header (no footer row)
    const statusLabel = new St.Label({
        text: isMini ? _('Set user') : _('Click username to configure'),
        y_align: Clutter.ActorAlign.CENTER,
        style: `font-size: ${isMini ? 10 : (isLarge ? 15 : 12)}px; font-weight: 700; color: ${textColor}; opacity: ${SECONDARY_OPACITY};`,
    });

    headerBox.add_child(avatarWidget);
    headerBox.add_child(usernameLabel);
    headerBox.add_child(usernameEntry);
    headerBox.add_child(usernameApplyButton);
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

    // Month labels container with same structure as matrixBody
    const monthLabelsContainer = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        x_align: Clutter.ActorAlign.FILL,
        x_expand: true,
        style: `spacing: ${dayLabelGap}px;`,
    });
    matrixBox.add_child(monthLabelsContainer);

    // Spacer for day labels width (to align months with grid)
    const monthLabelsSpacer = new St.Widget({
        x_expand: false,
        style: `width: ${dayLabelsWidth}px;`,
    });
    monthLabelsContainer.add_child(monthLabelsSpacer);

    // Month labels row (will be aligned with grid canvas)
    const monthLabelsRow = new St.Widget({ 
        x_align: Clutter.ActorAlign.START,
        x_expand: true,
    });
    monthLabelsContainer.add_child(monthLabelsRow);

    const matrixBody = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        x_align: Clutter.ActorAlign.FILL,
        x_expand: true,
        y_expand: isLarge ? false : true,
        style: `spacing: ${dayLabelGap}px;`,
    });
    matrixBox.add_child(matrixBody);

    const dayLabelsColumn = new St.Widget({
        x_expand: false,
        style: `width: ${dayLabelsWidth}px;`,
    });
    matrixBody.add_child(dayLabelsColumn);

    // x_align: START — cells are drawn from x = 0 inside the canvas, so the
    // canvas must not slide right by the leftover width (END did that): the
    // month label row then shares the exact same coordinate space, keeping
    // labels centered over the months they belong to.
    const gridCanvas = new St.DrawingArea({
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
        style: `background-color: ${theme.background};`,
    });
    matrixBody.add_child(gridCanvas);

    // --- STATS (for large size only) ---
    // statsBox stretches over the leftover height between the grid and the footer,
    // so chips split the space evenly — no gaps right above the footer.
    let statsBox = null;
    if (isLarge) {
        statsBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            style: `spacing: 5px; margin-top: 0px;`,
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
            text: _('Less'),
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${isLarge ? 15 : 12}px; font-weight: 700; color: ${textColor}; opacity: ${SECONDARY_OPACITY}; margin-right: 3px;`,
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
            text: _('More'),
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${isLarge ? 15 : 12}px; font-weight: 700; color: ${textColor}; opacity: ${SECONDARY_OPACITY}; margin-left: 3px;`,
        });
        legendBox.add_child(moreLabel);

        footerBox.add_child(legendBox);
        mainBox.add_child(footerBox);
        // Lowered into the card's bottom padding (paint-only).
        if (layout.footerDrop)
            footerBox.translation_y = layout.footerDrop;

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
            const c = cell.rgba;
            ctx.setSourceRGBA(c.r, c.g, c.b, c.a);
            traceRoundedRect(ctx, cell.x, cell.y, size, size, radius);
            ctx.fill();
        }
        ctx.$dispose();
    });

    function renderMonthLabels(startDate) {
        if (isMini) return;
        const pitch = cellSize + cellGap;
        monthLabelsRow.destroy_all_children();
        const monthBottomMargin = isMini ? 0 : 4;
        monthLabelsRow.style = `height: ${layout.month}px; margin-bottom: ${monthBottomMargin}px; margin-left: ${gridOffsetX}px;`;
        monthLabelsRow.translation_y = -(layout.monthLift ?? 0);

        // One coordinate space with the canvas: the drawn grid spans exactly
        // weeks * pitch - gap starting at row x = 0 (see gridCanvas above).
        const gridEndX = weeks * pitch - cellGap;

        // First and last grid column each month is visible in, so a label can
        // be centered over the month's own column block.
        // Walked by calendar day (add_days) rather than unix + n*86400, so a
        // DST switch inside the grid cannot shift a day into the wrong month.
        const spans = [];
        const daysInGrid = weeks * 7;
        let dt = startDate;
        for (let day = 0; day < daysInGrid; day++, dt = dt.add_days(1)) {
            if (gridFirstDay && dt.compare(gridFirstDay) < 0)
                continue; // not drawn (before the oldest whole month)
            const month = dt.get_month() - 1;
            const col = Math.floor(day / 7);

            const span = spans[spans.length - 1];
            if (span && span.month === month) {
                span.lastCol = col;
                span.colSum += col;
                span.days++;
            } else {
                spans.push({month, firstCol: col, lastCol: col, colSum: col, days: 1});
            }
        }

        const names = monthNames();
        const labelStyle = `font-size: ${layout.month}px; font-weight: 700; color: ${textColor}; opacity: ${SECONDARY_OPACITY};`;

        // First drop months that only sliver into the grid (their label
        // cannot sit over them), THEN keep the newest N. The old order
        // (trim to N first, skip slivers after) regularly lost a label when
        // the current month had just started: 2×1 showed 5 months instead
        // of 6 on roughly half of the days of a year.
        const placed = [];
        for (const span of spans) {
            const startX = span.firstCol * pitch;
            const endX = (span.lastCol + 1) * pitch - cellGap;

            const lbl = new St.Label({
                text: names[span.month],
                y_align: Clutter.ActorAlign.CENTER,
                style: labelStyle,
            });
            const [, labelWidth] = lbl.get_preferred_width(-1);

            if (endX - startX < labelWidth) {
                lbl.destroy();
                continue;
            }
            // Day-weighted center: the mean column of the month's own cells.
            // A month's edge columns are often partial (Aug 1 alone in a
            // Saturday cell), so the plain column-block center sat 3–6px off
            // the visual middle of the month's squares.
            const centerX = (span.colSum / span.days) * pitch + cellSize / 2;
            placed.push({lbl, startX, endX, labelWidth, centerX});
        }

        const limit = Number.isFinite(layout.monthLabels) ? layout.monthLabels : placed.length;
        for (const {lbl} of placed.splice(0, Math.max(0, placed.length - limit)))
            lbl.destroy();

        if (layout.monthLabelSpread) {
            // N names over the grid width: name i is centered at
            // (i + 0.5) / N of the grid. Real widths only exist once the
            // labels are laid out, so the row is re-placed whenever any of
            // them changes width.
            const n = placed.length;
            const placeRow = () => {
                placed.forEach(({lbl}, i) => {
                    const w = lbl.width;
                    const inset = Math.max(0, layout.monthLabelInset ?? 0);
                    const span = Math.max(1, gridEndX - inset * 2);
                    const center = inset + span * (i + 0.5) / n;
                    lbl.translation_x = Math.max(0, Math.min(gridEndX - w, Math.round(center - w / 2)));
                });
            };
            for (const {lbl} of placed) {
                monthLabelsRow.add_child(lbl);
                lbl.connect('notify::width', placeRow);
            }
            placeRow();
            return;
        }

        for (const {lbl, centerX} of placed) {
            // Centered over the month's visible column block, using the
            // label's REAL width: measured before it is on stage, the inline
            // font-size is not applied yet and the estimate is off.
            const place = () => {
                const w = lbl.width;
                lbl.translation_x = Math.max(0, Math.min(
                    gridEndX - w,
                    Math.round(centerX - w / 2)));
            };
            monthLabelsRow.add_child(lbl);
            place();
            lbl.connect('notify::width', place);
        }
    }

    function renderDayLabels() {
        dayLabelsColumn.destroy_all_children();
        dayLabelsColumn.style = `width: ${dayLabelsWidth}px; height: ${7 * (cellSize + cellGap) - cellGap}px;`;

        for (let row = 0; row < 7; row++) {
            if (!layout.dayRows[row]) continue;

            const lbl = new St.Label({
                text: layout.dayRows[row],
                style: `font-size: ${layout.label}px; font-weight: 800; color: ${textColor}; opacity: ${SECONDARY_OPACITY};`,
            });

            // Disable text ellipsize to show full day names
            const clutterText = lbl.get_clutter_text();
            if (clutterText) {
                clutterText.ellipsize = Pango.EllipsizeMode.NONE;
            }

            dayLabelsColumn.add_child(lbl);

            // Position each label at its natural size, centered on its row, so the
            // glyphs are never force-shrunk into the tiny row slot (no clipping).
            const [, natW] = lbl.get_preferred_width(-1);
            const [, natH] = lbl.get_preferred_height(-1);
            const x = dayLabelsWidth >= natW ? Math.round((dayLabelsWidth - natW) / 2) : 0;
            const y = row * (cellSize + cellGap) + (cellSize - natH) / 2;
            lbl.set_position(x, Math.round(y));
        }
    }

    // Parsed once per render: the repaint handler used to run
    // parseCssColor() for every cell (~190-340) on every repaint.
    const levelRgba = [emptyCellColor, ...levelColors.slice().reverse()].map(color => {
        const c = parseCssColor(color);
        return {r: c.r, g: c.g, b: c.b, a: c.a !== undefined ? c.a : 1};
    });

    // Cheap fingerprint of the contribution data. GitHub counts only ever
    // change by growing, so (active days, total) changes whenever the fetched
    // data differs — letting us skip rebuilding ~371 cells on identical polls.
    function contributionsSignature(byDate) {
        let sum = 0;
        let days = 0;
        for (const count of byDate.values()) {
            sum += count;
            if (count > 0) days++;
        }
        return `${days}:${sum}`;
    }

    function renderMatrix(contributionsByDate) {
        const byDate = contributionsByDate || latestByDate;
        // The grid is anchored to today, so it must be rebuilt when the date
        // rolls over even if the contribution counts are unchanged.
        const today = GLib.DateTime.new_now_local();
        const todayKey = today.format('%Y-%m-%d');
        fitWholeMonths(today);
        const dataKey = `${cellSize}|${cellGap}|${weeks}|${useGreen}|${contentW}|${todayKey}|${contributionsSignature(byDate)}`;
        if (dataKey === matrixGeometry.dataKey) return;

        renderDayLabels();

        const daysInGrid = weeks * 7;
        const gridEnd = today.add_days(6 - (today.get_day_of_week() % 7));
        const alignedStart = gridEnd.add_days(-(daysInGrid - 1));

        renderMonthLabels(alignedStart);

        const cells = [];
        for (let i = 0; i < daysInGrid; i++) {
            const date = alignedStart.add_days(i);
            if (date.compare(today) > 0) break;
            if (gridFirstDay && date.compare(gridFirstDay) < 0) continue;
            const dateKey = date.format('%Y-%m-%d');
            const col = Math.floor(i / 7);
            const row = date.get_day_of_week() % 7;
            const level = contributionLevel(byDate.get(dateKey) ?? 0);
            cells.push({
                x: col * (cellSize + cellGap),
                y: row * (cellSize + cellGap),
                rgba: levelRgba[level],
            });
        }

        matrixGeometry.size = cellSize;
        matrixGeometry.gap = cellGap;
        matrixGeometry.dataKey = dataKey;
        matrixGeometry.cells = cells;

        gridCanvas.style = `background-color: ${theme.background}; margin-left: ${gridOffsetX}px;`;
        gridCanvas.set_width(Math.max(1, weeks * (cellSize + cellGap) - cellGap));
        gridCanvas.set_height(Math.max(1, 7 * (cellSize + cellGap) - cellGap));
        gridCanvas.queue_repaint();
    }

    // --- STATS RENDERING (for large size only) ---
    function computeStats(byDate) {
        const today = GLib.DateTime.new_now_local();
        const todayKey = today.format('%Y-%m-%d');
        todayCount = byDate.get(todayKey) ?? 0;

        let longest = 0;
        let tempStreak = 0;
        let active = 0;

        // Compute streaks from today backwards
        const checkDate = GLib.DateTime.new_now_local();
        for (let i = 0; i < 365; i++) {
            const d = checkDate.add_days(-i);
            const key = d.format('%Y-%m-%d');
            const count = byDate.get(key) ?? 0;
            if (count > 0) {
                active++;
                tempStreak++;
                if (tempStreak > longest) longest = tempStreak;
            } else {
                tempStreak = 0;
            }
        }

        // Current streak, GitHub-style: a day without contributions YET
        // (today) does not break it — count back from yesterday then.
        let streak = 0;
        for (let i = (byDate.get(todayKey) ?? 0) > 0 ? 0 : 1; i < 365; i++) {
            if ((byDate.get(checkDate.add_days(-i).format('%Y-%m-%d')) ?? 0) <= 0)
                break;
            streak++;
        }

        // The most productive day among all days present in the GitHub data.
        let bestCount = 0;
        let bestKey = null;
        for (const [key, count] of byDate) {
            if (count > bestCount) {
                bestCount = count;
                bestKey = key;
            }
        }

        activeDaysCount = active;
        bestDayCount = bestCount;
        // 'YYYY-MM-DD' is parsed manually: GLib.DateTime.new_from_iso8601 +
        // format_utf8 is a GJS trap (format_utf8 does not exist and computeStats
        // crashed, leaving the stats block empty).
        if (bestKey) {
            const [, bM, bD] = bestKey.split('-').map(Number);
            bestDayLabel = `${String(bD).padStart(2, '0')} ${monthNames()[bM - 1] ?? ''}`;
        } else {
            bestDayLabel = '—';
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
            { icon: 'emoji-recent-symbolic', label: _('Today'), value: String(todayCount) },
            { icon: 'media-playlist-consecutive-symbolic', label: _('Current streak'), value: `${currentStreak}d` },
            { icon: 'starred-symbolic', label: _('Longest streak'), value: `${longestStreak}d` },
            { icon: 'view-grid-symbolic', label: _('Active days'), value: `${activeDaysCount}d / 365` },
            { icon: 'weather-clear-symbolic', label: _('Best day'), value: `${formatCount(bestDayCount)} · ${bestDayLabel}` },
        ];

        // Each metric is a full-width chip; the 5 chips share the 2×2 stats
        // budget left between the grid and the footer.
        for (const stat of statsData) {
            const chip = new St.BoxLayout({
                x_expand: true,
                y_expand: true,
                style: statBg + ` border-radius: 10px; padding: 3px 12px; spacing: 10px;`,
            });

            const icon = new St.Icon({
                icon_name: stat.icon,
                icon_size: 16,
                style: `color: ${accentHex};`,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const labelWidget = new St.Label({
                text: stat.label,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: 15px; font-weight: 700; color: ${textColor}; opacity: ${SECONDARY_OPACITY};`,
            });

            const valueWidget = new St.Label({
                text: stat.value,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: 15px; font-weight: 700; color: ${textColor};`,
            });

            chip.add_child(icon);
            chip.add_child(labelWidget);
            chip.add_child(valueWidget);
            statsBox.add_child(chip);
        }
    }

    // --- NETWORK ---
    function fetchContributions() {
        if (!username) return;
        setStatus(isMini ? '…' : _('Fetching…'));
        
        const url = `https://github.com/users/${encodeURIComponent(username)}/contributions`;
        const message = Soup.Message.new('GET', url);
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, state.cancellable, (s, res) => {
            if (isActorDestroyed(body) || mainBox.get_parent() !== body) return;
            try {
                const bytes = s.send_and_read_finish(res);
                if (message.get_status() !== HTTP_OK) throw new Error(`HTTP ${message.get_status()}`);
                
                const html = decoder.decode(bytes.get_data());
                
                const byDate = new Map();
                const tdRegex = /<td([^>]+)>/g;
                let match;
                const idToDate = new Map();
                while ((match = tdRegex.exec(html)) !== null) {
                    const attr = match[1];
                    const idM = attr.match(/id="([^"]+)"/);
                    const dateM = attr.match(/data-date="([^"]+)"/);
                    if (idM && dateM) {
                        idToDate.set(idM[1], dateM[1]);
                    }
                }

                const tooltipRegex = /<tool-tip([^>]+)>([^<]+)<\/tool-tip>/g;
                while ((match = tooltipRegex.exec(html)) !== null) {
                    const attr = match[1];
                    const text = match[2].trim();
                    const forM = attr.match(/for="([^"]+)"/);
                    if (!forM) continue;
                    
                    const countMatch = text.match(/^([\d,]+|No)\s+contribution/);
                    if (!countMatch) continue;
                    
                    const count = countMatch[1] === "No" ? 0 : parseInt(countMatch[1].replace(/,/g, ''), 10);
                    const dateStr = idToDate.get(forM[1]);
                    if (dateStr) {
                        byDate.set(dateStr, count);
                    }
                }

                if (byDate.size === 0) throw new Error('parse failed');

                const h2Regex = /<h2[^>]*js-contribution-activity-description[^>]*>\s*([\d,]+)\s+contributions/i;
                const h2Match = html.match(h2Regex);
                const sumAll = [...byDate.values()].reduce((a, b) => a + b, 0);
                const yearTotal = h2Match ? parseInt(h2Match[1].replace(/,/g, ''), 10) : sumAll;
                
                badgeLabel.text = _('%s commits').format(formatCount(yearTotal));
                lastSyncTime = GLib.DateTime.new_now_local();
                setStatus(isMini
                    ? lastSyncTime.format('%H:%M')
                    : _('Synced %s').format(lastSyncTime.format('%H:%M')));
                latestByDate = byDate;
                renderMatrix(byDate);
                setProfileUrl(true);

                saveJsonToFile(dataFilePath, {
                    username,
                    total: { "parsed": yearTotal },
                    contributions: [...byDate.entries()].map(([date, count]) => ({ date, count })),
                    lastSync: lastSyncTime.to_unix(),
                });

                if (isLarge) {
                    computeStats(byDate);
                    renderStats();
                }
            } catch (err) {
                const cancelled = err.matches && err.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
                if (!cancelled) {
                    const cached = latestByDate.size > 0;
                    setProfileUrl(cached);
                    // Show the error only when there is no cache
                    if (cached && lastSyncTime) {
                        setStatus(isMini
                            ? lastSyncTime.format('%H:%M')
                            : _('Synced %s').format(lastSyncTime.format('%H:%M')));
                    } else {
                        setStatus(isMini
                            ? (cached ? _('Cached') : _('Error'))
                            : (cached ? _('Offline — cached') : _('Error loading')));
                    }
                }
            }
        });
    }

    function loadAvatar() {
        if (!username) {
            avatarInitialsLabel.text = '?';
            avatarInitialsLabel.show();
            avatarWidget.set_style(`background-image: none; background-color: ${textRgba(0.15)}; border-radius: 999px; width: ${avatarSize}px; height: ${avatarSize}px;`);
            return;
        }

        const avatarPath = GLib.build_filenamev([getDataDir('github'), `avatar-${safeFileToken(username)}.png`]);
        const avatarFile = Gio.File.new_for_path(avatarPath);

        const applyAvatar = () => {
            avatarInitialsLabel.hide();
            const uri = avatarFile.get_uri();
            avatarWidget.set_style(`background-image: url("${uri}"); background-size: cover; border-radius: 999px; width: ${avatarSize}px; height: ${avatarSize}px;`);
        };

        let avatarFresh = false;
        if (avatarFile.query_exists(null)) {
            applyAvatar();
            try {
                const info = avatarFile.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
                const mtime = info.get_attribute_uint64('time::modified');
                avatarFresh = GLib.get_real_time() / 1e6 - mtime < AVATAR_MAX_AGE_SECONDS;
            } catch (_e) {}
        } else {
            avatarInitialsLabel.text = username.slice(0, 2).toUpperCase();
            avatarInitialsLabel.show();
            avatarWidget.set_style(`background-image: none; background-color: ${textRgba(0.15)}; border-radius: 999px; width: ${avatarSize}px; height: ${avatarSize}px;`);
        }

        // Every settings change / re-layout re-renders the widget; a cached
        // avatar younger than a day is good enough — skip the network.
        if (avatarFresh)
            return;

        const url = `https://github.com/${encodeURIComponent(username)}.png`;
        const message = Soup.Message.new('GET', url);
        session.send_and_read_async(message, GLib.PRIORITY_LOW, state.cancellable, (s, res) => {
            if (isActorDestroyed(body)) return;
            try {
                const bytes = s.send_and_read_finish(res);
                if (message.get_status() === HTTP_OK) {
                    avatarFile.replace_contents_bytes_async(
                        bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, state.cancellable,
                        (f, res2) => {
                            if (isActorDestroyed(body)) return;
                            try {
                                f.replace_contents_finish(res2);
                                applyAvatar();
                            } catch (err) {}
                        }
                    );
                }
            } catch (err) {
                // Ignore cancel errors
            }
        });
    }

    function updateHeader() {
        usernameLabel.text = username || _('Click to set username');
        loadAvatar();
    }

    // --- USERNAME EDITING ---
    const startEdit = () => {
        if (state.editing) return;
        state.editing = true;
        usernameEntry.text = username;
        usernameLabel.hide();
        usernameEntry.show();
        usernameApplyButton.show();
        global.stage.set_key_focus(usernameEntry);
    };

    const endEdit = (commit) => {
        if (!state.editing) return;
        state.editing = false;
        const submitted = usernameEntry.get_text().trim().replace(/^@/, '');
        usernameEntry.hide();
        usernameApplyButton.hide();

        usernameLabel._desktopWidgetsSelfClick = true;
        usernameEntry._desktopWidgetsSelfClick = true;

        usernameLabel.show();
        if (global.stage.get_key_focus() === usernameEntry)
            global.stage.set_key_focus(null);
        if (!commit || submitted === '' || submitted === username) return;

        // Update local state immediately: the header shows the name and the
        // matrix resets even before the settings-changed re-render lands
        // (this is what made the typed name appear to "not apply").
        username = submitted;
        updateHeader();
        setProfileUrl(false);
        latestByDate = new Map();
        badgeLabel.text = '';
        lastSyncTime = null;
        if (isLarge) {
            currentStreak = 0;
            longestStreak = 0;
            todayCount = 0;
            activeDaysCount = 0;
            bestDayCount = 0;
            bestDayLabel = '—';
        }

        if (settings) {
            settings.set_string('github-username', submitted);
            return;
        }

        renderMatrix(new Map());
        if (isLarge) renderStats();
        saveJsonToFile(dataFilePath, { username });
        fetchContributions();
    };

    usernameLabel.connect('button-press-event', (_actor, event) => {
        if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
        startEdit();
        return Clutter.EVENT_STOP;
    });

    usernameApplyButton.connect('clicked', () => {
        endEdit(true);
        return Clutter.EVENT_STOP;
    });

    // Plain-Enter commit: on GNOME 51 the Return key arrives as the
    // Clutter.Text 'activate' signal (journal-proofed: activate fired while
    // no key-press reached the text). The key-press fallback below stays for
    // KP_Enter/ISO_Enter variants; endEdit is re-entrant (guard on editing).
    usernameEntry.clutter_text.connect('activate', () => endEdit(true));

    usernameEntry.clutter_text.connect('key-press-event', (_actor, event) => {
        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { endEdit(true); return Clutter.EVENT_STOP; }
        if (sym === Clutter.KEY_Escape) { endEdit(false); return Clutter.EVENT_STOP; }
        return Clutter.EVENT_PROPAGATE;
    });
    // Clicking the checkmark moves stage focus off the entry BEFORE the
    // click lands, so don't treat that specific focus loss as cancel.
    usernameEntry.clutter_text.connect('key-focus-out', () => {
        if (global.stage.get_key_focus() === usernameApplyButton) return;
        endEdit(false);
    });

    // --- REFRESH TIMER ---
    state.timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_INTERVAL, () => {
        if (isActorDestroyed(body) || mainBox.get_parent() !== body) return GLib.SOURCE_REMOVE;
        fetchContributions();
        return GLib.SOURCE_CONTINUE;
    });

    // --- CLEANUP ---
    body.connect('destroy', () => {
        profileUrls.delete(widget.id);
        state.cancellable.cancel();
        if (state.timerId) { GLib.source_remove(state.timerId); state.timerId = null; }
        if (global.stage.get_key_focus() === usernameEntry)
            global.stage.set_key_focus(null);
    });

    // --- CACHED CONTRIBUTIONS ---
    const loadContributionsCache = (data) => {
        if (!data || !Array.isArray(data.contributions) || data.username !== username)
            return;
        const cached = new Map();
        data.contributions.forEach(d => {
            if (d && typeof d.date === 'string')
                cached.set(d.date, Number(d.count) || 0);
        });
        if (cached.size === 0)
            return;
        latestByDate = cached;
        renderMatrix(cached);
        setProfileUrl(true);

        const yearKeys = Object.keys(data.total || {});
        const latestYear = yearKeys.length ? yearKeys[yearKeys.length - 1] : null;
        const sumAll = [...cached.values()].reduce((a, b) => a + b, 0);
        const yearTotal = latestYear !== null ? (data.total[latestYear] ?? sumAll) : sumAll;
        badgeLabel.text = _('%s commits').format(formatCount(yearTotal));
        
        // Restore lastSyncTime from the cache when available
        if (data.lastSync) {
            lastSyncTime = GLib.DateTime.new_from_unix_local(data.lastSync);
            setStatus(isMini
                ? lastSyncTime.format('%H:%M')
                : _('Synced %s').format(lastSyncTime.format('%H:%M')));
        } else {
            lastSyncTime = null;
            setStatus(isMini ? _('Cached') : _('Offline — cached'));
        }

        if (isLarge) {
            computeStats(cached);
            renderStats();
        }
    };

    // --- INIT ---
    renderMatrix();
    updateHeader();

    loadJsonFromFileAsync(dataFilePath, (savedData, loadError) => {
        if (isActorDestroyed(body) || mainBox.get_parent() !== body) return;

        if (!settingsUsername && savedData && typeof savedData.username === 'string') {
            username = savedData.username;
            updateHeader();
        }

        if (username) {
            loadContributionsCache(savedData);
            fetchContributions();
        } else if (!loadError) {
            saveJsonToFile(dataFilePath, { username });
        }
    });
}