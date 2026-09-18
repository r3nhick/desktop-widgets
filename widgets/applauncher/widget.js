/*
 * App Launcher widget
 * Adapted for desktop-widgets@r3nhick rendering system
 * The grid fills the fixed widget size; rows/columns are chosen to keep icons as large as possible.
 */

import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { cssColorToRgba, loadJsonFromFileAsync, getDataDir } from '../../utils/ported.js';

export const type = 'applauncher';
export const label = 'App Launcher';
export const defaultSize = 'medium';
export const supportedSizes = ['mini', 'minilarge', 'medium', 'large'];

const MAX_APPS = 16;
const DEFAULT_APP_ICON = 'application-x-executable-symbolic';
const DRAG_THRESHOLD_PIXELS = 10;
const OUTER_MARGIN = 12;
const GRID_GAP = 8;
const TILE_RADIUS = 14;
const TILE_BASE_ALPHA = 0.07;
const TILE_HOVER_ALPHA = 0.13;
const BORDER_ALPHA = 0.14;
const TILE_PADDING_RATIO = 0.07;
const TILE_PADDING_MIN = 3;
const TILE_PADDING_MAX = 12;

const ICON_SIZE_RATIO = 0.85;
const MIN_ICON_SIZE = 12;
const MAX_ICON_SIZE = 200;

const DEFAULT_APPS = [
    { id: 'org.gnome.Nautilus.desktop', name: 'Files' },
    { id: 'org.gnome.Terminal.desktop', name: 'Terminal' },
    { id: 'firefox.desktop', name: 'Firefox' },
    { id: 'org.gnome.Settings.desktop', name: 'Settings' },
];

function resolveDesktopAppInfo(appKey) {
    try {
        return Gio.DesktopAppInfo.new(appKey);
    } catch (e) {
        return null;
    }
}

function gridContentSize(widgetWidth, widgetHeight) {
    return {
        width: Math.max(1, widgetWidth - (OUTER_MARGIN * 2)),
        height: Math.max(1, widgetHeight - (OUTER_MARGIN * 2)),
    };
}

// Pick the rows/columns that best fill the widget's proportions: of every
// arrangement that fits appCount items, keep the one whose smallest cell is
// largest (so icons stay as big as the fixed widget size allows).
function computeGridLayout(appCount, widgetWidth, widgetHeight) {
    if (appCount <= 0) {
        return { cols: 1, rows: 1 };
    }

    const content = gridContentSize(widgetWidth, widgetHeight);
    let best = null;

    for (let cols = 1; cols <= appCount; cols++) {
        const rows = Math.ceil(appCount / cols);
        const cellWidth = (content.width - (GRID_GAP * (cols - 1))) / cols;
        const cellHeight = (content.height - (GRID_GAP * (rows - 1))) / rows;
        const minCell = Math.min(cellWidth, cellHeight);
        const empty = (cols * rows) - appCount;

        const better = !best
            || minCell > best.minCell + 0.5
            || (Math.abs(minCell - best.minCell) <= 0.5 && empty < best.empty)
            || (Math.abs(minCell - best.minCell) <= 0.5 && empty === best.empty && rows < best.rows);

        if (better) {
            best = { cols, rows, minCell, empty };
        }
    }

    return { cols: best.cols, rows: best.rows };
}

function maxAppsFor(sizeKey) {
    switch (sizeKey) {
        case 'mini':
            return 4;
        case 'minilarge':
            return 6;
        case 'medium':
            return 8;
        case 'large':
            return 12;
        default:
            return 12;
    }
}

function computeIconMetrics(cols, rows, widgetWidth, widgetHeight) {
    const content = gridContentSize(widgetWidth, widgetHeight);

    const cellWidth = (content.width - (GRID_GAP * (cols - 1))) / cols;
    const cellHeight = (content.height - (GRID_GAP * (rows - 1))) / rows;
    const minCell = Math.max(MIN_ICON_SIZE, Math.min(cellWidth, cellHeight));

    const padding = Math.min(TILE_PADDING_MAX, Math.max(TILE_PADDING_MIN, Math.round(minCell * TILE_PADDING_RATIO)));
    const available = Math.max(MIN_ICON_SIZE, minCell - (padding * 2));

    const iconSize = Math.min(MAX_ICON_SIZE, Math.max(MIN_ICON_SIZE, Math.round(available * ICON_SIZE_RATIO)));

    return { padding, iconSize };
}

function buildTileStyle(tileRgba, padding) {
    return `background-color: ${tileRgba}; border-radius: ${TILE_RADIUS}px; padding: ${padding}px;`;
}

export function style(theme) {
    const textRgba = (a) => cssColorToRgba(theme.text, a);
    return `background-color: ${theme.background}; border-color: ${textRgba(BORDER_ALPHA)}; color: ${theme.text};`;
}

export function render({ body, widget, theme, sizeForWidget }) {
    const textColor = theme.text;
    const tileBaseBg = cssColorToRgba(textColor, TILE_BASE_ALPHA);
    const tileHoverBg = cssColorToRgba(textColor, TILE_HOVER_ALPHA);
    
    const sizeKey = widget?.size ?? 'medium';
    const [width, height] = sizeForWidget ? sizeForWidget(widget) : [394, 190];
    
    const dataFilePath = GLib.build_filenamev([getDataDir('applauncher'), `applauncher-${widget?.id}.json`]);
    
    let apps = DEFAULT_APPS.map(a => ({ ...a }));
    let appsLoaded = false;

    const container = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.FILL,
        style: `padding: ${OUTER_MARGIN}px;`,
    });
    
    body.add_child(container);

    const grid = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.FILL,
        style: `spacing: ${GRID_GAP}px;`,
    });

    container.add_child(grid);

    const launchApp = (appInfo, app, displayName) => {
        if (destroyed) return;

        if (appInfo) {
            try {
                appInfo.launch([], null);
                return;
            } catch (e) {
                console.debug(`Failed to launch ${app.id}:`, e);
            }
        }

        Main.notify(_('App Launcher'), _('Could not launch %s').format(displayName));
    };

    let sizeWatch = null;
    let settleTimer = null;
    let destroyed = false;

    const buildGrid = () => {
        if (settleTimer) {
            GLib.source_remove(settleTimer);
            settleTimer = null;
        }

        if (sizeWatch) {
            try {
                body.disconnect(sizeWatch.width);
                body.disconnect(sizeWatch.height);
            } catch (e) {
                // Ignore disconnect errors (body already gone)
            }
            sizeWatch = null;
        }

        grid.destroy_all_children();
        
        if (apps.length === 0) {
            const emptyLabel = new St.Label({
                text: _('No apps configured'),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_expand: true,
                style: `color: ${textColor}; opacity: 0.55; font-size: 14px;`,
            });
            grid.add_child(emptyLabel);
            return;
        }

        const maxApps = maxAppsFor(sizeKey);
        const displayApps = apps.slice(0, Math.min(maxApps, MAX_APPS));
        const { cols, rows } = computeGridLayout(displayApps.length, width, height);

        const cells = [];

        const updateCell = (cell, padding, iconSize) => {
            cell.padding = padding;
            cell.button.set_style(buildTileStyle(cell.hovered ? tileHoverBg : tileBaseBg, padding));
            cell.icon.set_icon_size(iconSize);
        };

        for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
            const rowBox = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.FILL,
                style: `spacing: ${GRID_GAP}px;`,
            });
            grid.add_child(rowBox);

            for (let colIndex = 0; colIndex < cols; colIndex++) {
                const appIndex = rowIndex * cols + colIndex;
                if (appIndex >= displayApps.length) break;

                const app = displayApps[appIndex];
                const appInfo = resolveDesktopAppInfo(app.id);
                const displayName = (app.name && app.name.trim() !== '') ? app.name : app.id.replace(/\.desktop$/i, '');

                const button = new St.Button({
                    reactive: true,
                    can_focus: true,
                    x_expand: true,
                    y_expand: true,
                    style: buildTileStyle(tileBaseBg, TILE_PADDING_MIN),
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });

                const cellBox = new St.BoxLayout({
                    orientation: Clutter.Orientation.VERTICAL,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });

                const appIcon = new St.Icon({
                    icon_name: DEFAULT_APP_ICON,
                    icon_size: MIN_ICON_SIZE,
                    style: `color: ${textColor};`,
                    x_align: Clutter.ActorAlign.CENTER,
                });

                const gicon = appInfo ? appInfo.get_icon() : null;
                if (gicon) {
                    appIcon.gicon = gicon;
                }

                cellBox.add_child(appIcon);
                button.set_child(cellBox);
                rowBox.add_child(button);

                const cell = { icon: appIcon, button, padding: TILE_PADDING_MIN, hovered: false, pressX: 0, pressY: 0 };

                button.connect('enter-event', () => {
                    cell.hovered = true;
                    button.set_style(buildTileStyle(tileHoverBg, cell.padding));
                    return Clutter.EVENT_PROPAGATE;
                });
                button.connect('leave-event', () => {
                    cell.hovered = false;
                    button.set_style(buildTileStyle(tileBaseBg, cell.padding));
                    return Clutter.EVENT_PROPAGATE;
                });

                button.connect('button-press-event', (_actor, event) => {
                    if (event.get_button() !== 1)
                        return Clutter.EVENT_PROPAGATE;
                    const [x, y] = event.get_coords();
                    cell.pressX = x;
                    cell.pressY = y;
                    return Clutter.EVENT_STOP;
                });

                button.connect('button-release-event', (_actor, event) => {
                    if (event.get_button() !== 1)
                        return Clutter.EVENT_PROPAGATE;

                    const [releaseX, releaseY] = event.get_coords();
                    const isClickNotDrag = Math.abs(releaseX - cell.pressX) < DRAG_THRESHOLD_PIXELS
                        && Math.abs(releaseY - cell.pressY) < DRAG_THRESHOLD_PIXELS;

                    if (isClickNotDrag) {
                        launchApp(appInfo, app, displayName);
                    }
                    return Clutter.EVENT_STOP;
                });

                cells.push(cell);
            }
        }

        let measuredWidth = 0;
        let measuredHeight = 0;

        const applyScale = () => {
            if (destroyed) return;
            const currentWidth = body.width || width || 240;
            const currentHeight = body.height || height || 180;
            measuredWidth = body.width || 0;
            measuredHeight = body.height || 0;
            const { padding, iconSize } = computeIconMetrics(cols, rows, currentWidth, currentHeight);

            for (const cell of cells) {
                updateCell(cell, padding, iconSize);
            }
        };

        // Watch allocation changes on the body (fast path). During edit-mode
        // resize/move the body passes through small transient sizes and the
        // final size change is not guaranteed to arrive as a notify, so a light
        // poll re-applies the metrics until the size settles.
        sizeWatch = {
            width: body.connect('notify::width', applyScale),
            height: body.connect('notify::height', applyScale),
        };

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            applyScale();
            return GLib.SOURCE_REMOVE;
        });

        settleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            if (destroyed) {
                settleTimer = null;
                return GLib.SOURCE_REMOVE;
            }

            const rawWidth = body.width || 0;
            const rawHeight = body.height || 0;

            if (rawWidth > 0 && rawHeight > 0 && (rawWidth !== measuredWidth || rawHeight !== measuredHeight)) {
                applyScale();
            }

            return destroyed ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
        });
    };

    // Reload the grid whenever the data file changes (e.g. edit in preferences)
    let reloadTimer = null;
    const reload = () => {
        if (destroyed || reloadTimer) return;
        reloadTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            reloadTimer = null;
            loadJsonFromFileAsync(dataFilePath, (loaded) => {
                if (destroyed) return;
                if (loaded && Array.isArray(loaded.apps)) {
                    apps = loaded.apps;
                }
                buildGrid();
            });
            return GLib.SOURCE_REMOVE;
        });
    };

    let fileMonitor = null;
    try {
        const dataFile = Gio.File.new_for_path(dataFilePath);
        fileMonitor = dataFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
        fileMonitor.connect('changed', (_monitor, _file, _otherFile, eventType) => {
            if (destroyed) return;
            if (eventType !== Gio.FileMonitorEvent.CHANGED
                && eventType !== Gio.FileMonitorEvent.CHANGES_DONE_HINT
                && eventType !== Gio.FileMonitorEvent.CREATED
                && eventType !== Gio.FileMonitorEvent.DELETED
                && eventType !== Gio.FileMonitorEvent.RENAMED
                && eventType !== Gio.FileMonitorEvent.MOVED) {
                return;
            }
            reload();
        });
    } catch (e) {
        console.debug('Failed to watch app launcher data file:', e);
    }

    container.connect('destroy', () => {
        destroyed = true;

        if (settleTimer) {
            GLib.source_remove(settleTimer);
            settleTimer = null;
        }

        if (sizeWatch) {
            try {
                body.disconnect(sizeWatch.width);
                body.disconnect(sizeWatch.height);
            } catch (e) {
                // Ignore disconnect errors (body already gone)
            }
            sizeWatch = null;
        }

        if (reloadTimer) {
            GLib.source_remove(reloadTimer);
            reloadTimer = null;
        }

        if (fileMonitor) {
            try {
                fileMonitor.cancel();
            } catch (e) {
                // Ignore cancel errors
            }
            fileMonitor = null;
        }
    });

    reload();
}
