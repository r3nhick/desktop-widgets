/*
 * Folder Launcher widget
 * Similar to App Launcher but opens folders instead of applications
 * The grid fills the fixed widget size; rows/columns are chosen to keep icons as large as possible.
 */

import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { cssColorToRgba, loadJsonFromFileAsync, getDataDir } from '../../utils/ported.js';

export const type = 'folder';
export const label = 'Folder Launcher';
export const defaultSize = 'medium';
export const supportedSizes = ['mini', 'minilarge', 'medium', 'large'];

const MAX_FOLDERS = 16;
const DEFAULT_FOLDER_ICON = 'folder-symbolic';
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

function defaultFolders() {
	return [
		{ path: GLib.get_home_dir(), name: _('Home') },
		{ path: GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS), name: _('Documents') },
		{ path: GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD), name: _('Downloads') },
		{ path: GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES), name: _('Pictures') },
	];
}

function gridContentSize(widgetWidth, widgetHeight) {
	return {
		width: Math.max(1, widgetWidth - (OUTER_MARGIN * 2)),
		height: Math.max(1, widgetHeight - (OUTER_MARGIN * 2)),
	};
}

function computeGridLayout(folderCount, widgetWidth, widgetHeight, showNames = false) {
	if (folderCount <= 0) {
		return { cols: 1, rows: 1 };
	}

	const content = gridContentSize(widgetWidth, widgetHeight);
	// Reserve space for folder names if they are shown (approximately 20-24px per label)
	const effectiveHeight = showNames ? content.height - 24 : content.height;
	let best = null;

	for (let cols = 1; cols <= folderCount; cols++) {
		const rows = Math.ceil(folderCount / cols);
		const cellWidth = (content.width - (GRID_GAP * (cols - 1))) / cols;
		const cellHeight = (effectiveHeight - (GRID_GAP * (rows - 1))) / rows;
		const minCell = Math.min(cellWidth, cellHeight);
		const empty = (cols * rows) - folderCount;

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

function maxFoldersFor(sizeKey) {
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

function computeIconMetrics(cols, rows, widgetWidth, widgetHeight, showNames = false) {
	const content = gridContentSize(widgetWidth, widgetHeight);
	// Reserve space for folder names if they are shown
	const effectiveHeight = showNames ? content.height - 24 : content.height;

	const cellWidth = (content.width - (GRID_GAP * (cols - 1))) / cols;
	const cellHeight = (effectiveHeight - (GRID_GAP * (rows - 1))) / rows;
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
	return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text};`;
}

export function render({ body, widget, theme, sizeForWidget, settings }) {
	const textColor = theme.text;
	const tileBaseBg = 'transparent'; // No background when not hovered
	const tileHoverBg = cssColorToRgba(textColor, TILE_HOVER_ALPHA);
	
	const sizeKey = widget?.size ?? 'medium';
	const [width, height] = sizeForWidget(widget);
	
	// Ensure body clips overflow content
	body.set_clip_to_allocation(true);
	
	const dataFilePath = GLib.build_filenamev([getDataDir('folder'), `folder-${widget?.id}.json`]);
	
	let folders = defaultFolders();
	let foldersLoaded = false;

	const container = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		y_align: Clutter.ActorAlign.FILL,
		style: `padding: ${OUTER_MARGIN}px;`,
		clip_to_allocation: true,
	});
	
	body.add_child(container);

	const grid = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		y_align: Clutter.ActorAlign.FILL,
		style: `spacing: ${GRID_GAP}px;`,
		clip_to_allocation: true,
	});

	container.add_child(grid);

	const openFolder = (folderPath, displayName) => {
		if (destroyed) return;

		try {
			const file = Gio.File.new_for_path(folderPath);
			
			// Check if folder exists
			if (!file.query_exists(null)) {
				Main.notify(_('Folder Launcher'), _('Folder does not exist: %s').format(displayName));
				return;
			}

			// Try to launch with configured file manager (read from settings each time)
			const fileManager = settings?.get_string('folder-file-manager') ?? 'org.gnome.Nautilus.desktop';
			const appInfo = Gio.DesktopAppInfo.new(fileManager);
			if (appInfo) {
				appInfo.launch([file], null);
				return;
			}

			// Fallback to default handler
			Gio.AppInfo.launch_default_for_uri(file.get_uri(), null);
		} catch (e) {
			console.debug(`Failed to open folder ${folderPath}:`, e);
			Main.notify(_('Folder Launcher'), _('Could not open %s').format(displayName));
		}
	};

	let sizeWatch = null;
	let settleTimer = null;
	let destroyed = false;

	const buildGrid = () => {
		// Read current settings values
		const showFolderNames = settings?.get_boolean('folder-show-names') ?? true;
		
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
		
		if (folders.length === 0) {
			const emptyLabel = new St.Label({
				text: _('No folders configured'),
				x_align: Clutter.ActorAlign.CENTER,
				y_align: Clutter.ActorAlign.CENTER,
				x_expand: true,
				y_expand: true,
				style: `color: ${textColor}; opacity: 0.55; font-size: 14px;`,
			});
			grid.add_child(emptyLabel);
			return;
		}

		const maxFolders = maxFoldersFor(sizeKey);
		const displayFolders = folders.slice(0, Math.min(maxFolders, MAX_FOLDERS));
		const { cols, rows } = computeGridLayout(displayFolders.length, width, height, showFolderNames);

		const cells = [];

		const updateCell = (cell, padding, iconSize) => {
			cell.padding = padding;
			cell.button.set_style(buildTileStyle(cell.hovered ? tileHoverBg : tileBaseBg, padding));
			cell.icon.set_icon_size(iconSize);
			
			// Update label font size if showing names
			if (cell.label && showFolderNames) {
				const fontSize = Math.max(8, Math.min(14, Math.round(iconSize * 0.25)));
				cell.label.set_style(`color: ${textColor}; font-size: ${fontSize}px; margin-top: 4px;`);
			}
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
				const folderIndex = rowIndex * cols + colIndex;
				if (folderIndex >= displayFolders.length) break;

				const folder = displayFolders[folderIndex];
				const displayName = (folder.name && folder.name.trim() !== '') ? folder.name : GLib.path_get_basename(folder.path);

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

				const folderIcon = new St.Icon({
					icon_size: MIN_ICON_SIZE,
					style: `color: ${textColor};`,
					x_align: Clutter.ActorAlign.CENTER,
				});

				// Get folder icon from file system
				try {
					const file = Gio.File.new_for_path(folder.path);
					const fileInfo = file.query_info('standard::icon', Gio.FileQueryInfoFlags.NONE, null);
					const gicon = fileInfo.get_icon();
					if (gicon) {
						folderIcon.gicon = gicon;
					} else {
						folderIcon.icon_name = DEFAULT_FOLDER_ICON;
					}
				} catch (e) {
					folderIcon.icon_name = DEFAULT_FOLDER_ICON;
				}

				cellBox.add_child(folderIcon);
				
				// Add folder name label if enabled
				let folderLabel = null;
				if (showFolderNames) {
					folderLabel = new St.Label({
						text: displayName,
						x_align: Clutter.ActorAlign.CENTER,
						style: `color: ${textColor}; font-size: 10px; margin-top: 4px;`,
					});
					folderLabel.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
					folderLabel.clutter_text.line_wrap = false;
					cellBox.add_child(folderLabel);
				}

				button.set_child(cellBox);
				rowBox.add_child(button);

				const cell = { 
					icon: folderIcon, 
					label: folderLabel,
					button, 
					padding: TILE_PADDING_MIN, 
					hovered: false, 
					pressX: 0, 
					pressY: 0, 
					mousePressed: false 
				};

				button.connect('enter-event', () => {
					cell.hovered = true;
					button.set_style(buildTileStyle(tileHoverBg, cell.padding));
					return Clutter.EVENT_PROPAGATE;
				});
				button.connect('leave-event', () => {
					cell.hovered = false;
					cell.mousePressed = false;
					button.set_style(buildTileStyle(tileBaseBg, cell.padding));
					return Clutter.EVENT_PROPAGATE;
				});

				button.connect('button-press-event', (_actor, event) => {
					if (event.get_button() !== 1)
						return Clutter.EVENT_PROPAGATE;
					cell.mousePressed = true;
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
						openFolder(folder.path, displayName);
					}
					cell.mousePressed = false;
					return Clutter.EVENT_STOP;
				});

				button.connect('clicked', () => {
					if (cell.mousePressed)
						return;
					openFolder(folder.path, displayName);
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
			const { padding, iconSize } = computeIconMetrics(cols, rows, currentWidth, currentHeight, showFolderNames);

			for (const cell of cells) {
				updateCell(cell, padding, iconSize);
			}
		};

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

	let reloadTimer = null;
	const reload = () => {
		if (destroyed || reloadTimer) return;
		reloadTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
			reloadTimer = null;
			loadJsonFromFileAsync(dataFilePath, (loaded) => {
				if (destroyed) return;
				if (loaded && Array.isArray(loaded.folders)) {
					folders = loaded.folders;
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
		console.debug('Failed to watch folder launcher data file:', e);
	}

	// Watch for settings changes
	let settingsSignals = [];
	if (settings) {
		settingsSignals.push(
			settings.connect('changed::folder-show-names', () => {
				if (destroyed) return;
				buildGrid();
			})
		);
		settingsSignals.push(
			settings.connect('changed::folder-file-manager', () => {
				// File manager change doesn't need rebuild, just affects click behavior
			})
		);
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

		// Disconnect settings signals
		if (settings) {
			for (const signalId of settingsSignals) {
				try {
					settings.disconnect(signalId);
				} catch (e) {
					// Ignore disconnect errors
				}
			}
		}
		settingsSignals = [];
	});

	reload();
}
