import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

/**
 * Desktop Widgets — entry point for GNOME Shell.
 *
 * Layout of this file (top → bottom):
 *   1. Grid math (cell sizes, sizeForWidget)         — how sizes map to cells
 *   2. WIDGET_MODULES registry                       — every widget in one list
 *   3. WidgetController                              — layer, drag & snap,
 *      edit mode, settings sync; knows nothing about widget internals
 *   4. DesktopWidgetsExtension                       — lifecycle (enable/disable)
 *
 * Widgets themselves live in widgets/<type>/widget.js and are self-contained:
 * each exports type, label, defaultSize, supportedSizes, style(theme) and
 * render({body, ...}). Add new widgets by creating the module and registering
 * it in WIDGET_MODULES (and in prefs.js WIDGET_TYPES).
 */

import * as AppLauncherWidget from './widgets/applauncher/widget.js';
import * as BatteryWidget from './widgets/battery/widget.js';
import * as BinaryClockWidget from './widgets/binaryclock/widget.js';
import * as CalendarWidget from './widgets/calendar/widget.js';
import * as ClockWidget from './widgets/clock/widget.js';
import * as DigitalClockWidget from './widgets/digitalclock/widget.js';
import * as MusicWidget from './widgets/music/widget.js';
import * as PhotosWidget from './widgets/photos/widget.js';
import * as WeatherWidget from './widgets/weather/widget.js';
import * as TodoWidget from './widgets/todo/widget.js';
import * as GithubWidget from './widgets/github/widget.js';
import * as ScreenTimeWidget from './widgets/screentime/widget.js';import * as SystemWidget from './widgets/system/widget.js';
import * as NotesWidget from './widgets/notes/widget.js';
import * as PomodoroWidget from './widgets/pomodoro/widget.js';
import * as LavaWidget from './widgets/lava/widget.js';
import * as StopwatchWidget from './widgets/stopwatch/widget.js';
import * as FolderWidget from './widgets/folder/widget.js';
import * as TimerWidget from './widgets/timer/widget.js';
import { configureLogger, resetLogger, warn } from './logger.js';
import { assetPath } from './paths.js';
import { LiquidGlass } from './lib/glass.js';
import { UpdateChecker } from './lib/updates.js';
import { createHoldWatch, BUTTON1_MASK } from './lib/pager.js';
// (The screen-time engine runs inside the screentime widget; extension.js no
// longer pauses it on fullscreen — fullscreen is real screen time.)
import { clamp } from './utils.js';
import { boxLayoutProps } from './utils/gnomeCompat.js';
import { WorkspaceIntegration } from './workspaceIntegration.js';
import { LAYOUT_KEY, LAYOUT_VERSION, layoutJson } from './layoutDoc.js';
import { macColors } from './lib/colors.js';
import { isActorDestroyed, parseCssColor } from './utils/ported.js';
// Widget-in-widget stack plumbing (vertical pages under a primary widget).
import { attachWidgetStack, makeStackEntry } from './widgets/widgetStack.js';
import { WIDGET_TYPE_LABELS, GALLERY_HINTS, MAX_STACK_PAGES as STACK_PAGE_LIMIT } from './lib/widgetTypes.js';

const EXTENSION_PATH = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const GRID_SIZE = 20;
const WIDGET_GAP = 15;
const SNAP_DISTANCE = 12;
// Alignment guides while dragging: edges (or centers) within this distance
// of another widget's edge (center) snap to it and show a thin white line.
const ALIGN_SNAP_PX = 6;
const ALIGN_GUIDE_OVERHANG = 6;
const ALIGN_GUIDE_FADE_MS = 110;
const CELL_SIZE = 190;
const MINI_CELL_SIZE = 120;
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';
const EDIT_MODE_BINDING_KEY = 'edit-mode-binding';

const WIDGET_MODULES = [
  AppLauncherWidget,
  ClockWidget,
  DigitalClockWidget,
  BinaryClockWidget,
  CalendarWidget,
  WeatherWidget,
  PhotosWidget,
  BatteryWidget,
  MusicWidget,
  TodoWidget,
  GithubWidget,
  ScreenTimeWidget,
  SystemWidget,
  NotesWidget,
  PomodoroWidget,
  LavaWidget,
  StopwatchWidget,
  FolderWidget,
  TimerWidget,
];
const WIDGETS = new Map(WIDGET_MODULES.map(widgetModule => [widgetModule.type, widgetModule]));
// Widget type → prefs sidebar page id (derived from the page title in
// prefs.js: 'Calendar Widget' → 'calendar-widget'). Widgets without their
// own settings page fall back to the Appearance page.
const WIDGET_PREFS_PAGES = new Map([
  ['applauncher', 'app-launcher-widget'],
  ['battery', 'battery-widget'],
  ['binaryclock', 'binary-clock-widget'],
  ['calendar', 'calendar-widget'],
  ['clock', 'analog-clock-widget'],
  ['digitalclock', 'digital-clock-widget'],
  ['folder', 'folder-launcher-widget'],
  ['github', 'github-widget'],
  ['lava', 'lava-lamp-widget'],
  ['music', 'music-widget'],
  ['notes', 'notes-widget'],
  ['photos', 'photos-widget'],
  ['pomodoro', 'pomodoro-widget'],
  ['screentime', 'screen-time-widget'],
  ['system', 'system-monitor-widget'],
  ['weather', 'weather-widget'],
]);

const DEFAULT_WIDGETS = WIDGET_MODULES.map(widgetModule => ({
  id: `${widgetModule.type}-default`,
  type: widgetModule.type,
  size: widgetModule.defaultSize,
}));
const WIDGET_APP_IDS = Object.fromEntries(WIDGET_MODULES
  .filter(widgetModule => widgetModule.appIds)
  .map(widgetModule => [widgetModule.type, widgetModule.appIds]));
const WIDGET_CUSTOM_APP_KEYS = Object.fromEntries(WIDGET_MODULES
  .filter(widgetModule => widgetModule.customAppKey)
  .map(widgetModule => [widgetModule.type, widgetModule.customAppKey]));
const WIDGET_CLICK_TYPES = new Set([
  ...Object.keys(WIDGET_APP_IDS),
  'github',
]);
// Widget grid: [columns, rows, family]. Single source of truth for size shape.
// An n-cell widget is n * base + (n - 1) * gap wide, so a 2x1 sits flush
// against two 1x1 with one gap between them, not wider than them.
const MAIN_FAMILY = 'main';
const MINI_FAMILY = 'mini';
const COMPACT_FAMILY = 'compact'; // wide but short
const WIDGET_CELL_SIZES = {
  [MAIN_FAMILY]: CELL_SIZE,
  [MINI_FAMILY]: MINI_CELL_SIZE,
  [COMPACT_FAMILY]: {width: CELL_SIZE, height: MINI_CELL_SIZE}, // 190×120
};
const WIDGET_SIZE_SHAPES = {
  minismall: [1, 1, MINI_FAMILY], // 1x1 mini
  mini: [2, 1, MINI_FAMILY], // 2x1 mini
  portraitmini: [1, 2, MINI_FAMILY], // 1x2 mini
  minilarge: [2, 2, MINI_FAMILY], // 2x2 mini
  compact: [2, 1, COMPACT_FAMILY], // 2x1 compact (wide and short)
  small: [1, 1, MAIN_FAMILY], // 1x1
  medium: [2, 1, MAIN_FAMILY], // 2x1
  portrait: [1, 2, MAIN_FAMILY], // 1x2
  large: [2, 2, MAIN_FAMILY], // 2x2
  tall: [2, 4, MAIN_FAMILY], // 2x4
  wide: [4, 2, MAIN_FAMILY], // 4x2
  huge: [4, 4, MAIN_FAMILY], // 4x4
};
const WIDGET_SIZE_KEYS = new Set(Object.keys(WIDGET_SIZE_SHAPES));

// Stacked page palette (main + compact family), ordered small → large: a
// "widget in widget" page is never larger than its host's slot, so the
// gallery chips filter this list by the host's [cols, rows] shape.
const PAGE_SIZE_ORDER = ['small', 'portrait', 'medium', 'compact', 'large'];


function widgetSizeLabel(sizeKey) {
	const [cols, rows] = WIDGET_SIZE_SHAPES[sizeKey] ?? [1, 1];
	return `${cols}×${rows}`;
};


function widgetSizesFor(gap) {
  const sizes = {};

  for (const [key, [cols, rows, family]] of Object.entries(WIDGET_SIZE_SHAPES)) {
    const base = WIDGET_CELL_SIZES[family];

    // Rectangular cell support (COMPACT_FAMILY)
    if (typeof base === 'object') {
      sizes[key] = [
        cols * base.width + (cols - 1) * gap,
        rows * base.height + (rows - 1) * gap,
      ];
    } else {
      sizes[key] = [cols * base + (cols - 1) * gap, rows * base + (rows - 1) * gap];
    }
  };

  return sizes;
};

function defaultSizeKeyFor(type) {
  const widgetModule = WIDGETS.get(type);

  return widgetModule?.defaultSize && WIDGET_SIZE_KEYS.has(widgetModule.defaultSize)
    ? widgetModule.defaultSize
    : 'small';
};

function sizeLabel(sizeKey) {
    switch (sizeKey) {
        case 'minismall':
            return _('1×1 mini');
        case 'mini':
            return _('2×1 mini');
        case 'portraitmini':
            return _('1×2 mini');
        case 'minilarge':
            return _('2×2 mini');
        case 'compact':
            return _('2×1 (compact)');
        case 'small':
            return _('1×1');
        case 'medium':
            return _('2×1');
        case 'portrait':
            return _('1×2');
        case 'large':
            return _('2×2');
        case 'tall':
            return _('2×4');
        case 'wide':
            return _('4×2');
        case 'huge':
            return _('4×4');
        default:
            return sizeKey;
    }
}

function orderedSizes(sizeKeys) {
  const mini = [];
  const rest = [];

  for (const key of sizeKeys) {
    if (key.includes('mini')) {
      mini.push(key);
    } else {
      rest.push(key);
    };
  };

  return [...mini, ...rest];
};

const ACCENT_COLORS = {
  blue: '#3584e4',
  teal: '#2190a4',
  green: '#3a944a',
  yellow: '#c88800',
  orange: '#ed5b00',
  red: '#e62d42',
  pink: '#d56199',
  purple: '#9141ac',
  slate: '#6f8396',
};

function defaultWidgetPositions(gap) {
  const monitors = effectiveMonitors();
  const primary = monitors.find(m => m.isPrimary || m.index === Main.layoutManager.primaryIndex) ?? monitors[0];

  if (!primary) {
    return null;
  }

  // Each preset edge comes from the widget that holds it: the right
  // column is 2x1, the small left widget is 1x1, the mini row is 2x1 mini.
  const sizes = widgetSizesFor(gap);
  const union = unionOfMonitors(monitors);
  const ox = primary.x - union.x;
  const oy = primary.y - union.y;
  const topY = snap(oy + topYFor(primary));
  const row2Y = snap(topY + sizes.small[1] + gap);
  const row3Y = snap(row2Y + sizes.minismall[1] + gap);
  const rightX = snap(Math.max(ox + gap, ox + primary.width - sizes.medium[0] - gap));
  const middleX = snap(Math.max(ox + gap, rightX - sizes.medium[0] - gap));
  const leftSmallX = snap(Math.max(ox + gap, middleX - sizes.small[0] - gap));
  const rightMiniX = snap(Math.max(ox + gap, rightX - sizes.mini[0] - gap));
  const leftMiniX = snap(Math.max(ox + gap, rightMiniX - sizes.mini[0] - gap));

  return {
    weather: {x: middleX, y: topY},
    calendar: {x: rightX, y: topY},
    clock: {x: leftSmallX, y: topY},
    digitalclock: {x: leftSmallX, y: row2Y},
    binaryclock: {x: leftMiniX, y: row2Y},
    battery: {x: rightMiniX, y: row2Y},
    music: {x: rightX, y: row2Y},
    photos: {x: middleX, y: row3Y},
  };
};

function defaultPhotoData() {
  const path = assetPath('photofrwidgets.webp');

  if (path && Gio.File.new_for_path(path).query_exists(null)) {
    return {photo: path};
  };

  return {};
};

function cloneDefaultWidgets(gap) {
  const positions = defaultWidgetPositions(gap);

  return DEFAULT_WIDGETS.map(widget => ({
    id: widget.id,
    type: widget.type,
    size: widget.size,
    x: positions?.[widget.type]?.x ?? gap,
    y: positions?.[widget.type]?.y ?? gap,
    data: widget.type === 'photos' ? defaultPhotoData() : {},
  }));
};



function accentColor(settings) {
  const accent = settings?.get_string('accent-color') ?? 'blue';

  return ACCENT_COLORS[accent] ?? ACCENT_COLORS.blue;
}

function widgetAccentColor(layoutSettings, interfaceSettings) {
  if (layoutSettings?.get_boolean('style-use-custom-accent')) {
    const custom = layoutSettings.get_string('style-accent-color');

    if (custom) {
      return custom;
    }
  }

  return accentColor(interfaceSettings);
}

function darkStyleEnabled(settings) {
  return settings?.get_string('color-scheme') === 'prefer-dark';
};

function colorToRgba(color, alpha) {
  let r = 36, g = 36, b = 36;
  const hex = String(color ?? '').trim().replace('#', '');

  if (/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) {
    const expanded = hex.length === 3
      ? hex.split('').map(ch => ch + ch).join('')
      : hex;
    r = parseInt(expanded.slice(0, 2), 16);
    g = parseInt(expanded.slice(2, 4), 16);
    b = parseInt(expanded.slice(4, 6), 16);
  } else if (/^rgba?\(/.test(color)) {
    const match = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (match) {
      r = Number(match[1]);
      g = Number(match[2]);
      b = Number(match[3]);
    }
  }

  return `rgba(${r}, ${g}, ${b}, ${Number(alpha).toFixed(3)})`;
};

function snap(value) {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
};

// Resolve the pixel rect of a widget from its layout entry (size key, x, y).
// Size keys look up WIDGET_SIZE_SHAPES for [columns, rows, family]; the family
// picks the base cell size, so "2x1 compact" and "2x1" can differ in height.
function sizeForWidget(widget, gap) {
  const key = widget.size && WIDGET_SIZE_KEYS.has(widget.size)
    ? widget.size
    : defaultSizeKeyFor(widget.type);
  const [cols, rows, family] = WIDGET_SIZE_SHAPES[key];
  const base = WIDGET_CELL_SIZES[family];

  // Rectangular cell support (COMPACT_FAMILY)
  if (typeof base === 'object') {
    return [
      cols * base.width + (cols - 1) * gap,
      rows * base.height + (rows - 1) * gap
    ];
  }

  return [cols * base + (cols - 1) * gap, rows * base + (rows - 1) * gap];
};

function rectForWidget(widget, gap) {
  const [width, height] = sizeForWidget(widget, gap);

  return {
    x: widget.x,
    y: widget.y,
    width,
    height,
  };
};

function rectsOverlap(a, b, gap = WIDGET_GAP) {
  return a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y;
};

function raiseActor(actor) {
  const parent = actor.get_parent();

  if (parent?.set_child_above_sibling) {
    parent.set_child_above_sibling(actor, null);
  };
};

function unionOfMonitors(monitors) {
  if (!monitors?.length) {
    return {x: 0, y: 0, width: 0, height: 0};
  };

  const left = Math.min(...monitors.map(m => m.x));
  const top = Math.min(...monitors.map(m => m.y));
  const right = Math.max(...monitors.map(m => m.x + m.width));
  const bottom = Math.max(...monitors.map(m => m.y + m.height));

  return {x: left, y: top, width: right - left, height: bottom - top};
};

// The photos widget paints its own picture over the whole widget, so blurring
// the wallpaper behind it would cost a backdrop capture and show nothing.
const NO_GLASS_BACKDROP = new Set(['photos']);

function effectiveMonitors() {
  const monitors = Main.layoutManager.monitors;

  if (!monitors?.length) {
    const primary = Main.layoutManager.primaryMonitor;

    return primary ? [primary] : [];
  };

  return monitors;
};

function topYFor(monitor) {
  const isPrimary = !!monitor?.isPrimary || monitor?.index === Main.layoutManager.primaryIndex;

  return isPrimary && Main.panel?.height ? Main.panel.height : 0;
};

function monitorAtStage(monitors, x, y) {
  if (!monitors?.length) {
    return null;
  };

  const hit = monitors.find(m =>
    x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);

  if (hit) {
    return hit;
  };

  let nearest = monitors[0];
  let bestDistance = Infinity;

  for (const m of monitors) {
    const dx = m.x + m.width / 2 - x;
    const dy = m.y + m.height / 2 - y;
    const distance = dx * dx + dy * dy;

    if (distance < bestDistance) {
      bestDistance = distance;
      nearest = m;
    };
  };

  return nearest;
};

class WidgetController {
  constructor(extension) {
    this._extension = extension;
    this._widgets = [];
    this._views = new Map();
    this._dbusSignalIds = [];
    this._debounceTimers = {};
    this._pendingAppearance = {rebuild: false, refresh: false};
    this._dragSafetyId = 0;
    this._raiseIdleId = 0;
    this._pinEditSyncId = 0;
    this._pinSyncId = 0;
    this._pinStyleIdleId = 0;
    this._layerStackDirty = false;
    this._editMode = false;
    this._dragActor = null;
    this._dragGrab = null;
    this._layerX = null;
    this._layerY = null;
    this._needsLayoutPersist = false;
    this._pendingRepack = false;
    this._eventsClient = new CalendarWidget.CalendarEventsClient();
    this._lastAppLaunchAt = 0;
    this._suppressAppClickUntil = 0;
    this._indicator = null;
    this._workspaceIntegration = new WorkspaceIntegration();
    this._layoutSettings = extension.getSettings();
    this._interfaceSettings = new Gio.Settings({schema_id: INTERFACE_SCHEMA});
    this._weatherSettings = new Gio.Settings({schema_id: WeatherWidget.settingsSchema});
    this._weather = null;
    this._weatherLocation = null;
    this._weatherInfo = null;
    this._weatherUpdating = false;
    this._weatherUpdateTime = 0;
    this._fullscreenMonitorId = null;
    this._isFullscreen = false;
    this._animationsPaused = false;
    // Glass is now managed per-widget in _createWidget()
  };

  enable() {
    this._widgetGap = this._readWidgetGap();
    this._widgets = this._loadWidgets();
    this._saveWidgets();
    // Clear any stale drag flag left behind by a crashed preferences window.
    this._layoutSettings.set_boolean('drag-active', false);
    this._editMode = this._layoutSettings.get_boolean('edit-mode');
    this._layoutSettings.connectObject(
      'changed::layout-json', () => {
        if (this._suppressLayoutRebuild) {
          return;
        };

        if (this._layoutSettings.get_string(LAYOUT_KEY) === this._lastSavedJson) {
          return;
        };

        this._widgets = this._loadWidgets();
        this._rebuildWidgets();
      },
      'changed::edit-mode', () => this.setEditMode(this._layoutSettings.get_boolean('edit-mode')),
      'changed::widget-gap', () => {
        this._widgetGap = this._readWidgetGap();
        // One layout step per slider stop: rebuild the actors with
        // the new gap, lay them out with animation, and save the result.
        this._debounce('gap-rebuild', () => {
          this._rebuildWidgets();
          this._resolveLayout(null, true, true);
        }, 200);
      },
      'changed::photo-size', () => this._scheduleAppearance('refresh'),
      'changed::battery-icon-size', () => this._scheduleAppearance('refresh'),
      'changed::battery-slot-count', () => this._scheduleAppearance('refresh'),
      'changed::battery-show-percent', () => this._scheduleAppearance('refresh'),
      'changed::battery-use-accent-color', () => this._scheduleAppearance('refresh'),
      'changed::arrange-widgets', () => this._onArrangeRequested(),
      'changed::edit-mode-binding', () => this._registerEditModeBinding(),
      'changed::calendar-weekday-format', () => this._refreshCalendarWeekdays(),
      'changed::calendar-use-accent-color', () => this._refreshCalendarWeekdays(),
      // First day of the week / events lookahead re-render the calendar
      // cards in place, so the change is visible without reloading.
      'changed::calendar-first-day', () => this._scheduleAppearance('refresh'),
      'changed::calendar-lookahead', () => this._scheduleAppearance('refresh'),
      'changed::calendar-show-page-dots', () => this._scheduleAppearance('refresh'),
      'changed::calendar-hide-date-many-events', () => this._scheduleAppearance('refresh'),
      'changed::page-indicator-style', () => this._scheduleAppearance('refresh'),
      'changed::calendar-page-indicator-accent', () => this._scheduleAppearance('refresh'),
      'changed::system-show-page-dashes', () => this._scheduleAppearance('refresh'),
      'changed::system-page-indicator-accent', () => this._scheduleAppearance('refresh'),
      // Re-render the weather cards in place so the temperature flips between
      // accent and neutral text color the moment the toggle flips.
      'changed::weather-use-accent-color', () => this._refreshWeatherViews(),
      'changed::weather-show-page-dots', () => this._refreshWeatherViews(),
      'changed::weather-page-indicator-accent', () => this._refreshWeatherViews(),
      'changed::digitalclock-hour-format', () => this._scheduleAppearance('refresh'),
      'changed::digitalclock-show-seconds', () => this._scheduleAppearance('refresh'),
      'changed::digitalclock-show-ampm', () => this._scheduleAppearance('refresh'),
      'changed::digitalclock-smooth-seconds', () => this._scheduleAppearance('refresh'),
      'changed::clock-smooth-seconds', () => this._scheduleAppearance('refresh'),
      'changed::github-use-green', () => this._scheduleAppearance('refresh'),
      'changed::github-username', () => this._scheduleAppearance('refresh'),
      'changed::binaryclock-use-accent-color', () => this._scheduleAppearance('refresh'),
      'changed::style-border-radius', () => this._scheduleAppearance('rebuild'),
      'changed::style-border-width', () => this._scheduleAppearance('rebuild'),
      'changed::style-background', () => this._scheduleAppearance('rebuild'),
      'changed::style-border-color', () => this._scheduleAppearance('rebuild'),
      'changed::style-shadow', () => this._scheduleAppearance('rebuild'),
      'changed::style-widget-opacity', () => this._scheduleAppearance('rebuild'),
      'changed::style-use-custom-accent', () => this._scheduleAppearance('rebuild'),
      'changed::style-accent-color', () => this._scheduleAppearance('rebuild'),
      'changed::style-mode', () => this._scheduleAppearance('rebuild'),
      'changed::appearance', () => this._scheduleAppearance('rebuild'),
      // Glass parameters can be updated in place without rebuilding widgets.
      // These changes sync the glass backdrop immediately for live slider feedback.
      'changed::roundness-x10', () => this._updateAllGlassParams(),
      'changed::refract-thickness', () => this._updateAllGlassParams(),
      'changed::refract-ior-x100', () => this._updateAllGlassParams(),
      'changed::refract-scale', () => this._updateAllGlassParams(),
      'changed::chroma-strength-pct', () => this._updateAllGlassParams(),
      'changed::tint-alpha-pct', () => this._updateAllGlassParams(),
      'changed::spec-strength-pct', () => this._updateAllGlassParams(),
      'changed::blur-radius-px', () => this._updateAllGlassParams(),
      'changed::use-custom-widget-theme', () => this._scheduleAppearance('rebuild'),
      'changed::use-same-theme-for-both', () => this._scheduleAppearance('rebuild'),
      'changed::widget-theme-unified', () => this._scheduleAppearance('rebuild'),
      'changed::widget-theme-for-light', () => this._scheduleAppearance('rebuild'),
      'changed::widget-theme-for-dark', () => this._scheduleAppearance('rebuild'),
      'changed::drag-active', () => this._onDragActiveChanged(),
      'changed::show-panel-icon', () => this._syncPanelIcon(),
      this
    );
    this._createIndicator();
    this._createLayer();
    this._rebuildWidgets();

    // A layout saved before the new size formula is repacked once,
    // after the layer and actors already exist.
    if (this._pendingRepack) {
      this._pendingRepack = false;
      this._resolveLayout(null, false, true);
    };

    this._refreshWeather(true);
    this._registerEditModeBinding();
    this._workspaceIntegration.enable(this._layer);
    global.stage.connectObject(
      'captured-event', (_stage, event) => this._handleAppClickEvent(event),
      this
    );
    global.stage.connectObject(
      'captured-event', (_stage, event) => this._onStageEventForMenu(event),
      this
    );

    this._interfaceSettings.connectObject(
      'changed::color-scheme', () => this._rebuildWidgets(),
      'changed::accent-color', () => this._rebuildWidgets(),
      this
    );

    this._weatherSettings.connectObject('changed::locations', () => {
      this._weather = null;
      this._weatherUpdateTime = 0;
      this._refreshWeather(true);
      this._refreshWeatherViews();
    }, this);

    this._watchBatteryChanges();

    this._batteryDevicesUnsubscribe = BatteryWidget.onBatteryDevicesChanged(() => {
      this._debounce('battery', () => this._refreshBatteryViews(), 100);
    });

    // Track fullscreen windows to pause animations
    this._fullscreenMonitorId = global.display.connectObject(
      'window-created', () => this._debounce('fullscreen-check', () => this._checkFullscreen(), 100),
      'restacked', () => this._debounce('fullscreen-check', () => this._checkFullscreen(), 100),
      this
    );
    
    global.workspace_manager.connectObject(
      'active-workspace-changed', () => this._checkFullscreen(),
      this
    );

    this._layoutSettings.connectObject(
      'changed::pause-animations-fullscreen', () => this._checkFullscreen(),
      this
    );

    // Check fullscreen state on startup
    this._checkFullscreen();

    if (this._layoutSettings.get_boolean('arrange-widgets')) {
      this._onArrangeRequested();
    };

    Main.layoutManager.connectObject(
      'monitors-changed', () => this._syncLayerGeometry(),
      this
    );

    // No need for aggressive retries - glass is now a child actor and gets allocation automatically
  };

  destroy() {
    // Glass is now destroyed automatically with widget actors
    
    this._eventsClient?.destroy();
    this._eventsClient = null;
    this._workspaceIntegration.destroy();

    this._batteryDevicesUnsubscribe?.();
    this._batteryDevicesUnsubscribe = null;

    // Clean up fullscreen subscriptions
    if (this._fullscreenMonitorId) {
      global.display.disconnectObject(this);
      global.workspace_manager.disconnectObject(this);
      this._fullscreenMonitorId = null;
    }
    // Module-level pause flags outlive disable(): reset them so a re-enable
    // does not start with frozen animations.
    if (this._animationsPaused) {
      this._animationsPaused = false;
      this._setWidgetAnimationsPaused(false);
    }

    for (const record of Object.values(this._debounceTimers)) {
      if (record?.id) GLib.source_remove(record.id);
    }
    this._debounceTimers = {};

    if (this._dragSafetyId) {
      GLib.source_remove(this._dragSafetyId);
      this._dragSafetyId = 0;
    };

    if (this._raiseIdleId) {
      GLib.source_remove(this._raiseIdleId);
      this._raiseIdleId = 0;
    };

    if (this._pinEditSyncId) {
      GLib.source_remove(this._pinEditSyncId);
      this._pinEditSyncId = 0;
    };

    if (this._pinSyncId) {
      GLib.source_remove(this._pinSyncId);
      this._pinSyncId = 0;
    };

    if (this._pinStyleIdleId) {
      GLib.source_remove(this._pinStyleIdleId);
      this._pinStyleIdleId = 0;
    };

    global.stage.disconnectObject(this);
    Main.layoutManager.disconnectObject(this);
    Main.wm.removeKeybinding(EDIT_MODE_BINDING_KEY);
    this._layoutSettings.disconnectObject(this);
    this._interfaceSettings.disconnectObject(this);
    this._weatherSettings.disconnectObject(this);

    for (const id of this._dbusSignalIds) {
      Gio.DBus.system.signal_unsubscribe(id);
    };

    this._dbusSignalIds = [];

    this._cancelActiveDrag();

    this._editModeMenuItem?.destroy?.();
    this._indicator?.destroy();
    this._indicator = null;
    this._editModeMenuItem = null;

    this._clearWeatherInfo();

    this._destroyLayer();
    this._layoutSettings = null;
    this._interfaceSettings = null;
    this._weatherSettings = null;
    this._extension = null;
  };

  // Debounce by key: only the last call within `delay` runs its callback.
  // Used for bursts of GSettings changes / window events that should trigger
  // a single rebuild. Timers are tracked in _debounceTimers and removed in
  // destroy() so nothing fires after disable().
  _debounce(key, callback, delay = 200) {
    if (this._debounceTimers[key]) {
      GLib.source_remove(this._debounceTimers[key].id);
    }

    const record = {since: Date.now(), id: 0};
    record.id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      // Clear BEFORE running: a callback that re-debounces the same key
      // must keep its new record (clearing after it orphaned that timer),
      // and a throwing callback must not leave a dead source id behind
      // (the next source_remove would hit a removed source).
      if (this._debounceTimers[key] === record)
        this._debounceTimers[key] = 0;
      try {
        callback();
      } catch (e) {
        warn('debounce', `Deferred '${key}' failed: ${e}`);
      };
      return GLib.SOURCE_REMOVE;
    });
    this._debounceTimers[key] = record;
  };

  _scheduleAppearance(kind) {
    if (this._layoutSettings.get_boolean('drag-active')) {
      this._pendingAppearance[kind] = true;
      return;
    }

    this._debounce(kind, () => {
      this._pendingAppearance[kind] = false;
      if (kind === 'rebuild') {
        this._rebuildWidgets();
      } else {
        this._refreshWidgets();
      };
    }, 200);
  };

  _onDragActiveChanged() {
    if (this._layoutSettings.get_boolean('drag-active')) {
      // Slider grabbed: drop anything already scheduled, wait for release.
      for (const kind of ['rebuild', 'refresh']) {
        const record = this._debounceTimers[kind];
        if (record?.id) GLib.source_remove(record.id);
        this._debounceTimers[kind] = 0;
        this._pendingAppearance[kind] = false;
      };

      // Safety net: if the preferences window dies mid-drag the flag could
      // stick forever, so clear it after an implausibly long hold.
      if (this._dragSafetyId) GLib.source_remove(this._dragSafetyId);
      this._dragSafetyId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 120, () => {
        this._dragSafetyId = 0;
        if (this._layoutSettings.get_boolean('drag-active')) {
          this._layoutSettings.set_boolean('drag-active', false);
        };
        return GLib.SOURCE_REMOVE;
      });
      return;
    };

    if (this._dragSafetyId) {
      GLib.source_remove(this._dragSafetyId);
      this._dragSafetyId = 0;
    };

    // Handle released: flush any appearance change made during the drag.
    for (const kind of ['rebuild', 'refresh']) {
      if (this._pendingAppearance[kind]) {
        this._scheduleAppearance(kind);
      };
    };
  };

  _createIndicator() {
    if (!this._layoutSettings.get_boolean('show-panel-icon')) {
      return;
    };

    this._indicator = new PanelMenu.Button(0.0, _('Desktop Widgets'));
    this._indicator.add_child(new St.Icon({
      icon_name: 'view-grid-symbolic',
      style_class: 'system-status-icon',
    }));

    const editItem = new PopupMenu.PopupSwitchMenuItem(_('Edit Mode'), this._editMode);
    editItem.connectObject('toggled', (_item, state) => {
      this._layoutSettings.set_boolean('edit-mode', state);
    }, this);

    this._editModeMenuItem = editItem;
    this._indicator.menu.addMenuItem(editItem);
    this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const addWidgetsItem = new PopupMenu.PopupMenuItem(_('Add Widgets'));
    addWidgetsItem.connectObject('activate', () => {
      this._layoutSettings.set_boolean('open-widget-picker', true);
      this._extension.openPreferences();
    }, this);
    this._indicator.menu.addMenuItem(addWidgetsItem);

    this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const arrangeItem = new PopupMenu.PopupMenuItem(_('Arrange Widgets'));
    arrangeItem.connectObject('activate', () => {
      this._layoutSettings.set_boolean('arrange-widgets', true);
    }, this);
    this._indicator.menu.addMenuItem(arrangeItem);

    Main.panel.addToStatusArea(this._extension.uuid, this._indicator);
  };

  _syncPanelIcon() {
    const shouldShow = this._layoutSettings.get_boolean('show-panel-icon');

    if (shouldShow && !this._indicator) {
      this._createIndicator();
    } else if (!shouldShow && this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
      this._editModeMenuItem = null;
    };
  };

  _updatePanelEditModeState() {
    if (this._editModeMenuItem && !this._editModeMenuItem.is_destroyed?.()) {
      this._editModeMenuItem.setToggleState(this._editMode);
    };
  };

  _parseWidgets(serialized) {
    const fallbackGap = this._widgetGap ?? WIDGET_GAP;
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch (e) {
      warn('parse-error', `Failed to parse widget layout: ${e.message}`);
      return cloneDefaultWidgets(fallbackGap);
    }
    if (!Array.isArray(parsed.widgets)) {
      return cloneDefaultWidgets(fallbackGap);
    };

    const widgets = parsed.widgets
      .filter(widget => widget.id && widget.type)
      .filter(widget => WIDGETS.has(widget.type))
      .map(widget => {
        const widgetModule = WIDGETS.get(widget.type);
        const fallback = defaultSizeKeyFor(widget.type);
        const saved = String(widget.size ?? '');
        const supported = widgetModule?.supportedSizes ?? [];
        const size = WIDGET_SIZE_KEYS.has(saved) && (supported.length === 0 || supported.includes(saved))
          ? saved
          : fallback;

        return {
          id: String(widget.id),
          type: String(widget.type),
          size,
          x: Number.isFinite(widget.x) ? widget.x : 24,
          y: Number.isFinite(widget.y) ? widget.y : 80,
          data: widget.data && typeof widget.data === 'object' ? widget.data : {},
          // Widget-in-widget pages: {type, key, data} — added pages hang
          // below the primary one (widgets/widgetStack.js). Types are
          // re-validated there on every load; a stale type simply drops.
          stack: Array.isArray(widget.stack)
            ? widget.stack
              .filter(entry => entry && WIDGETS.has(String(entry?.type)))
              .slice(0, STACK_PAGE_LIMIT)
              .map(entry => {
                // The page size is validated against the host's slot shape:
                // a stacked page equals its host or is smaller, never larger.
                const [hostCols, hostRows] = WIDGET_SIZE_SHAPES[size] ?? [1, 1];
                const entryShape = WIDGET_SIZE_SHAPES[String(entry.size ?? '')];
                const pageSize = entryShape && entryShape[0] <= hostCols && entryShape[1] <= hostRows
                  ? String(entry.size)
                  : null;

                return {
                  type: String(entry.type),
                  key: String(entry.key ?? Math.random().toString(36).slice(2, 9)),
                  data: entry.data && typeof entry.data === 'object' ? entry.data : {},
                  size: pageSize,
                  // Migration: old entries without side default to 'below'
                  side: entry.side === 'above' || entry.side === 'below' ? entry.side : 'below',
                };
              })
            : [],
          pinned: !!widget.pinned,
        };
      });

    const savedVersion = parsed.version ?? 1;

    if (savedVersion !== LAYOUT_VERSION) {
      // The primary-monitor shift was already applied on path 1 -> 2, so
      // apply it again only for versionless layouts and version 1.
      if (savedVersion === 1) {
        const union = unionOfMonitors(effectiveMonitors());
        const primary = Main.layoutManager.primaryMonitor;

        if (primary && union.width && union.height) {
          const dX = primary.x - union.x;
          const dY = primary.y - union.y;

          for (const widget of widgets) {
            widget.x += dX;
            widget.y += dY;
          };
        };
      };

      this._needsLayoutPersist = true;
      // A repack is only possible once the layer and widgets exist,
      // so enable() consumes this flag after the first rebuild.
      this._pendingRepack = true;
    };

    return widgets;
  };

  _loadWidgets() {
    const serialized = this._layoutSettings.get_string(LAYOUT_KEY);
    const widgets = serialized ? this._parseWidgets(serialized) : []; // Start with empty desktop

    if (this._needsLayoutPersist) {
      this._widgets = widgets;
      this._saveWidgets();
      this._needsLayoutPersist = false;
    };

    return widgets;
  };

  _saveWidgets() {
    try {
      // _lastSavedJson is set before writing so that the changed::layout-json
      // handler recognizes its own write and does not rebuild the widgets.
      this._lastSavedJson = layoutJson(this._widgets);
      this._layoutSettings.set_string(LAYOUT_KEY, this._lastSavedJson);
    } catch (e) {
      logError(e, 'desktop-widgets: _saveWidgets failed');
      throw e;
    }
  };

  _clearViews() {
    this._closeStackPanel();
    this._closeStackGallery({animate: false});
    for (const view of this._views.values()) {
      view.sizeMenu?.destroy();
      this._destroyContextMenu(view);
        view.actor.disconnectObject(this);
    };

    this._views.clear();
  };

  _checkFullscreen() {
    const enabled = this._layoutSettings?.get_boolean('pause-animations-fullscreen') ?? true;
    if (!enabled) {
      if (this._animationsPaused) {
        this._resumeAnimations();
      }
      return;
    }

    const workspace = global.workspace_manager.get_active_workspace();
    const windows = workspace.list_windows();
    const hasFullscreen = windows.some(win => win.is_fullscreen());

    if (hasFullscreen && !this._animationsPaused) {
      this._pauseAnimations();
    } else if (!hasFullscreen && this._animationsPaused) {
      this._resumeAnimations();
    }
  }

  _pauseAnimations() {
    this._animationsPaused = true;

    // 🚨 AGGRESSIVE FULLSCREEN OPTIMIZATION
    // Stop every widget and timer completely

    // Screen time is intentionally NOT paused here: a fullscreen video or a
    // fullscreen app is real screen time, and the old pause dropped it from
    // the totals and stalled the live chart until unpause.

    // 1. Pause SystemMonitor polling
    try {
      if (SystemWidget && SystemWidget.monitor && typeof SystemWidget.monitor.pausePolling === 'function') {
        SystemWidget.monitor.pausePolling();
      }
    } catch (e) {
      warn('system-monitor', `Failed to pause SystemMonitor: ${e}`);
    }

    // 2. Pause every animated widget. Views never carried a widgetInstance,
    // so the old per-view pause() loop was a no-op; widget modules expose a
    // module-level setAnimationsPaused() hook instead.
    this._setWidgetAnimationsPaused(true);
  }

  _setWidgetAnimationsPaused(paused) {
    for (const widgetModule of WIDGET_MODULES) {
      if (typeof widgetModule.setAnimationsPaused !== 'function')
        continue;
      try {
        widgetModule.setAnimationsPaused(paused);
      } catch (e) {
        warn(paused ? 'widget-pause' : 'widget-resume', `Failed to ${paused ? 'pause' : 'resume'} widget ${widgetModule.type}: ${e}`);
      }
    }
  }

  _resumeAnimations() {
    this._animationsPaused = false;

    // 🚨 AGGRESSIVE FULLSCREEN OPTIMIZATION
    // Restore every widget and timer

    // Screen time never paused on fullscreen (see _pauseAnimations):
    // tracking continues across fullscreen sessions.

    // 1. Resume SystemMonitor polling
    try {
      if (SystemWidget && SystemWidget.monitor && typeof SystemWidget.monitor.resumePolling === 'function') {
        SystemWidget.monitor.resumePolling();
      }
    } catch (e) {
      warn('system-monitor', `Failed to resume SystemMonitor: ${e}`);
    }

    // 2. Resume every animated widget
    this._setWidgetAnimationsPaused(false);
  }

  _destroyLayer() {
    Main.layoutManager._backgroundGroup?.disconnectObject(this);
    global.window_group?.disconnectObject(this);
    global.display?.disconnectObject(this);
    global.stage?.disconnectObject(this);
    this._layerStackDirty = false;

    if (this._raiseIdleId) {
      GLib.source_remove(this._raiseIdleId);
      this._raiseIdleId = 0;
    };

    this._workspaceIntegration.setSource(null);
    this._cancelActiveDrag();
    this._clearViews();
    this._layer?.destroy();
    this._layer = null;
  };

  _createLayer() {
    const backgroundGroup = Main.layoutManager._backgroundGroup;

    if (!backgroundGroup) {
      warn('background-group-missing', 'Could not find GNOME Shell background group');
      return;
    };

    this._destroyLayer();

    this._layer = new St.Widget({
      style_class: 'widget-layer',
      reactive: false,
      x_expand: true,
      y_expand: true,
    });

    backgroundGroup.add_child(this._layer);
    this._keepLayerAboveDesktopIcons(backgroundGroup);
    this._syncLayerGeometry();
    this._workspaceIntegration.setSource(this._layer);
  };

  _isDingWindow(metaWindow) {
    if (!metaWindow) {
      return false;
    };

    // DING's desktop window is titled like "@!0,0;BDHF",this will identify them
    if ((metaWindow.get_title() ?? '').startsWith('@!')) {
      return true;
    };

    const appId = metaWindow.get_gtk_application_id?.() ?? '';
    const wmClass = metaWindow.get_wm_class?.() ?? '';
    const dingToken = /(^|[._-])ding($|[._-])/i;

    if (!dingToken.test(appId) && !dingToken.test(wmClass)) {
      return false;
    };

    // DING's dialog properties such as file finding is a part of the
    // same App ID as DING,causing the widgets to
    // teleport over some apps when those properties are called
    // This patch is for fixing them and it is not guaranteed to fix it
    // This patch is still experimental,please report any problems you can find :3
    const monitorIndex = metaWindow.get_monitor();

    if (monitorIndex < 0) {
      return false;
    };

    const rect = metaWindow.get_frame_rect();
    const monitor = global.display.get_monitor_geometry(monitorIndex);

    return rect.width >= monitor.width * 0.9 && rect.height >= monitor.height * 0.9;
  };

  _placeLayerAboveDesktopIcons() {
    const layer = this._layer;
    const windowGroup = global.window_group;
    const backgroundGroup = Main.layoutManager._backgroundGroup;

    if (!layer || !windowGroup || !backgroundGroup) {
      return;
    };

    let topDing = null;

    for (const child of windowGroup.get_children()) {
      if (child !== layer && this._isDingWindow(child.meta_window)) {
        topDing = child;
      };
    };

    if (topDing) {
      if (layer.get_parent() !== windowGroup) {
        layer.get_parent()?.remove_child(layer);
        windowGroup.add_child(layer);
      };

      windowGroup.set_child_above_sibling(layer, topDing);
    } else {
      if (layer.get_parent() !== backgroundGroup) {
        layer.get_parent()?.remove_child(layer);
        backgroundGroup.add_child(layer);
      };

      backgroundGroup.set_child_above_sibling(layer, null);
    };
  };

  _keepLayerAboveDesktopIcons(_backgroundGroup) {
    const markDirty = () => {
      this._layerStackDirty = true;

      if (!this._raiseIdleId) {
        this._raiseIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
          this._raiseIdleId = 0;
          this._layerStackDirty = false;
          this._placeLayerAboveDesktopIcons();

          return GLib.SOURCE_REMOVE;
        });
      };
    };

    global.window_group.connectObject('child-added', markDirty, 'child-removed', markDirty, this);
    global.display.connectObject('restacked', markDirty, this);
    global.stage.connectObject('before-update', () => {
      if (!this._layerStackDirty) {
        return;
      };

      this._layerStackDirty = false;
      this._placeLayerAboveDesktopIcons();
    }, this);

    markDirty();
  };

  _syncLayerGeometry() {
    const monitors = effectiveMonitors();
    const union = unionOfMonitors(monitors);

    if (!this._layer || !union.width || !union.height) {
      return;
    };

    const oldX = this._layerX;
    const oldY = this._layerY;

    if (oldX !== null && oldY !== null && this._widgets.length) {
      const dX = oldX - union.x;
      const dY = oldY - union.y;

      for (const widget of this._widgets) {
        widget.x += dX;
        widget.y += dY;
      };
    };

    this._layerX = union.x;
    this._layerY = union.y;
    this._layer.set_position(union.x, union.y);
    this._layer.set_size(union.width, union.height);

    for (const view of this._views.values()) {
      this._animateWidget(view.widget, false);
    };

    this._resolveLayout(null, false, true);

    this._workspaceIntegration.queueSync();
  };

  // Effective light/dark palette for widget content. The custom widget theme
  // (when enabled) wins over the glass appearance setting.
  _widgetDark() {
    const systemDark = darkStyleEnabled(this._interfaceSettings);

    if (!this._layoutSettings.get_boolean('use-custom-widget-theme')) {
      const appearance = this._layoutSettings.get_int('appearance');
      if (appearance === 0)
        return true;
      if (appearance === 1)
        return false;
      return systemDark;
    }

    const useSameForBoth = this._layoutSettings.get_boolean('use-same-theme-for-both');
    const themeChoice = useSameForBoth
      ? this._layoutSettings.get_string('widget-theme-unified')
      : (systemDark
        ? this._layoutSettings.get_string('widget-theme-for-dark')
        : this._layoutSettings.get_string('widget-theme-for-light'));

    return themeChoice === 'dark';
  };

  _gnomeTheme() {
    const dark = this._widgetDark();
    const isGlass = this._layoutSettings.get_int('style-mode') === 0;
    const backgroundSetting = this._layoutSettings.get_string('style-background');
    const borderSetting = this._layoutSettings.get_string('style-border-color');

    // Keep theme.background a real colour: nested panels in some widgets use
    // it for their own fills. The root actor is made transparent separately
    // in _styleForWidget when glass is active.
    const background = backgroundSetting || (dark ? '#242424' : '#ffffff');
    const border = borderSetting || (isGlass
      ? (dark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(0, 0, 0, 0.14)')
      : (dark ? '#3d3d3d' : '#deddda'));

    return {
      dark,
      isGlass,
      isSolid: !isGlass,
      accent: widgetAccentColor(this._layoutSettings, this._interfaceSettings),
      background,
      border,
      text: dark ? '#ffffff' : '#241f31',
      muted: dark ? '#c0bfbc' : '#5e5c64',
      radius: this._layoutSettings.get_int('style-border-radius'),
      borderWidth: this._layoutSettings.get_int('style-border-width'),
      shadow: this._layoutSettings.get_string('style-shadow'),
    };
  };

  // Per-widget skip decision for the glass backdrop. Photos is special:
  // glass only behind the empty "Select photo" placeholder, never behind a
  // real photo (the photo frame paints the widget itself).
  _widgetSkipsGlass(widget) {
    if (widget.type === 'photos') {
      return PhotosWidget.hasPhoto?.(widget) ?? true;
    };

    return NO_GLASS_BACKDROP.has(widget.type);
  };

  _styleForWidget(widget) {
    const widgetModule = WIDGETS.get(widget.type);

    if (!widgetModule?.style) {
      return null;
    };

    const theme = this._gnomeTheme();
    const glassRoot = theme.isGlass && !this._widgetSkipsGlass(widget);
    let styleStr = widgetModule.style(theme);

    // Solid mode must be fully opaque and clipped to its own rounded edges;
    // otherwise the transparent wrapper + nested widget fills create the
    // visible "glass halo" artifacts on the borders and the corners leak.
    if (theme.isSolid) {
      styleStr += ` background-color: ${theme.background};`;
      styleStr += ` border-radius: ${theme.radius}px;`;
      styleStr += ' overflow: hidden;';
      styleStr += ' box-shadow: none;';
    } else if (glassRoot) {
      // Glass draws its own squircle backdrop behind the widget. Make only the
      // root actor transparent so the blur/refraction shows; nested elements
      // still get their regular theme.background fills.
      styleStr += ' background-color: transparent;';
      styleStr += ` border-radius: ${theme.radius}px;`;
    }

    // The edit-border text color is set here, not in stylesheet.css: there it was
    // hardcoded for the dark theme, so in the light theme widgets lost their
    // text. Modules that set their own color use the same
    // theme.text, so overriding it is safe.
    styleStr += ` color: ${theme.text};`;

    // Apply custom global styles dynamically
    if (theme.radius !== 16) {
      styleStr += ` border-radius: ${theme.radius}px;`;
    } else if (glassRoot) {
      // For glass, always apply border-radius explicitly so CSS and shader match
      styleStr += ` border-radius: ${theme.radius}px;`;
    }
    if (theme.borderWidth !== 1) {
      styleStr += ` border-width: ${theme.borderWidth}px;`;
    }
    if (theme.shadow) {
      styleStr += ` box-shadow: ${theme.shadow};`;
    } else if (theme.isGlass) {
      // Glass carries no shadow: the blur is the whole effect, and a shadow
      // only reads as a halo spilling past the widget's own edges. This also
      // cancels the drop shadow stylesheet.css puts on every widget.
      // It must cover widgets that skip the glass backdrop too (a photo):
      // the wrapper clips to its RECTANGLE, so the stylesheet shadow showed
      // up exactly in the rounded corners and the card looked square.
      styleStr += ' box-shadow: none;';
    }

    return styleStr;
  };

  // Stacked pages (widget-in-widget) share the primary's style pipeline so
  // the Glass switch and dark/light theme changes reach them too. The stub
  // mirrors the page record: photos' skip rule reads the entry's own data.
  _styleForStackPage(entry, hostType = null) {
    const stub = {
      id: hostType ? `stack-page-${hostType}` : 'stack-page',
      type: entry.type,
      size: entry.size ?? null,
      data: entry.data && typeof entry.data === 'object' ? entry.data : {},
      pinned: true,
    };

    return this._styleForWidget(stub);
  };

  // Builds (or rebuilds after a host resize) the stacked pages of a view.
  _ensureStack(view, startPage = null) {
    if (!view?.box || isActorDestroyed(view.box))
      return;
    const hasPages = Array.isArray(view.widget.stack) && view.widget.stack.some(e => e?.type);
    const [w, h] = view.box.get_size();
    if (view._stackPrism && (!hasPages || view._stackPrism._hostW !== w || view._stackPrism._hostH !== h))
      this._disposeStack(view);
    if (view._stackPrism || !hasPages)
      return;

    try {
      const prism = attachWidgetStack({
        paneRoot: view.actor,
        baseActor: view.box,
        baseGlass: view.glass ?? null,
        widget: view.widget,
        theme: this._gnomeTheme(),
        styleForEntry: entry => this._styleForStackPage(entry, view.widget.type),
        wantsGlassEntry: entry => this._wantsGlassForStackPage(entry),
        glassParams: () => this._glassParamsFor(),
        startPage: startPage ?? view._stackStartPage ?? 0,
        pageSizeFor: sizeKey => widgetSizesFor(this._widgetGap ?? WIDGET_GAP)[sizeKey] ?? null,
        renderPage: (record, pageBody, pageRoot) => this._fillWidgetBody(record, pageBody, pageRoot),
        isEditMode: () => this._editMode,
        onStateSaved: () => this._saveWidgets(),
        onPageChange: (page) => {
          view._stackStartPage = page;
          if (this._editMode && view) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
              if (this._views.get(view.widget.id) === view)
                this._syncEditControls(view.widget, false);
              return GLib.SOURCE_REMOVE;
            });
          };
        },
      });
      prism._hostW = w;
      prism._hostH = h;
      view._stackPrism = prism;
    } catch (error) {
      warn('stack-attach-failed', `Stack attach failed: ${error.message}`);
    };
  };

  _disposeStack(view) {
    if (!view?._stackPrism)
      return;
    view._stackStartPage = view._stackPrism.getActivePage?.() ?? 0;
    try {
      view._stackPrism.dispose();
    } catch (_e) {}
    view._stackPrism = null;
  };

  _wantsGlassForStackPage(entry) {
    const stub = {
      type: entry.type,
      data: entry.data && typeof entry.data === 'object' ? entry.data : {},
    };

    return this._gnomeTheme().isGlass && !this._widgetSkipsGlass(stub);
  };

  _clearWeatherInfo() {
    const info = this._weatherInfo;

    this._weatherInfo = null;
    this._weatherUpdating = false;

    if (info) {
      info.disconnectObject(this);
      info.abort();
    };
  };

  _refreshWeather(force = false) {
    const now = Date.now();

    if (this._weatherUpdating && !force) {
      return;
    };

    if (!force && now - this._weatherUpdateTime < WeatherWidget.cacheTtlMs) {
      return;
    };

    const location = WeatherWidget.locationFromSettings(this._weatherSettings);
    const displayName = WeatherWidget.locationNameFromSettings(this._weatherSettings);
    this._weatherLocation = displayName;

    if (!location) {
      this._clearWeatherInfo();
      this._weather = null;
      this._weatherUpdateTime = now;
      return;
    };

    this._clearWeatherInfo();
    const info = WeatherWidget.infoForLocation(location);
    this._weatherInfo = info;
    this._weatherUpdating = true;

    info.connectObject('updated', () => {
      if (info !== this._weatherInfo) {
        return;
      };

      this._weatherUpdating = false;
      this._weatherUpdateTime = Date.now();

      if (info.is_valid()) {
        this._weather = WeatherWidget.weatherFromInfo(info, location, displayName);
      } else {
        this._weather = null;
      };

      this._refreshWeatherViews();
    }, this);

    info.update();
  };

  _refreshWeatherViews() {
    for (const view of this._views.values()) {
      if (view.widget.type === 'weather') {
        this._fillWidgetBody(view.widget, view.body);
      };
    };
  };

  _refreshBatteryViews() {
    for (const view of this._views.values()) {
      if (view.widget.type === 'battery') {
        this._safeFillWidgetBody(view.widget, view.body);
      };
    };
  };

  _watchBatteryChanges() {
    // UPower and BlueZ emit bursts of signals (one per device per property),
    // so coalesce them into a single re-render.
    const refresh = () => this._debounce('battery', () => this._refreshBatteryViews(), 300);
    const refreshBlueZ = (_connection, _sender, _objectPath, _interfaceName, _signalName, parameters) => {
      const [changedInterface] = parameters.deep_unpack();

      if (['org.bluez.Device1', 'org.bluez.Battery1'].includes(changedInterface)) {
        refresh();
      };
    };

    this._dbusSignalIds.push(
      Gio.DBus.system.signal_subscribe('org.freedesktop.UPower', 'org.freedesktop.UPower', 'DeviceAdded', '/org/freedesktop/UPower', null, Gio.DBusSignalFlags.NONE, refresh),
      Gio.DBus.system.signal_subscribe('org.freedesktop.UPower', 'org.freedesktop.UPower', 'DeviceRemoved', '/org/freedesktop/UPower', null, Gio.DBusSignalFlags.NONE, refresh),
      Gio.DBus.system.signal_subscribe('org.freedesktop.UPower', 'org.freedesktop.DBus.Properties', 'PropertiesChanged', null, 'org.freedesktop.UPower.Device', Gio.DBusSignalFlags.NONE, refresh),
      Gio.DBus.system.signal_subscribe('org.bluez', 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded', '/', null, Gio.DBusSignalFlags.NONE, refresh),
      Gio.DBus.system.signal_subscribe('org.bluez', 'org.freedesktop.DBus.ObjectManager', 'InterfacesRemoved', '/', null, Gio.DBusSignalFlags.NONE, refresh),
      Gio.DBus.system.signal_subscribe('org.bluez', 'org.freedesktop.DBus.Properties', 'PropertiesChanged', null, null, Gio.DBusSignalFlags.NONE, refreshBlueZ)
    );
  };

  setEditMode(enabled) {
    this._editMode = enabled;
    this._updatePanelEditModeState();

    for (const view of this._views.values()) {
      // Toggle rail reactivity: in edit mode, panel buttons must catch
      // clicks, so the rail yields (non-reactive). In usage mode, the
      // rail catches drags for flipping between stacked pages.
      // Only refresh widgets that actually have a stack prism attached.
      view._stackPrism?.refresh?.();

      if (enabled) {
        if (!view.draggable) {
          this._makeDraggable(view);
        };

        if (!view.editBorder) {
          this._addEditControls(view);
        };
      } else {
        this._cancelActiveDrag();
        this._closeStackPanel();
        this._closeStackGallery();
        this._hideContextMenus();
        // A size switch may still be mid-animation; snap the widget to its
        // final size/position so nothing is left at an intermediate state
        // after leaving edit mode.
        this._animateWidget(view.widget, false);
        this._destroyContextMenu(view);
        view.sizeMenu?.destroy();
        view.sizeButton?.destroy();
        view.editBorder?.destroy();
        view.removeButton?.destroy();
        view.pinButton?.destroy();
        view.photoButton?.destroy();
        view.editBorder = null;
        view.removeButton = null;
        view.pinButton = null;
        view.sizeButton = null;
        view.sizeMenu = null;
        view.photoButton = null;
      };
    };

    // After entering edit mode and creating all edit controls, sync the visual
    // state of pinned widgets. Use timeout to ensure buttons are fully constructed.
    if (enabled) {
      if (this._pinEditSyncId) {
        GLib.source_remove(this._pinEditSyncId);
      };

      this._pinEditSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        this._pinEditSyncId = 0;
        for (const view of this._views.values()) {
          if (view.widget.pinned && view.pinButton) {
            this._syncPinButtonState(view.widget.id);
          }
        }
        return GLib.SOURCE_REMOVE;
      });
    }
  };

  _registerEditModeBinding() {
    Main.wm.removeKeybinding(EDIT_MODE_BINDING_KEY);

    if (!this._layoutSettings.get_strv(EDIT_MODE_BINDING_KEY).length) {
      return;
    };

    Main.wm.addKeybinding(
      EDIT_MODE_BINDING_KEY,
      this._layoutSettings,
      Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
      Shell.ActionMode.ALL,
      () => this._layoutSettings.set_boolean('edit-mode',
        !this._layoutSettings.get_boolean('edit-mode'))
    );
  };

  addWidget(type) {
    const widgetModule = WIDGETS.get(type);

    if (!widgetModule) {
      return;
    };

    const index = this._widgets.length;
    const size = defaultSizeKeyFor(type);

    const widget = {
      id: `${type}-${Date.now()}`,
      type,
      size,
      x: snap(32 + (index % 4) * 240),
      y: snap(96 + Math.floor(index / 4) * 250),
      data: {},
    };

    const position = this._findOpenPosition(widget, this._widgets);
    widget.x = position.x;
    widget.y = position.y;
    this._widgets.push(widget);

    this._saveWidgets();
    this._rebuildWidgets();
  };

  removeWidget(id) {
    this._cancelActiveDrag();
    this._widgets = this._widgets.filter(widget => widget.id !== id);
    this._destroyWidgetView(id);
    this._resolveLayout(null, false, true);
    this._saveWidgets();
  };

  _destroyWidgetView(id) {
    const view = this._views.get(id);

    if (!view) {
      return;
    };

    view.sizeMenu?.destroy();
    this._destroyContextMenu(view);
    view.editBorder?.destroy();
    view.removeButton?.destroy();
    view.pinButton?.destroy();
    view.sizeButton?.destroy();
    view.photoButton?.destroy();
    view.actor.disconnectObject(this);
    view.actor.destroy();

    this._views.delete(id);
  };

  togglePin(id) {
    const widget = this._widgets.find(item => item.id === id);

    if (!widget) {
      return;
    };

    widget.pinned = !widget.pinned;
    this._saveWidgets();
    
    // Sync the visual state after save completes and any potential rebuilds settle.
    if (this._pinSyncId) {
      GLib.source_remove(this._pinSyncId);
    };

    this._pinSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
      this._pinSyncId = 0;
      this._syncPinButtonState(id);
      return GLib.SOURCE_REMOVE;
    });
  };

  _syncPinButtonState(id) {
    const view = this._views.get(id);
    const widget = this._widgets.find(item => item.id === id);
    
    if (!view?.pinButton || !widget) {
      return;
    };
    
    if (widget.pinned) {
      view.pinButton.set_style('background-color: #5b9de0; color: #ffffff; border-color: #5b9de0;');
    } else {
      view.pinButton.set_style(null);
    };
  };

  _onArrangeRequested() {
    if (this._layoutSettings.get_boolean('arrange-widgets')) {
      this._arrangeWidgets();
      this._layoutSettings.set_boolean('arrange-widgets', false);
    };
  };

  _arrangeWidgets() {
    if (!this._layer) {
      return;
    };

    const gap = this._widgetGap ?? WIDGET_GAP;
    const layerX = this._layerX ?? 0;
    const layerY = this._layerY ?? 0;
    const monitors = effectiveMonitors();

    if (!monitors.length) {
      return;
    };

    const movableByMonitor = new Map();

    for (const widget of this._widgets) {
      if (widget.pinned) {
        continue;
      };

      const [width, height] = this._sizeFor(widget);
      const monitor = monitorAtStage(
        monitors,
        widget.x + layerX + width / 2,
        widget.y + layerY + height / 2) ?? monitors[0];

      if (!movableByMonitor.has(monitor)) {
        movableByMonitor.set(monitor, []);
      };

      movableByMonitor.get(monitor).push(widget);
    };

    for (const [monitor, movable] of movableByMonitor) {
      const monX = monitor.x - layerX;
      const monY = monitor.y - layerY;
      const minY = monY + topYFor(monitor) + gap;
      const widths = [...new Set(movable.map(widget => this._sizeFor(widget)[0]))].sort((a, b) => a - b);
      const columns = [];
      let colX = monX + gap;

      for (const width of widths) {
        columns.push({width, x: colX, widgets: []});
        colX += width + gap;
      };

      for (const widget of movable) {
        const column = columns.find(col => col.width === this._sizeFor(widget)[0]);

        if (column) {
          column.widgets.push(widget);
        };
      };

      for (const column of columns) {
        column.widgets.sort((a, b) => (a.y - b.y) || (a.x - b.x));
        let y = minY;

        for (const widget of column.widgets) {
          const [width, height] = this._sizeFor(widget);

          widget.x = clamp(column.x, monX + gap, Math.max(monX + gap, monX + monitor.width - width - gap));
          widget.y = clamp(y, minY, Math.max(minY, monY + monitor.height - height - gap));
          y += height + gap;
        };
      };
    };

    this._saveWidgets();
    this._rebuildWidgets();
  };

  _nearestCandidate(value, candidates) {
    let nearest = value;
    let bestDistance = SNAP_DISTANCE;

    for (const candidate of candidates) {
      if (!Number.isFinite(candidate)) {
        continue;
      };

      const distance = Math.abs(value - candidate);

      if (distance <= bestDistance) {
        bestDistance = distance;
        nearest = candidate;
      };
    };

    return nearest;
  };

  _snapEdges(widget, x, y) {
    const [width, height] = this._sizeFor(widget);
    const layerX = this._layerX ?? 0;
    const layerY = this._layerY ?? 0;
    const gap = this._widgetGap ?? WIDGET_GAP;
    const monitor = monitorAtStage(
      effectiveMonitors(),
      x + layerX + width / 2,
      y + layerY + height / 2);

    const xCandidates = [(monitor?.x ?? layerX) - layerX + gap];
    const yCandidates = [(monitor?.y ?? layerY) - layerY + topYFor(monitor) + gap];

    if (monitor) {
      xCandidates.push(monitor.x - layerX + monitor.width - gap - width);
      yCandidates.push(monitor.y - layerY + monitor.height - gap - height);
    };

    for (const other of this._widgets) {
      if (other === widget) {
        continue;
      };

      const [ow, oh] = this._sizeFor(other);

      xCandidates.push(other.x - gap, other.x + ow + gap, other.x + ow - width + gap);
      yCandidates.push(other.y - gap, other.y + oh + gap, other.y + oh - height + gap);
    };

    return {
      x: this._nearestCandidate(x, xCandidates),
      y: this._nearestCandidate(y, yCandidates),
    };
  };

  _snapToNearestEdge(widget) {
    const gap = this._widgetGap ?? WIDGET_GAP;
    const layerX = this._layerX ?? 0;
    const layerY = this._layerY ?? 0;
    const [width, height] = this._sizeFor(widget);
    const widgetRect = this._rectFor(widget);
    const monitor = monitorAtStage(
      effectiveMonitors(),
      widget.x + layerX + width / 2,
      widget.y + layerY + height / 2);

    // Find a widget to intersect with. A pinned widget works as a target:
    // it stays put, so the dragged widget snaps next to it.
    const overlapping = this._widgets.find(other =>
      other !== widget && rectsOverlap(widgetRect, this._rectFor(other), gap));

    if (!overlapping) {
      return {x: widget.x, y: widget.y};
    };

    const [ow, oh] = this._sizeFor(overlapping);

    // Four positions along the snapped widget's edge: left, right, top, bottom.
    const candidates = [
      {x: overlapping.x - width - gap, y: widget.y},
      {x: overlapping.x + ow + gap, y: widget.y},
      {x: widget.x, y: overlapping.y - height - gap},
      {x: widget.x, y: overlapping.y + oh + gap},
    ];

    // A candidate must fit on the monitor with the gap inset: otherwise,
    // after clamping it slides back onto the snapped stack and keeps overlapping.
    const minX = (monitor?.x ?? layerX) - layerX + gap;
    const minY = (monitor?.y ?? layerY) - layerY + topYFor(monitor) + gap;
    const maxX = monitor ? Math.max(minX, monitor.x - layerX + monitor.width - width - gap) : Infinity;
    const maxY = monitor ? Math.max(minY, monitor.y - layerY + monitor.height - height - gap) : Infinity;
    const inBounds = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;

    // Nearest open position by Manhattan distance from the drop point.
    let best = null;
    let bestDistance = Infinity;

    for (const candidate of candidates) {
      if (!inBounds(candidate.x, candidate.y)) {
        continue;
      };

      if (!this._positionIsFreeAgainst(widget, candidate.x, candidate.y, this._widgets)) {
        continue;
      };

      const distance = Math.abs(candidate.x - widget.x) + Math.abs(candidate.y - widget.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      };
    };

    // If all four edges are taken or out of bounds, find any free cell on the monitor grid.
    if (!best) {
      return this._findOpenPosition(widget, this._widgets);
    };

    return {x: best.x, y: best.y};
  };

  // Spread the "stack" (a dense vertical column or horizontal row)
  // to make room for a widget without dropping it into a free cell:
  // the middle (pinned / anchor) widget stays, the rest are pushed apart.
  _spaceOut(widget, pool, anchorTarget = null) {
    if (!this._layer || pool.length < 2) {
      return [];
    };

    const gap = this._widgetGap ?? WIDGET_GAP;
    const layerX = this._layerX ?? 0;
    const layerY = this._layerY ?? 0;
    const rect = this._rectFor(widget);
    const monitor = monitorAtStage(
      effectiveMonitors(),
      widget.x + layerX + rect.width / 2,
      widget.y + layerY + rect.height / 2);

    if (!monitor) {
      return [];
    };

    const others = pool.filter(other => other !== widget);

    // Vertical stack: widgets in the same column (overlapping X projections).
    const columnMates = others.filter(other => {
      const otherRect = this._rectFor(other);

      return rect.x < otherRect.x + otherRect.width && rect.x + rect.width > otherRect.x;
    });

    if (columnMates.length) {
      const column = this._tightRun(widget, columnMates, 'y');
      const moved = this._spaceAxis(column, 'y', monitor, pool, gap, layerX, layerY, anchorTarget);

      if (moved.length) {
        return moved;
      };
    };

    // Horizontal row: widgets in the same row (overlapping Y projections).
    const rowMates = others.filter(other => {
      const otherRect = this._rectFor(other);

      return rect.y < otherRect.y + otherRect.height && rect.y + rect.height > otherRect.y;
    });

    if (rowMates.length) {
      const row = this._tightRun(widget, rowMates, 'x');
      const moved = this._spaceAxis(row, 'x', monitor, pool, gap, layerX, layerY, anchorTarget);

      if (moved.length) {
        return moved;
      };
    };

    return [];
  };

  // Dense uninterrupted chain of widgets around the anchor along the axis:
  // neighbors touching each other with a spacing no larger than the gap.
  _tightRun(widget, mates, axis) {
    const gap = this._widgetGap ?? WIDGET_GAP;
    const group = [...mates, widget];

    group.sort((a, b) => {
      const da = axis === 'y' ? a.y : a.x;
      const db = axis === 'y' ? b.y : b.x;

      return (da - db) || (axis === 'y' ? (a.x - b.x) : (a.y - b.y));
    });

    const index = group.indexOf(widget);
    const coord = w => axis === 'y' ? w.y : w.x;
    const sizeOf = w => {
      const rect = this._rectFor(w);

      return axis === 'y' ? rect.height : rect.width;
    };

    let start = index;
    let end = index;

    while (end + 1 < group.length &&
      coord(group[end]) + sizeOf(group[end]) + gap >= coord(group[end + 1])) {
      end += 1;
    };
    while (start - 1 >= 0 &&
      coord(group[start - 1]) + sizeOf(group[start - 1]) + gap >= coord(group[start])) {
      start -= 1;
    };

    return group.slice(start, end + 1);
  };

  // Rearrange the stack members along the axis so every spacing becomes exact.
  // The anchor (middle / pinned / anchorTarget) stays; if there is no room
  // on one side it moves to the edge; if nothing fits at all,
  // surplus widgets are ejected into free cells (_findOpenPosition).
  _spaceAxis(members, axis, monitor, pool, gap, layerX, layerY, anchorTarget) {
    const coord = widget => axis === 'y' ? widget.y : widget.x;
    const setCoord = (widget, value) => {
      if (axis === 'y') {
        widget.y = value;
      } else {
        widget.x = value;
      };
    };
    const sizeOf = widget => {
      const rect = this._rectFor(widget);

      return axis === 'y' ? rect.height : rect.width;
    };

    const sizes = members.map(sizeOf);
    const n = members.length;
    const min = axis === 'y'
      ? monitor.y - layerY + topYFor(monitor) + gap
      : monitor.x - layerX + gap;
    const max = axis === 'y'
      ? monitor.y - layerY + monitor.height - gap
      : monitor.x - layerX + monitor.width - gap;
    const pinnedIndexes = members
      .map((widget, index) => widget.pinned ? index : -1)
      .filter(index => index >= 0);

    if (pinnedIndexes.length > 1) {
      return [];
    };

    let anchorIndex = pinnedIndexes[0]
      ?? (anchorTarget ? members.indexOf(anchorTarget) : null)
      ?? Math.floor((n - 1) / 2);

    if (!Number.isInteger(anchorIndex) || anchorIndex < 0 || anchorIndex >= n) {
      return [];
    };

    const positions = new Array(n);

    const place = (start, end) => {
      positions[anchorIndex] = coord(members[anchorIndex]);

      for (let i = anchorIndex - 1; i >= start; i--) {
        positions[i] = positions[i + 1] - gap - sizes[i];
      };
      for (let i = anchorIndex + 1; i <= end; i++) {
        positions[i] = positions[i - 1] + sizes[i - 1] + gap;
      };

      return {
        overflowLow: positions[start] < min,
        overflowHigh: positions[end] + sizes[end] > max,
      };
    };

    let start = 0;
    let end = n - 1;
    let placed = place(start, end);

    if (pinnedIndexes.length === 0) {
      if (placed.overflowLow && placed.overflowHigh) {
        // Nothing fits on either side: anchor to the edge, surplus goes free.
        anchorIndex = start;
        placed = place(start, end);
      } else if (placed.overflowLow) {
        // No room top/left: the edge widget stays, the rest move away from it.
        anchorIndex = start;
        placed = place(start, end);
      } else if (placed.overflowHigh) {
        // No room bottom/right: the edge widget stays, the rest move away from it.
        anchorIndex = end;
        placed = place(start, end);
      };
    };

    while (placed.overflowLow && start < anchorIndex) {
      start += 1;
      placed = place(start, end);
    };
    while (placed.overflowHigh && end > anchorIndex) {
      end -= 1;
      placed = place(start, end);
    };

    if (placed.overflowLow || placed.overflowHigh) {
      return [];
    };

    // Validation: new positions must not overlap widgets outside the stack.
    const outside = pool.filter(member => !members.includes(member));

    for (let i = start; i <= end; i++) {
      const member = members[i];
      const probe = {
        x: axis === 'y' ? member.x : positions[i],
        y: axis === 'y' ? positions[i] : member.y,
        width: this._rectFor(member).width,
        height: this._rectFor(member).height,
      };

      if (outside.some(other => rectsOverlap(probe, this._rectFor(other), gap))) {
        return [];
      };
    };

    const moved = [];

    for (let i = start; i <= end; i++) {
      const member = members[i];

      if (coord(member) !== positions[i]) {
        setCoord(member, positions[i]);
        moved.push(member);
      };
    };

    // Ejected members drop into the nearest free cell.
    for (let i = 0; i < n; i++) {
      if (i >= start && i <= end) {
        continue;
      };

      const evicted = members[i];
      const position = this._findOpenPosition(evicted, pool);

      evicted.x = position.x;
      evicted.y = position.y;
      moved.push(evicted);
    };

    return moved;
  };

  _rebuildWidgets() {
    if (!this._layer) {
      return;
    };

    this._cancelActiveDrag();
    this._clearViews();
    this._layer.destroy_all_children();

    this._resolveLayout(null, false, true);

    for (const widget of this._widgets) {
      try {
        this._createWidget(widget);
      } catch (error) {
        warn('widget-create-failed', `Failed to create ${widget.type}: ${error.message}\n${error.stack}`);
      };
    };

    this._syncGlass();

    // Force layer relayout to ensure actors have allocation before glass updates
    if (this._layer) {
      this._layer.queue_relayout();
    }

    // Glass geometry needs no retry timers: the panes are per-widget child
    // actors now (lib/glass.js) and follow their own allocation signals.
  };

  // Helper: get the currently active stacked page entry, or null if on primary page
  _getActiveStackEntry(view) {
    if (!view?._stackPrism?.getActivePage || !Array.isArray(view.widget.stack)) {
      return null;
    };
    
    const activePage = view._stackPrism.getActivePage();
    if (activePage === 0) {
      return null; // Primary page, not a stack entry
    };
    
    // Map page index back to entry (pages are sorted: above first, then below)
    const entries = view.widget.stack;
    const aboveEntries = entries.filter(e => e.side === 'above');
    const belowEntries = entries.filter(e => (e.side ?? 'below') !== 'above');
    const sortedEntries = [...aboveEntries, ...belowEntries];
    const entryIndex = activePage - 1;
    
    return sortedEntries[entryIndex] ?? null;
  };

  // Get the effective size for edit controls (active stack page or widget size)
  _getEffectiveSize(view) {
    const activeEntry = this._getActiveStackEntry(view);
    return activeEntry?.size || view.widget.size;
  };

  _onWidgetSizeChange(widget, sizeKey) {
    if (!widget || !WIDGET_SIZE_KEYS.has(sizeKey)) {
      return;
    };

    if (widget.size === sizeKey) {
      return;
    };

    const [prevW, prevH] = this._sizeFor(widget);
    widget.size = sizeKey;
    this._syncWidgetSizeClass(widget);
    this._clampWidget(widget);
    this._resolveLayout(widget, true, true);
    this._animateWidget(widget, true);
  };

  // The styled content box carries a size-specific class (widget-<type>-<size>);
  // resizing keeps the same actor, so the class has to follow the new size.
  _syncWidgetSizeClass(widget) {
    const box = this._views.get(widget.id)?.box;

    if (!box) {
      return;
    };

    const base = `widget-${widget.type}`;
    box.set_style_class_name(`widget ${base} ${base}-${widget.size ?? 'default'}`);
  };

  _setWidgetSize(widget, sizeKey) {
    if (!widget || !WIDGET_SIZE_KEYS.has(sizeKey)) {
      return;
    };

    const view = this._views.get(widget.id);
    
    // Check if this is a container with stacked widgets
    const hasStack = Array.isArray(widget.stack) && widget.stack.length > 0;
    
    if (hasStack) {
      // Container mode: change size of ALL widgets (main + stack)
      if (widget.size === sizeKey) {
        // Check if all stack entries already have this size
        const allSameSize = widget.stack.every(entry => entry.size === sizeKey);
        if (allSameSize) {
          return; // Already this size for all widgets
        }
      }
      
      // Change main widget size
      widget.size = sizeKey;
      widget.data = {...(widget.data ?? {}), sizeManual: true};

      // Change ALL stack entries to the same size
      for (const entry of widget.stack) {
        entry.size = sizeKey;
      }
      
      this._syncWidgetSizeClass(widget);
      view?.sizeMenu?.close();
      this._clampWidget(widget);
      this._resolveLayout(widget, true, true);
      this._animateWidget(widget, true);
      this._saveWidgets();
      
      // Completely rebuild the widget and stack with new sizes
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 280, () => {
        const currentView = this._views.get(widget.id);
        if (!currentView || !currentView.body) {
          return GLib.SOURCE_REMOVE;
        };

        // Update box and glass sizes
        const [wrapperW, wrapperH] = currentView.actor?.get_size() ?? [0, 0];
        if (currentView.box && wrapperW > 0 && wrapperH > 0) {
          currentView.box.set_size(wrapperW, wrapperH);
        };

        if (currentView.glass && wrapperW > 0 && wrapperH > 0) {
          currentView.glass.set_size(wrapperW, wrapperH);
          const [gsx, gsy] = currentView.actor.get_transformed_position();
          if (Number.isFinite(gsx) && Number.isFinite(gsy)) {
            currentView.glass.setGeometry(gsx, gsy, wrapperW, wrapperH);
          };
        };

        // Stacked pages follow the new size: drop them here, the refill
        // below re-mounts them (on the page that was showing).
        this._disposeStack(currentView);
        
        // Re-render the main widget with the new size
        this._safeFillWidgetBody(widget, currentView.body);

        return GLib.SOURCE_REMOVE;
      });
      
      return;
    };

    // Single widget: standard size change
    if (widget.size === sizeKey) {
      return;
    };

    // Primary widget size change
    const [prevW, prevH] = this._sizeFor(widget);
    widget.size = sizeKey;
    widget.data = {...(widget.data ?? {}), sizeManual: true};
    this._syncWidgetSizeClass(widget);
    view?.sizeMenu?.close();
    this._clampWidget(widget);
    this._resolveLayout(widget, true, true);
    this._animateWidget(widget, true);
    this._saveWidgets();

    // The old body stays put during the ease (clip_to_allocation makes it
    // reflow smoothly with the box). Re-render once the ease has fully
    // settled so fonts and internals land on final allocations.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
      const currentView = this._views.get(widget.id);

      if (!currentView || !currentView.body) {
        return GLib.SOURCE_REMOVE;
      };

      const [wrapperW, wrapperH] = currentView.actor?.get_size() ?? [0, 0];
      const [boxW, boxH] = currentView.box?.get_size() ?? [0, 0];

      // Force-sync children to the settled wrapper size (notify hooks miss).
      if (currentView.box && wrapperW > 0 && wrapperH > 0) {
        currentView.box.set_size(wrapperW, wrapperH);
      };

      if (currentView.glass && wrapperW > 0 && wrapperH > 0) {
        currentView.glass.set_size(wrapperW, wrapperH);
        const [gsx, gsy] = currentView.actor.get_transformed_position();

        if (Number.isFinite(gsx) && Number.isFinite(gsy)) {
          currentView.glass.setGeometry(gsx, gsy, wrapperW, wrapperH);
        };
      };

      this._safeFillWidgetBody(widget, currentView.body);

      return GLib.SOURCE_REMOVE;
    });
  };

  _refreshWidgets() {
    if (this._dragActor) {
      return;
    };

    this._refreshWeather(false);

    // Stacked pages of refreshable types are re-rendered in place too.
    const REFRESHABLE = ['battery', 'calendar', 'digitalclock', 'photos', 'weather', 'github', 'system', 'clock', 'binaryclock'];
    for (const view of this._views.values())
      view._stackPrism?.refill?.(type => REFRESHABLE.includes(type));

    for (const [id, view] of this._views) {
      if (!['battery', 'calendar', 'digitalclock', 'photos', 'weather', 'github', 'system', 'clock', 'binaryclock'].includes(view.widget.type)) {
        continue;
      };

      try {
        // The wrapper refactor moved the body into the styled content box:
        // view.actor is the outer wrapper, view.box is the BoxLayout that
        // owns the body. Comparing body.parent to the wrapper was ALWAYS
        // false, so every refresh dropped 3 of 4 views and left only the
        // last-touched widget editable until a rebuild.
        if (view.actor.get_parent() !== this._layer || view.body.get_parent() !== view.box) {
          view.actor.disconnectObject(this);
          this._views.delete(id);
          continue;
        };

        // A render error is NOT a stale view: log it and keep the view.
        // Dropping it here disconnected its drag/context-menu handlers, so
        // one failing refresh (e.g. after a calendar setting change) left
        // the widget impossible to drag until the next rebuild.
        this._safeFillWidgetBody(view.widget, view.body);
      } catch (error) {
        warn('stale-widget-view', `Dropping stale widget view: ${error.message}`);
        view.actor.disconnectObject(this);
        this._views.delete(id);
      };
    };
  };

  _createWidget(widget) {
    if (widget.type === 'photos' && !widget.data?.sizeManual) {
      widget.size = PhotosWidget.preferredSize(this._layoutSettings, widget);
    };

    const [width, height] = this._sizeFor(widget);
    const actorParams = boxLayoutProps({
      vertical: true,
      // Size-specific class (widget-system-small …): some widgets style
      // differently per size (system 1x1 reserves room for the page dashes).
      // _syncWidgetSizeClass keeps it in step when the widget resizes.
      style_class: `widget widget-${widget.type} widget-${widget.type}-${widget.size ?? 'default'}`,
      reactive: true,
      can_focus: true,
      track_hover: true,
    });
    const style = this._styleForWidget(widget);

    if (style) {
      actorParams.style = style;
    };

    // Wrapper: a plain St.Widget (fixed layout) so the glass backdrop and the
    // widget content OVERLAP at (0,0). A vertical BoxLayout would hand each
    // of them its own horizontal band instead.
    const wrapper = new St.Widget({
      reactive: true,
      can_focus: true,
      track_hover: true,
      clip_to_allocation: true,
    });

    const actor = new St.BoxLayout(actorParams);
    actor.set_size(width, height);

    const opacity = this._layoutSettings.get_double('style-widget-opacity');
    wrapper.opacity = Math.round(clamp(opacity, 0, 1) * 255);

    // Apply border-radius and clipping to the outer wrapper. In solid mode the
    // wrapper must stay opaque so the card does not leak the wallpaper through
    // the rounded edges; in glass mode it stays transparent so the LiquidGlass
    // backdrop remains visible underneath.
    const theme = this._gnomeTheme();
    const radius = theme.radius;
    if (radius > 0) {
      const wrapperBg = theme.isSolid ? theme.background : 'rgba(0,0,0,0)';
      wrapper.set_style(`border-radius: ${radius}px; overflow: hidden; background-color: ${wrapperBg};`);
    }

    // Add glass as first child (backdrop) if widget uses glass effect
    const isGlass = this._layoutSettings.get_int('style-mode') === 0;
    const usesGlass = isGlass && !this._widgetSkipsGlass(widget);
    let glass = null;

    if (usesGlass) {
      glass = new LiquidGlass();
      glass.set_size(width, height);
      wrapper.add_child(glass);
    }

    const body = new St.BoxLayout(boxLayoutProps({
      vertical: true,
      style_class: 'widget-body',
      x_expand: true,
      y_expand: true,
      clip_to_allocation: true,
    }));
    actor.add_child(body);

    wrapper.add_child(actor);

    wrapper.set_size(width, height);
    wrapper.set_position(widget.x, widget.y);
    this._layer.add_child(wrapper);

    const view = {
      widget,
      actor: wrapper,
      box: actor,
      body,
      glass,
      draggable: false,
      editBorder: null,
      removeButton: null,
      pinButton: null,
      sizeButton: null,
      sizeMenu: null,
      photoButton: null,
    };
    this._views.set(widget.id, view);

    // Setup glass update listeners (shared with photo glass re-adds)
    if (glass) {
      this._attachGlassListeners(view);
    }

    if (this._editMode) {
      this._makeDraggable(view);
      this._addEditControls(view);
    };

    this._safeFillWidgetBody(widget, body);
  };

  // Coalesces a burst of geometry-triggering signals into ONE glass sync.
  // A drag move fires notify::x/y (and sometimes width/allocation) per
  // pointer event; each used to run a full LiquidGlass sweep — uniforms,
  // wallpaper reposition and a queue_repaint — for the wrapper pane AND
  // every stacked page pane. Flushing once per main-loop iteration caps
  // that at one repaint per frame regardless of pointer-event rate.
  _queueGlassGeometrySync(view) {
    if (view._glassSyncQueued) {
      return;
    };
    view._glassSyncQueued = true;
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      view._glassSyncQueued = false;
      if (!this._views.has(view.widget.id) || isActorDestroyed(view.actor)) {
        return GLib.SOURCE_REMOVE;
      };
      this._updateGlassGeometryForView(view);
      this._updateStackGlassGeometry(view);
      return GLib.SOURCE_REMOVE;
    });
  };

  _updateGlassGeometryForView(view) {
    if (!view.glass || !view.actor) return;

    const [width, height] = view.actor.get_size();
    const [stageX, stageY] = view.actor.get_transformed_position();

    if (width > 0 && height > 0 && Number.isFinite(stageX) && Number.isFinite(stageY)) {
      // Glass and content box both track the wrapper's size exactly, so the
      // shader's squircle matches the widget's own border-radius footprint.
      view.glass.set_size(width, height);
      if (view.box) view.box.set_size(width, height);
      view.glass.setGeometry(stageX, stageY, width, height);
      return true;
    }

    return false;
  }

  /**
   * Keeps calling _updateGlassGeometryForView until the wrapper has a real
   * allocation (finite stage coords), capped at ~3 s. Without this the glass
   * can stay fully transparent right after shell startup, when the first
   * allocation lands before every notify signal has a listener attached.
   */
  _ensureGlassGeometry(view, attempt = 0) {
    if (!this._views.has(view.widget.id) || !view.glass || !view.actor) {
      return;
    };

    if (this._updateGlassGeometryForView(view)) {
      return;
    };

    if (attempt >= 30) {
      return;
    };

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      this._ensureGlassGeometry(view, attempt + 1);
      return GLib.SOURCE_REMOVE;
    });
  }

  _updateGlassParamsForView(view) {
    if (!view.glass) return;

    view.glass.setParams(this._glassParamsFor());
  }

  // One source of truth for glass parameters: the wrapper panes of primary
  // widgets AND the stacked pages' panes through attachWidgetStack's
  // glassParams() callback. Slider changes stay live for both.
  _glassParamsFor() {
    const s = this._layoutSettings;
    const systemIsDark = this._interfaceSettings?.get_string('color-scheme') === 'prefer-dark';
    const dark = this._widgetDark();
    const colors = macColors(0, dark ? 0 : 1, systemIsDark);

    // The custom background colour doubles as the glass tint when set
    const background = s.get_string('style-background').trim();
    let tint = colors.glassTint;
    let tintAlpha = s.get_int('tint-alpha-pct') / 100;

    if (background && /^(#[0-9a-fA-F]{3,8}|rgba?\(.+\))$/.test(background)) {
      tint = parseCssColor(background);
      if (typeof tint.a === 'number')
        tintAlpha *= tint.a;
    } else if (colors.glassIsLight) {
      // Light glass must stay a light surface over dark wallpapers: the 10%
      // default white tint alone left near-black text unreadable. The slider
      // still wins when it is set above the floor.
      tintAlpha = Math.max(tintAlpha, 0.45);
    }

    return {
      radius: s.get_int('style-border-radius'),
      roundness: 2, // Match CSS border-radius used by the widget frame.
      refractThickness: s.get_int('refract-thickness'),
      refractIOR: s.get_int('refract-ior-x100') / 100,
      refractScale: s.get_int('refract-scale'),
      chromaStrength: s.get_int('chroma-strength-pct') / 100,
      tint,
      tintAlpha,
      specStrength: s.get_int('spec-strength-pct') / 100,
      blurRadius: s.get_int('blur-radius-px'),
      solid: false,
    };
  }

  /**
   * Re-applies the actor style of every live widget without rebuilding it, so a
   * glass slider changes the tint while it is still being dragged.
   */
  _restyleWidgets() {
    for (const [id, view] of this._views) {
      if (view.actor.get_parent() !== this._layer) {
        view.actor.disconnectObject(this);
        this._views.delete(id);
        continue;
      };

      const style = this._styleForWidget(view.widget);
      // The visual style lives on the content box, not on the wrapper.
      const styled = view.box ?? view.actor;

      if (style) styled.set_style(style);

      view._stackPrism?.restyle?.();
    };

    this._updateAllGlassParams();
  };

  /**
   * Updates glass parameters for all widgets (used when glass settings change)
   */
  _updateAllGlassParams() {
    for (const view of this._views.values()) {
      if (view.glass) {
        this._updateGlassParamsForView(view);
      }

      // Slider drags reach the stacked pages without a rebuild: restyle()
      // re-derives each page card's skin and re-arms its glass pane params.
      view._stackPrism?.restyle?.();
    }
  }

  /**
   * Legacy method - now glass is managed per-widget, not globally
   */
  _syncGlass() {
    // Glass is now a child actor of each widget, no sync needed
    this._updateAllGlassParams();
  };

  // Wires size/geometry/pointer plumbing between the wrapper and the
  // view-level LiquidGlass pane. Used at creation and whenever a photo
  // widget gains a glass pane dynamically (placeholder <-> photo switch).
  _attachGlassListeners(view) {
    const {widget, actor: wrapper, box: actor, glass} = view;

    if (!view.glass) {
      return;
    };

    // Re-attaching (the photos widget toggles glass off/on) must not
    // accumulate duplicate geometry handlers: drop the previous set first.
    if (view._glassListenerIds) {
      for (const id of view._glassListenerIds) {
        try {
          wrapper.disconnect(id);
        } catch (error) {
          // Handler already gone with the wrapper.
        };
      };
    };
    view._glassListenerIds = [];
    const track = (signal, callback) => {
      view._glassListenerIds.push(wrapper.connect(signal, callback));
    };

    this._updateGlassParamsForView({glass: view.glass, widget, actor});
    this._updateGlassGeometryForView(view);

    // Stacked pages hang inside the wrapper: when the wrapper moves or is
    // re-laid-out, their glass wallpaper panes must re-align with it. The
    // x/y signals fire per pointer event during a drag; each of them used
    // to run a FULL liquid-glass sync (uniforms + wallpaper reposition +
    // repaint) for the wrapper pane and every stacked page pane — on a
    // stacked widget that is 3–4 blur repaints per motion event, which is
    // exactly what made stacked widgets stutter while being dragged. The
    // queue coalesces such bursts into one pass per main-loop iteration.
    track('notify::x', () => this._queueGlassGeometrySync(view));
    track('notify::y', () => this._queueGlassGeometrySync(view));
    track('notify::width', () => this._queueGlassGeometrySync(view));
    track('notify::height', () => this._queueGlassGeometrySync(view));
    track('notify::allocation', () => {
      this._updateGlassGeometryForView(view);
      this._updateStackGlassGeometry(view);
      this._queueGlassGeometrySync(view);
    });

    // Pointer tracking for specular highlights (reads view.glass late, so it
    // is safe while the pane is being added or removed).
    track('motion-event', (_a, event) => {
      const pane = view.glass;
      if (!pane) return Clutter.EVENT_PROPAGATE;
      const [sx, sy] = event.get_coords();
      const [ok, lx, ly] = wrapper.transform_stage_point(sx, sy);
      const [w, h] = wrapper.get_size();
      if (ok && w > 0 && h > 0) {
        pane.setPointer(lx / w, ly / h, wrapper.hover ? 1 : 0);
      }
      return Clutter.EVENT_PROPAGATE;
    });

    track('notify::hover', () => {
      if (view.glass) view.glass.setPointer(-1, -1, wrapper.hover ? 1 : 0);
    });

    // Shell startup may allocate the layer before the signals above settle;
    // keep polling until valid geometry has been applied at least once.
    this._ensureGlassGeometry(view);
  }

  // Follows the stacked pages' glass panes after wrapper-level moves and
  // size changes (the panes' stage rects derive from the wrapper's own).
  _updateStackGlassGeometry(view) {
    view._stackPrism?.updateGlassGeometry?.();
  };

  // Adds or removes the view-level glass pane for one widget without a full
  // rebuild — currently used by the photos widget (glass only while the
  // "Select photo" placeholder is showing, never behind a photo frame).
  _syncWidgetGlass(widget) {
    const view = this._views.get(widget.id);

    if (!view?.actor) {
      return;
    };

    const isGlass = this._layoutSettings.get_int('style-mode') === 0;
    const wantsGlass = isGlass && !this._widgetSkipsGlass(widget);
    const [width, height] = this._sizeFor(widget);

    if (wantsGlass && !view.glass) {
      const glass = new LiquidGlass();
      glass.set_size(width, height);
      view.actor.insert_child_at_index(glass, 0);
      view.glass = glass;
      this._attachGlassListeners(view);
      this._updateAllGlassParams();
    } else if (!wantsGlass && view.glass) {
      view.glass.destroy();
      view.glass = null;
    }
  };

  _safeFillWidgetBody(widget, body) {
    if (!body) {
      return;
    };

    try {
      this._fillWidgetBody(widget, body);
    } catch (error) {
      logError(error, `Widget fill failed: ${widget.type}/${widget.size ?? 'default'}`);
      warn('widget-render-failed', `Failed to render ${widget.type}: ${error.message}\n${error.stack}`);
    };
  };

  _pinButtonPosition(widget) {
    return {
      x: widget.x + 8,
      y: widget.y + 8,
    };
  };

  _sizeButtonPosition(widget, sizeButton) {
    const pin = this._pinButtonPosition(widget);

    if (!sizeButton) {
      return {x: pin.x, y: pin.y};
    };

    sizeButton.ensure_style();
    const [, buttonWidth] = sizeButton.get_preferred_width(-1);

    return {
      x: pin.x + buttonWidth + 8,
      y: pin.y,
    };
  };

  _removeButtonPosition(widget, removeButton) {
    const [width] = this._sizeFor(widget);

    removeButton.ensure_style();
    const [, buttonWidth] = removeButton.get_preferred_width(-1);

    return {
      x: widget.x + width - buttonWidth - 8,
      y: widget.y + 8,
    };
  };

  _photoButtonPosition(widget, photoButton) {
    const pin = this._pinButtonPosition(widget);

    if (!photoButton) {
      return {x: pin.x, y: pin.y};
    };

    photoButton.ensure_style();
    const [, buttonHeight] = photoButton.get_preferred_height(-1);

    return {
      x: pin.x,
      y: pin.y + buttonHeight + 8,
    };
  };

  _syncEditControls(widget, animate = false) {
    const view = this._views.get(widget.id);

    if (!view?.editBorder && !view?.removeButton) {
      return;
    };

    // For stacked widgets, use the active page's size for edit controls
    const effectiveSize = this._getEffectiveSize(view);
    const effectiveWidget = effectiveSize !== widget.size 
      ? {...widget, size: effectiveSize}
      : widget;

    const overlay = this._rectFor(effectiveWidget);
    const button = this._removeButtonPosition(effectiveWidget, view.removeButton);
    const pin = this._pinButtonPosition(effectiveWidget);
    const size = this._sizeButtonPosition(effectiveWidget, view.sizeButton);
    const photo = this._photoButtonPosition(effectiveWidget, view.photoButton);
    
    if (animate) {
      view.editBorder?.ease({
        x: overlay.x,
        y: overlay.y,
        width: overlay.width,
        height: overlay.height,
        duration: 130,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });

      view.removeButton?.ease({
        x: button.x,
        y: button.y,
        duration: 130,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });

      view.pinButton?.ease({
        x: pin.x,
        y: pin.y,
        duration: 130,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });

      view.sizeButton?.ease({
        x: size.x,
        y: size.y,
        duration: 130,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });

      view.photoButton?.ease({
        x: photo.x,
        y: photo.y,
        duration: 130,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    } else {
      view.editBorder?.set_position(overlay.x, overlay.y);
      view.editBorder?.set_size(overlay.width, overlay.height);
      view.removeButton?.set_position(button.x, button.y);
      view.pinButton?.set_position(pin.x, pin.y);
      view.sizeButton?.set_position(size.x, size.y);
      view.photoButton?.set_position(photo.x, photo.y);
    };

    if (view.editBorder) {
      raiseActor(view.editBorder);
    };

    if (view.removeButton) {
      raiseActor(view.removeButton);
    };

    if (view.pinButton) {
      raiseActor(view.pinButton);
    };

    if (view.sizeButton) {
      raiseActor(view.sizeButton);
    };

    if (view.photoButton) {
      raiseActor(view.photoButton);
    };
  };

  _addEditControls(view) {
    const editBorder = new St.Widget({
      style_class: 'widget-edit-border',
      reactive: false,
    });
    editBorder.set_style(
      `border-radius: ${this._layoutSettings.get_int('style-border-radius')}px;` +
      ` border-color: ${this._gnomeTheme().accent};`
    );

    const removeButton = new St.Button({
      style_class: 'icon-button widget-edit-remove',
      icon_name: 'window-close-symbolic',
      reactive: true,
      can_focus: true,
      track_hover: true,
      accessible_name: _('Remove widget'),
    });

    this._layer.add_child(editBorder);

    removeButton.connectObject('clicked', () => this.removeWidget(view.widget.id), this);
    this._layer.add_child(removeButton);

    const pinButton = new St.Button({
      style_class: 'icon-button widget-edit-pin',
      icon_name: 'view-pin-symbolic',
      reactive: true,
      can_focus: true,
      track_hover: true,
      accessible_name: _('Pin widget'),
    });

    // Apply the pinned visual state if the widget is pinned.
    if (view.widget.pinned) {
      if (this._pinStyleIdleId) {
        GLib.source_remove(this._pinStyleIdleId);
      };

      this._pinStyleIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        this._pinStyleIdleId = 0;
        if (pinButton && !isActorDestroyed(pinButton)) {
          pinButton.set_style('background-color: #5b9de0; color: #ffffff; border-color: #5b9de0;');
        }
        return GLib.SOURCE_REMOVE;
      });
    };

    pinButton.connectObject('clicked', () => this.togglePin(view.widget.id), this);
    this._layer.add_child(pinButton);

    const widgetModule = WIDGETS.get(view.widget.type);
    const supportedSizes = widgetModule?.supportedSizes ?? [];
    let sizeButton = null;
    let sizeMenu = null;

    // Show size button if widget supports multiple sizes
    // OR if there are 2+ widgets in stack (main + at least 1 added)
    const hasStack = Array.isArray(view.widget.stack) && view.widget.stack.length > 0;
    const totalWidgets = 1 + (view.widget.stack?.length ?? 0);
    const canResize = supportedSizes.length > 0 || (hasStack && totalWidgets >= 2);

    if (canResize) {
      sizeButton = new St.Button({
        style_class: 'icon-button widget-edit-size',
        icon_name: 'view-grid-symbolic',
        reactive: true,
        can_focus: true,
        track_hover: true,
        accessible_name: _('Widget size'),
      });

      this._layer.add_child(sizeButton);

// The size picker is a real shell PopupMenu — identical to the
// right-click context menu look: popup panel with the arrow, native
// row hover highlight and a DOT ornament on the current size.
sizeMenu = new PopupMenu.PopupMenu(sizeButton, 0.25, St.Side.TOP);
Main.uiGroup.add_child(sizeMenu.actor);
sizeMenu.actor.hide();

// A manager gives the menu the stock dismissal: a press anywhere outside
// the menu (that isn't the picker button) closes it.
const sizeMenuManager = view.sizeMenuManager ?? new PopupMenu.PopupMenuManager(view.actor);
sizeMenuManager.addMenu(sizeMenu);
view.sizeMenuManager = sizeMenuManager;

let sizeMenuDestroyed = false;
let lastAutoClose = 0;
sizeMenu.actor.connect('destroy', () => {
  sizeMenuDestroyed = true;
});
sizeMenu.connect('open-state-changed', (_menu, isOpen) => {
  if (!isOpen) {
    lastAutoClose = Date.now();
  };
});

// Collect all possible sizes from main widget and stack
// For stacked widgets, show all sizes but disable those not supported by all widgets
const allSizes = new Set();
const widgetTypes = [view.widget.type];
if (hasStack) {
  for (const entry of view.widget.stack) {
    if (entry?.type) {
      widgetTypes.push(entry.type);
    }
  }
}

// If widget has native sizes, use them; otherwise use all standard sizes
if (supportedSizes.length > 0) {
  for (const size of supportedSizes) {
    allSizes.add(size);
  }
} else if (hasStack) {
  // For stacked widgets without native sizes, show common sizes
  for (const size of ['small', 'medium', 'large', 'portrait', 'compact']) {
    allSizes.add(size);
  }
}

const sizeMenuItems = new Map();
for (const sizeKey of orderedSizes([...allSizes])) {
  // Check if ALL widgets in the container support this size
  let allSupport = true;
  for (const type of widgetTypes) {
    const mod = WIDGETS.get(type);
    const modSizes = mod?.supportedSizes ?? [];
    if (modSizes.length > 0 && !modSizes.includes(sizeKey)) {
      allSupport = false;
      break;
    }
  }

  const menuItem = new PopupMenu.PopupMenuItem(sizeLabel(sizeKey));
  menuItem.setSensitive(allSupport);
  menuItem.connectObject('activate', () => {
    if (allSupport) {
      this._setWidgetSize(view.widget, sizeKey);
    }
  }, this);
  sizeMenu.addMenuItem(menuItem);
  sizeMenuItems.set(sizeKey, menuItem);
};

sizeButton.connectObject('clicked', () => {
  this._hideContextMenus();

  // Only one menu open at a time.
  for (const otherView of this._views.values()) {
    if (otherView.sizeMenu && otherView.sizeMenu !== sizeMenu && otherView.sizeMenu.isOpen) {
      otherView.sizeMenu.close();
    };
  };

  if (sizeMenu.isOpen) {
    sizeMenu.close();
    return;
  };

  // The manager's own dismissal ran for this same press: reopening here
  // would fight it — treat the press as the close.
  if (Date.now() - lastAutoClose < 300) {
    return;
  };

  // Dot ornament marks the current size
  // For stacked widgets, show the active page's size instead of host widget size
  const currentSize = this._getEffectiveSize(view);
  
  for (const [sizeKey, menuItem] of sizeMenuItems) {
    menuItem.setOrnament(currentSize === sizeKey
      ? PopupMenu.Ornament.DOT
      : PopupMenu.Ornament.NONE);
  };

  sizeMenu.open();
}, this);

sizeButton.connectObject('destroy', () => {
  if (!sizeMenuDestroyed && sizeMenu) {
    sizeMenu.destroy();
  };
}, this);
    };

    let photoButton = null;

    if (view.widget.type === 'photos') {
      photoButton = new St.Button({
        style_class: 'icon-button widget-edit-photo',
        icon_name: 'image-x-generic-symbolic',
        reactive: true,
        can_focus: true,
        track_hover: true,
        accessible_name: _('Change photo'),
      });

      photoButton.connectObject('clicked', () => {
        PhotosWidget.openPhotoChooser(view.widget, path => this._setWidgetPhoto(view.widget, view.body, path));
      }, this);

      this._layer.add_child(photoButton);
    };

    view.editBorder = editBorder;
    view.removeButton = removeButton;
    view.pinButton = pinButton;
    view.sizeButton = sizeButton;
    view.sizeMenu = sizeMenu;
    view.photoButton = photoButton;
    this._syncEditControls(view.widget);
  };

  _openWidgetApp(view) {
    const type = view.widget.type;

    if (type === 'github') {
      const url = GithubWidget.getProfileUrl(view.widget.id);

      if (url) {
        Gio.AppInfo.launch_default_for_uri_async(url, null, null, null);
        return true;
      };

      return false;
    };

    const customKey = WIDGET_CUSTOM_APP_KEYS[type];
    const custom = customKey
      ? this._layoutSettings.get_string(customKey).trim()
      : '';

    if (custom && this._launchCustomApp(custom)) {
      return true;
    };

    for (const appId of WIDGET_APP_IDS[type] ?? []) {
      if (this._activateWidgetApp(appId)) {
        return true;
      };
    };

    return false;
  };

  _activateWidgetApp(appId) {
    const desktopId = appId.endsWith('.desktop') ? appId : `${appId}.desktop`;
    const app = Shell.AppSystem.get_default().lookup_app(desktopId) ??
      Shell.AppSystem.get_default().lookup_app(appId);

    if (app) {
      app.activate();
      return true;
    };

    try {
      const appInfo = Gio.DesktopAppInfo.new(appId) ?? Gio.DesktopAppInfo.new(desktopId);

      if (appInfo) {
        appInfo.launch([], null);
        return true;
      };
    } catch (error) {
      warn('desktop-widgets: failed to launch', `${appId}: ${error}`);
    };

    return false;
  };

  _launchCustomApp(value) {
    if (this._activateWidgetApp(value)) {
      return true;
    };

    try {
      const [ok, argv] = GLib.shell_parse_argv(value);

      if (ok && argv && argv.length > 0) {
        Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        return true;
      };
    } catch (error) {
      warn('desktop-widgets: failed to run custom app', `${value}: ${error}`);
    };

    return false;
  };

  _actorIsInteractiveButton(actor) {
    for (let current = actor; current; current = current.get_parent()) {
      if (current instanceof St.Button) {
        return true;
      };
    };

    return false;
  };

  _actorHandlesOwnClick(actor) {
    for (let current = actor; current; current = current.get_parent()) {
      if (current._desktopWidgetsSelfClick) {
        return true;
      };
    };

    return false;
  };

  _actorIsDescendantOf(actor, ancestor) {
    for (let current = actor; current; current = current.get_parent()) {
      if (current === ancestor) {
        return true;
      };
    }

    return false;
  };

  _viewForPickedActor(actor) {
    if (!actor) {
      return null;
    };

    for (const view of this._views.values()) {
      if (!WIDGET_CLICK_TYPES.has(view.widget.type)) {
        continue;
      };

      if (this._actorIsDescendantOf(actor, view.actor)) {
        return view;
      };
    };

    return null;
  };

  _viewForStagePoint(stageX, stageY) {
    for (const view of this._views.values()) {
      if (!WIDGET_CLICK_TYPES.has(view.widget.type)) {
        continue;
      };

      const [actorX, actorY] = view.actor.get_transformed_position();
      const [actorWidth, actorHeight] = view.actor.get_transformed_size();

      if (stageX >= actorX && stageX <= actorX + actorWidth && stageY >= actorY && stageY <= actorY + actorHeight) {
        return view;
      };
    };

    return null;
  };

  _pickedActorIsOnDesktop(actor) {
    const backgroundGroup = Main.layoutManager._backgroundGroup;

    return this._actorIsDescendantOf(actor, this._layer) || this._actorIsDescendantOf(actor, backgroundGroup);
  };

  _handleAppClickEvent(event) {
    const eventType = event.type();
    
    // Let all key events through so system screenshots (Win+Shift+S) keep working
    if (eventType === Clutter.EventType.KEY_PRESS || 
        eventType === Clutter.EventType.KEY_RELEASE) {
      return Clutter.EVENT_PROPAGATE;
    };
    
    if (this._editMode || eventType !== Clutter.EventType.BUTTON_RELEASE) {
      return Clutter.EVENT_PROPAGATE;
    };

    if ((event.get_button() ?? 1) !== 1) {
      return Clutter.EVENT_PROPAGATE;
    };

    const [stageX, stageY] = event.get_coords();
    const pickedActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, stageX, stageY);
    const sourceActor = event.get_source();

    if (this._actorIsInteractiveButton(pickedActor) || this._actorIsInteractiveButton(sourceActor)) {
      return Clutter.EVENT_PROPAGATE;
    };

    if (this._actorHandlesOwnClick(pickedActor) || this._actorHandlesOwnClick(sourceActor)) {
      return Clutter.EVENT_PROPAGATE;
    };

    const view = this._viewForPickedActor(pickedActor) ??
      (this._pickedActorIsOnDesktop(pickedActor) ? this._viewForStagePoint(stageX, stageY) : null);

    if (!view) {
      return Clutter.EVENT_PROPAGATE;
    };

    if (Date.now() < this._suppressAppClickUntil) {
      return Clutter.EVENT_STOP;
    };

    const now = Date.now();
    const DOUBLE_CLICK_TIME = 400; // milliseconds

    // Check for double-click
    if (!this._lastClickTime || !this._lastClickWidget || 
        this._lastClickWidget !== view.widget.id || 
        now - this._lastClickTime > DOUBLE_CLICK_TIME) {
      // First click or timeout - just store the time
      this._lastClickTime = now;
      this._lastClickWidget = view.widget.id;
      return Clutter.EVENT_STOP;
    }

    // Second click within double-click time - open app
    this._lastClickTime = 0;
    this._lastClickWidget = null;

    if (now - this._lastAppLaunchAt > 500) {
      this._lastAppLaunchAt = now;

      if (this._openWidgetApp(view)) {
        return Clutter.EVENT_STOP;
      };
    };

    return Clutter.EVENT_PROPAGATE;
  };

  _makeDraggable(view) {
    const {actor, widget} = view;
    let drag = null;

    const finishDrag = () => {
      if (!drag) {
        return;
      };

      drag = null;

      // Placement grid on: the widget lands on the highlighted cells.
      const gridTarget = this._placementGridTarget(widget);
      if (gridTarget?.valid) {
        widget.x = gridTarget.x;
        widget.y = gridTarget.y;
      };
      this._clampWidget(widget);

      // If a widget overlaps others, snap it to the nearest free
      // edge. While dragging, only the dragged widget moves.
      const gap = this._widgetGap ?? WIDGET_GAP;
      const widgetRect = this._rectFor(widget);
      const hasOverlap = this._widgets.some(other =>
        other !== widget && rectsOverlap(widgetRect, this._rectFor(other), gap)
      );

      if (hasOverlap) {
        const snapped = this._snapToNearestEdge(widget);
        widget.x = snapped.x;
        widget.y = snapped.y;
        this._clampWidget(widget);

        // Failsafe: if the widget still overlaps after snap+clamp,
        // drop it into the nearest free cell so it never stays stuck.
        if (this._widgets.some(other =>
          other !== widget && rectsOverlap(this._rectFor(widget), this._rectFor(other), gap))) {
          const open = this._findOpenPosition(widget, this._widgets);
          widget.x = open.x;
          widget.y = open.y;
          this._clampWidget(widget);
        };
      }
      
      delete widget.oldX;
      delete widget.oldY;
      
      this._animateWidget(widget, true);
      this._cancelActiveDrag();
      this._saveWidgets();
    };

    const moveDrag = event => {
      if (!drag) {
        return;
      };

      const [stageX, stageY] = event.get_coords();
      const [width, height] = this._sizeFor(widget);
      const monitor = monitorAtStage(effectiveMonitors(), stageX, stageY);

      if (!monitor) {
        return;
      };

      const gap = this._widgetGap ?? WIDGET_GAP;
      const minX = monitor.x + gap;
      const minY = monitor.y + topYFor(monitor) + gap;
      const maxX = Math.max(minX, monitor.x + monitor.width - width - gap);
      const maxY = Math.max(minY, monitor.y + monitor.height - height - gap);

      const layerX = this._layerX ?? 0;
      const layerY = this._layerY ?? 0;
      widget.x = clamp(drag.baseStageX + stageX - drag.stageX, minX, maxX) - layerX;
      widget.y = clamp(drag.baseStageY + stageY - drag.stageY, minY, maxY) - layerY;
      this._alignDraggedWidget(widget, {
        minX: minX - layerX, maxX: maxX - layerX,
        minY: minY - layerY, maxY: maxY - layerY,
      });

      // Move freely during drag (no snap-to-edges quantization — that made
      // the widget feel sluggish/unresponsive). Snapping to neighbours and
      // clamping happen on release (finishDrag).
      actor.set_position(widget.x, widget.y);
      this._syncEditControls(widget);
      this._updatePlacementGrid(widget);
    };

    // CAPTURE phase press: a press picked on ANY reactive inner element
    // (todo checkboxes, notes text…) would otherwise be consumed on the
    // way up and never reach this handler — that is why the drag used to
    // work «once in a while». In edit mode any press starts the drag.
    actor.connectObject('captured-event', (_source, event) => {
      if (event.type() !== Clutter.EventType.BUTTON_PRESS) {
        return Clutter.EVENT_PROPAGATE;
      };
      const button = event.get_button() ?? 1;

      if (button === 3 && this._editMode) {
        this._showContextMenu(view, event);
        return Clutter.EVENT_STOP;
      };

      if (button !== 1) {
        return Clutter.EVENT_PROPAGATE;
      };

      // Check edit mode and pinned status - pinned widgets cannot be dragged
      if (!this._editMode) {
        return Clutter.EVENT_PROPAGATE;
      };

      if (widget.pinned) {
        return Clutter.EVENT_PROPAGATE;
      };

      // Don't start a drag when the press lands on an edit-mode overlay button
      // (remove/pin/size/photo) — let the button handle its own click.
      const pressTarget = event.get_source?.() ?? event.get_target?.();
      const editButtons = [view.removeButton, view.pinButton, view.sizeButton, view.photoButton].filter(Boolean);
      if (pressTarget && editButtons.some(btn => pressTarget === btn || btn.contains?.(pressTarget))) {
        return Clutter.EVENT_PROPAGATE;
      };

      // Ignore BUTTON_PRESS if a drag is already active on this widget
      if (drag) {
        return Clutter.EVENT_STOP;
      };

      this._cancelActiveDrag();
      view.sizeMenu?.close();
      view.contextMenu?.close();

      const [stageX, stageY] = event.get_coords();
      widget.oldX = widget.x;
      widget.oldY = widget.y;
      drag = {
        stageX,
        stageY,
        baseStageX: widget.x + (this._layerX ?? 0),
        baseStageY: widget.y + (this._layerY ?? 0),
        hold: createHoldWatch(BUTTON1_MASK),
      };

      raiseActor(actor);
      this._syncEditControls(widget);
      this._showPlacementGrid(widget);

      // Capture pointer events globally while dragging. A stage
      // captured-event alone is NOT enough: without a Clutter grab, Mutter
      // routes pointer events over a window straight to that Wayland
      // client. Dragging a widget across a window then lost the release
      // (the widget kept following the cursor forever) and the window got
      // a stray press/release pair (it locked up or started moving with
      // the pointer). A stage grab keeps every event inside the shell for
      // the whole drag — same approach as the music seek bar.
      this._dragActor = actor;
      this._dragGrab?.dismiss();
      this._dragGrab = null;
      try {
        this._dragGrab = global.stage.grab(global.stage);
      } catch (e) {
        warn('widget-drag', `Could not grab the pointer for a drag: ${e}`);
      }
      global.stage.connectObject('captured-event', (_stage, capturedEvent) => {
        if (!drag) {
          return Clutter.EVENT_PROPAGATE;
        };

        const eventType = capturedEvent.type();
        const isMotion = eventType === Clutter.EventType.MOTION || eventType === Clutter.EventType.MOTION_NOTIFY;
        const isRelease = eventType === Clutter.EventType.BUTTON_RELEASE;
        const isKeyPress = eventType === Clutter.EventType.KEY_PRESS;

        if (isMotion) {
          // Safety net: if the release was ever lost, the first motion
          // without the primary button ends the drag instead of leaving
          // the widget glued to the cursor.
          if (!drag.hold.held(capturedEvent)) {
            finishDrag();
            return Clutter.EVENT_STOP;
          };
          moveDrag(capturedEvent);
          return Clutter.EVENT_STOP;
        };

        if (isRelease) {
          if (capturedEvent.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;
          finishDrag();
          return Clutter.EVENT_STOP;
        };

        if (isKeyPress && capturedEvent.get_key_symbol() === Clutter.KEY_Escape) {
          drag = null;
          widget.x = widget.oldX;
          widget.y = widget.oldY;
          delete widget.oldX;
          delete widget.oldY;
          actor.set_position(widget.x, widget.y);
          this._cancelActiveDrag();
          return Clutter.EVENT_STOP;
        };

        return Clutter.EVENT_PROPAGATE;
      }, actor);

      return Clutter.EVENT_STOP;
    }, this);

    view.draggable = true;
  };

  // Figma-style alignment while dragging: snaps the dragged widget's edges
  // (start/end) and center to the matching lines of the other widgets and
  // draws thin white guides along every line that ends up aligned.
  _alignDraggedWidget(widget, bounds) {
    const [width, height] = this._sizeFor(widget);
    const others = [];
    for (const view of this._views.values()) {
      if (view.widget && view.widget !== widget)
        others.push(this._rectFor(view.widget));
    };

    // [offset of the line inside the widget, kind]; edges only pair with
    // edges and centers with centers, so guides stay meaningful.
    const linesOf = (pos, size) => [[pos, 'edge'], [pos + size, 'edge'], [pos + size / 2, 'center']];

    const bestShift = (pos, size, key, sizeKey) => {
      let best = null;
      for (const [line, kind] of linesOf(pos, size)) {
        for (const other of others) {
          for (const [target, otherKind] of linesOf(other[key], other[sizeKey])) {
            if (kind !== otherKind)
              continue;
            const delta = target - line;
            if (Math.abs(delta) <= ALIGN_SNAP_PX && (best === null || Math.abs(delta) < Math.abs(best)))
              best = delta;
          };
        };
      };
      return best;
    };

    const dx = bestShift(widget.x, width, 'x', 'width');
    if (dx !== null)
      widget.x = clamp(widget.x + dx, bounds.minX, bounds.maxX);
    const dy = bestShift(widget.y, height, 'y', 'height');
    if (dy !== null)
      widget.y = clamp(widget.y + dy, bounds.minY, bounds.maxY);

    // Collect the aligned lines (after snapping) and the span they cover.
    const me = {x: widget.x, y: widget.y, width, height};
    const collect = (key, sizeKey, crossKey, crossSizeKey) => {
      const lines = new Map();
      for (const [line, kind] of linesOf(me[key], me[sizeKey])) {
        for (const other of others) {
          for (const [target, otherKind] of linesOf(other[key], other[sizeKey])) {
            if (kind !== otherKind || Math.abs(target - line) > 0.5)
              continue;
            const at = Math.round(line);
            const from = Math.min(me[crossKey], other[crossKey]) - ALIGN_GUIDE_OVERHANG;
            const to = Math.max(me[crossKey] + me[crossSizeKey], other[crossKey] + other[crossSizeKey]) + ALIGN_GUIDE_OVERHANG;
            const prev = lines.get(at);
            lines.set(at, prev ? [Math.min(prev[0], from), Math.max(prev[1], to)] : [from, to]);
          };
        };
      };
      return lines;
    };

    const guides = [];
    for (const [x, [from, to]] of collect('x', 'width', 'y', 'height'))
      guides.push({x: x === Math.round(me.x + width) ? x - 1 : x, y: from, w: 1, h: to - from});
    for (const [y, [from, to]] of collect('y', 'height', 'x', 'width'))
      guides.push({x: from, y: y === Math.round(me.y + height) ? y - 1 : y, w: to - from, h: 1});
    this._showDragGuides(guides);
  };

  _showDragGuides(guides) {
    if (!this._layer)
      return;
    // The pool lives in the layer; a layer refill destroys it.
    this._dragGuides = (this._dragGuides ?? []).filter(g =>
      !isActorDestroyed(g) && g.get_parent() === this._layer);

    while (this._dragGuides.length < guides.length) {
      // Apple-style smart guide: a crisp 1px hairline (no blurry glow)
      // with a faint dark rim so it stays visible on light wallpapers.
      const guide = new St.Widget({
        reactive: false,
        visible: false,
        opacity: 0,
        style: 'background-color: rgba(255, 255, 255, 0.95);'
          + ' box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.22);',
      });
      this._layer.add_child(guide);
      this._dragGuides.push(guide);
    };

    this._dragGuides.forEach((guide, i) => {
      const g = guides[i];
      if (!g) {
        this._fadeOutGuide(guide);
        return;
      };
      guide.set_position(Math.round(g.x), Math.round(g.y));
      guide.set_size(Math.max(1, Math.round(g.w)), Math.max(1, Math.round(g.h)));
      this._layer.set_child_above_sibling(guide, null);
      if (!guide.visible || guide._fadingOut) {
        guide._fadingOut = false;
        guide.remove_transition('opacity');
        guide.show();
        guide.ease({
          opacity: 255,
          duration: ALIGN_GUIDE_FADE_MS,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
      };
    });
  };

  _fadeOutGuide(guide) {
    if (isActorDestroyed(guide) || !guide.visible || guide._fadingOut)
      return;
    guide._fadingOut = true;
    guide.remove_transition('opacity');
    guide.ease({
      opacity: 0,
      duration: ALIGN_GUIDE_FADE_MS,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onStopped: () => {
        if (guide._fadingOut && !isActorDestroyed(guide)) {
          guide._fadingOut = false;
          guide.hide();
        }
      },
    });
  };

  // ── Placement grid (edit-mode drag) ──────────────────────────────────
  // While a widget is dragged, the monitor under it shows its 1×1 cells
  // (of the dragged widget's own family: regular, mini or compact): free
  // cells as faint tiles, cells covered by other widgets hidden, and the
  // cells the widget would land on highlighted — accent when it fits, red
  // when it would overlap. On release the widget drops onto those cells.
  _placementGridEnabled() {
    try {
      return this._layoutSettings?.get_boolean('show-placement-grid') ?? false;
    } catch (_e) {
      return false;
    };
  };

  _placementCellFor(widget) {
    const family = WIDGET_SIZE_SHAPES[widget.size]?.[2] ?? MAIN_FAMILY;
    const base = WIDGET_CELL_SIZES[family] ?? CELL_SIZE;
    return typeof base === 'object' ? [base.width, base.height] : [base, base];
  };

  // Grid geometry (layer coordinates) for the monitor under the widget.
  _placementGridGeometry(widget) {
    const [width, height] = this._sizeFor(widget);
    const layerX = this._layerX ?? 0;
    const layerY = this._layerY ?? 0;
    const monitor = monitorAtStage(effectiveMonitors(),
      widget.x + layerX + width / 2, widget.y + layerY + height / 2);
    if (!monitor)
      return null;
    const gap = this._widgetGap ?? WIDGET_GAP;
    const [cellW, cellH] = this._placementCellFor(widget);
    const usableW = monitor.width - 2 * gap;
    const usableH = monitor.height - topYFor(monitor) - 2 * gap;
    const cols = Math.max(0, Math.floor((usableW - cellW) / (cellW + gap)) + 1);
    const rows = Math.max(0, Math.floor((usableH - cellH) / (cellH + gap)) + 1);
    const pitchX = cellW + gap;
    const pitchY = cellH + gap;
    // The cells rarely fill the monitor exactly, so a grid hung from the
    // top-left corner left no cell flush with the right / bottom edge (where
    // «Arrange» and most layouts put widgets). The grid hangs from the
    // corner of the quarter the widget is in: every corner gets a flush
    // cell, and widgets placed against either edge line up with it.
    const left = monitor.x - layerX + gap;
    const top = monitor.y - layerY + topYFor(monitor) + gap;
    const right = monitor.x - layerX + monitor.width - gap;
    const bottom = monitor.y - layerY + monitor.height - gap;
    const centerX = widget.x + width / 2;
    const centerY = widget.y + height / 2;
    const fromRight = centerX > (left + right) / 2;
    const fromBottom = centerY > (top + bottom) / 2;
    const originX = fromRight ? right - cellW - (cols - 1) * pitchX : left;
    const originY = fromBottom ? bottom - cellH - (rows - 1) * pitchY : top;
    return {monitor, gap, cellW, cellH, originX, originY, cols, rows, pitchX, pitchY,
      key: `${monitor.x},${monitor.y},${monitor.width},${monitor.height},${cellW},${cellH},${gap},${fromRight},${fromBottom}`};
  };

  // Where the dragged widget would land: the cell-aligned spot nearest to
  // its current position, and whether that spot is free.
  _placementGridTarget(widget) {
    if (!this._placementGrid || !this._placementGridEnabled())
      return null;
    const geo = this._placementGrid.geo;
    if (!geo || geo.cols <= 0 || geo.rows <= 0)
      return null;
    const [width, height] = this._sizeFor(widget);
    const spanX = Math.max(1, Math.round((width + geo.gap) / geo.pitchX));
    const spanY = Math.max(1, Math.round((height + geo.gap) / geo.pitchY));
    const col = clamp(Math.round((widget.x - geo.originX) / geo.pitchX), 0, Math.max(0, geo.cols - spanX));
    const row = clamp(Math.round((widget.y - geo.originY) / geo.pitchY), 0, Math.max(0, geo.rows - spanY));
    const x = geo.originX + col * geo.pitchX;
    const y = geo.originY + row * geo.pitchY;
    const rect = {x, y, width, height};
    const fits = spanX <= geo.cols && spanY <= geo.rows;
    const valid = fits && !this._widgets.some(other =>
      other !== widget && rectsOverlap(rect, this._rectFor(other), geo.gap));
    return {x, y, col, row, spanX: Math.min(spanX, geo.cols), spanY: Math.min(spanY, geo.rows), valid};
  };

  _showPlacementGrid(widget) {
    this._hidePlacementGrid(false);
    if (!this._editMode || !this._layer || !this._placementGridEnabled())
      return;
    const container = new St.Widget({
      layout_manager: new Clutter.FixedLayout(),
      reactive: false,
      opacity: 0,
    });
    // Under every widget: the dragged one floats over its target cells.
    this._layer.insert_child_at_index(container, 0);
    this._placementGrid = {container, geo: null, cells: [], widget};
    this._updatePlacementGrid(widget);
    container.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
  };

  _buildPlacementCells(grid, geo) {
    grid.container.destroy_all_children();
    grid.cells = [];
    grid.geo = geo;
    const theme = this._gnomeTheme();
    const radius = Math.max(4, Math.round(theme.radius * Math.min(geo.cellW, geo.cellH) / CELL_SIZE));
    grid.radius = radius;
    for (let row = 0; row < geo.rows; row++) {
      for (let col = 0; col < geo.cols; col++) {
        const cell = new St.Widget({
          x: geo.originX + col * geo.pitchX,
          y: geo.originY + row * geo.pitchY,
          width: geo.cellW,
          height: geo.cellH,
          reactive: false,
        });
        cell._state = null;
        grid.container.add_child(cell);
        grid.cells.push({cell, col, row});
      };
    };
  };

  _updatePlacementGrid(widget) {
    const grid = this._placementGrid;
    if (!grid || isActorDestroyed(grid.container))
      return;
    const geo = this._placementGridGeometry(widget);
    if (!geo) {
      grid.container.hide();
      return;
    };
    grid.container.show();
    if (!grid.geo || grid.geo.key !== geo.key)
      this._buildPlacementCells(grid, geo);

    const theme = this._gnomeTheme();
    const others = this._widgets.filter(other => other !== widget).map(other => this._rectFor(other));
    const target = this._placementGridTarget(widget);
    const shape = `border-radius: ${grid.radius}px;`;
    const line = theme.dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)';
    const fill = theme.dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
    const STYLES = {
      free: `${shape} border: 1px dashed ${line}; background-color: ${fill};`,
      target: `${shape} border: 2px solid ${theme.accent}; background-color: ${theme.dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.10)'};`,
      blocked: `${shape} border: 2px solid rgba(224,27,36,0.9); background-color: rgba(224,27,36,0.22);`,
    };

    for (const {cell, col, row} of grid.cells) {
      const cx = geo.originX + col * geo.pitchX;
      const cy = geo.originY + row * geo.pitchY;
      const inTarget = target
        && col >= target.col && col < target.col + target.spanX
        && row >= target.row && row < target.row + target.spanY;
      // Covered by another widget (no gap: touching neighbours stay free).
      const occupied = others.some(r =>
        cx < r.x + r.width && cx + geo.cellW > r.x && cy < r.y + r.height && cy + geo.cellH > r.y);
      const state = inTarget ? (target.valid ? 'target' : 'blocked') : (occupied ? 'hidden' : 'free');
      if (cell._state === state)
        continue;
      cell._state = state;
      if (state === 'hidden') {
        cell.hide();
        continue;
      };
      cell.set_style(STYLES[state]);
      cell.show();
    };
  };

  _hidePlacementGrid(animate = true) {
    const grid = this._placementGrid;
    this._placementGrid = null;
    if (!grid || isActorDestroyed(grid.container))
      return;
    const container = grid.container;
    if (!animate) {
      container.destroy();
      return;
    };
    container.remove_all_transitions();
    container.ease({
      opacity: 0,
      duration: 160,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onStopped: () => {
        if (!isActorDestroyed(container))
          container.destroy();
      },
    });
  };

  _hideDragGuides() {
    for (const guide of this._dragGuides ?? []) {
      this._fadeOutGuide(guide);
    };
  };

  _cancelActiveDrag() {
    this._hideDragGuides();
    this._hidePlacementGrid();

    // Always drop the pointer grab first: a leaked grab would freeze every
    // window's input until the shell restarts.
    if (this._dragGrab) {
      try {
        this._dragGrab.dismiss();
      } catch (_e) {}
      this._dragGrab = null;
    };

    if (!this._dragActor) {
      return;
    };

    // Disconnect the stage capture handler installed for the drag.
    global.stage.disconnectObject(this._dragActor);
    this._dragActor = null;
  };

  _hideContextMenus() {
    for (const view of this._views.values()) {
      view.contextMenu?.close();
    };
  };

  _onStageEventForMenu(event) {
    let openMenuView = null;

    for (const view of this._views.values()) {
      // PopupMenu exposes open state via isOpen (mapped no longer applies).
      if (view.contextMenu?.isOpen) {
        openMenuView = view;
        break;
      };
    };

    if (!openMenuView) {
      return Clutter.EVENT_PROPAGATE;
    };

    const eventType = event.type();

    if (eventType === Clutter.EventType.KEY_PRESS) {
      if (event.get_key_symbol() === Clutter.KEY_Escape) {
        this._hideContextMenus();
        return Clutter.EVENT_STOP;
      };

      return Clutter.EVENT_PROPAGATE;
    };

    if (eventType !== Clutter.EventType.BUTTON_PRESS) {
      return Clutter.EVENT_PROPAGATE;
    };

    const [stageX, stageY] = event.get_coords();
    const pickedActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, stageX, stageY);

    const onOwnerWidget = openMenuView.actor && this._actorContains(openMenuView.actor, pickedActor);
    const insideMenu = this._actorContains(openMenuView.contextMenu.actor, pickedActor);

    if (onOwnerWidget || insideMenu) {
      return Clutter.EVENT_PROPAGATE;
    };

    const source = event.get_source();
    const onOtherWidget = !!source && (() => {
      for (const view of this._views.values()) {
        if (view.contextMenu?.isOpen) {
          continue;
        };

        if (view.actor && this._actorContains(view.actor, source)) {
          return true;
        };
      };

      return false;
    })();

    if (onOtherWidget) {
      this._hideContextMenus();
      return Clutter.EVENT_PROPAGATE;
    };

    this._hideContextMenus();
    return Clutter.EVENT_STOP;
  };

  _actorContains(actor, target) {
    if (!actor || !target) {
      return false;
    };

    let node = target;

    while (node) {
      if (node === actor) {
        return true;
      };

      node = node.get_parent();
    };

    return false;
  };

  _showContextMenu(view, event) {
    view.sizeMenu?.close();
    this._hideContextMenus();

    // Menus are disposable; the manager persists per view (it has no
    // destroy() in GNOME 51 and auto-removes menus on their 'destroy').
    view.contextMenu?.destroy();
    view.contextMenu = null;

    if (!view.contextMenuManager) {
      view.contextMenuManager = new PopupMenu.PopupMenuManager(view.actor);
    };

    // Reference-style context menu (liquidglass desktopWidget): the standard
    // GNOME PopupMenu attached to the widget wrapper, manager for dismissal,
    // and Switch rows — 1:1 with the reference look.
    const menu = new PopupMenu.PopupMenu(view.actor, 0.5, St.Side.TOP);
    view.contextMenuManager.addMenu(menu);
    Main.uiGroup.add_child(menu.actor);
    menu.actor.hide();

    const widgetModule = WIDGETS.get(view.widget.type);
    const supportedSizes = widgetModule?.supportedSizes ?? [];
    const menuSizes = orderedSizes(supportedSizes);

    if (menuSizes.length > 0) {
      const sizeItem = new PopupMenu.PopupSubMenuMenuItem(_('Widget size'), false);

      for (const sizeKey of menuSizes) {
        const subItem = new PopupMenu.PopupMenuItem(sizeLabel(sizeKey));

        if (view.widget.size === sizeKey) {
          subItem.setOrnament(PopupMenu.Ornament.DOT);
        };

        subItem.connectObject('activate', () => {
          this._setWidgetSize(view.widget, sizeKey);
        }, this);
        sizeItem.menu.addMenuItem(subItem);
      };

      menu.addMenuItem(sizeItem);

      if (!menu.isEmpty()) {
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      };
    };

    if (view.widget.type === 'photos') {
      const photoItem = new PopupMenu.PopupMenuItem(_('Change photo'));
      photoItem.connectObject('activate', () => {
        PhotosWidget.openPhotoChooser(view.widget, path => this._setWidgetPhoto(view.widget, view.body, path));
      }, this);
      menu.addMenuItem(photoItem);
    };

    // Widget-in-widget: add / remove pages above or below this widget.
    const stackItem = new PopupMenu.PopupMenuItem(_('Widget pages'));
    stackItem.connectObject('activate', () => {
      this._openStackPanel(view);
    }, this);
    menu.addMenuItem(stackItem);

    // Switch rows mirror the reference's Glass/Lock toggles. Glass is the
    // global style-mode (0 = glass, 1 = solid) — the same switch that lives
    // in preferences, now quickly reachable from the widget itself; the
    // 'changed::appearance' listener above rebuilds styles live.
    const glassItem = new PopupMenu.PopupSwitchMenuItem(_('Glass'), this._layoutSettings.get_int('style-mode') === 0);
    glassItem.connectObject('toggled', (_item, on) => {
      const mode = on ? 0 : 1;
      if (this._layoutSettings.get_int('style-mode') !== mode)
        this._layoutSettings.set_int('style-mode', mode);
    }, this);
    menu.addMenuItem(glassItem);

    const lockItem = new PopupMenu.PopupSwitchMenuItem(_('Lock Position'), Boolean(view.widget.pinned));
    lockItem.connectObject('toggled', (_item, on) => {
      if (Boolean(view.widget.pinned) !== on) {
        this.togglePin(view.widget.id);
      };
    }, this);
    menu.addMenuItem(lockItem);

    const settingsItem = new PopupMenu.PopupMenuItem(_('Widget settings'));
    settingsItem.connectObject('activate', () => {
      // Deep link: prefs opens straight on this widget's own page; widgets
      // without one land on Appearance.
      this._layoutSettings.set_string(
        'open-prefs-page',
        WIDGET_PREFS_PAGES.get(view.widget.type) ?? 'appearance',
      );
      this._extension.openPreferences();
    }, this);
    menu.addMenuItem(settingsItem);

    // Destructive action: set apart by a separator, red text + trash icon,
    // and a red highlight on hover (stylesheet.css).
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    const removeItem = new PopupMenu.PopupImageMenuItem(_('Remove widget'), 'user-trash-symbolic');
    removeItem.add_style_class_name('desktop-widgets-destructive-item');
    if (!this._gnomeTheme().dark)
      removeItem.add_style_class_name('desktop-widgets-destructive-item-light');
    removeItem.connectObject('activate', () => {
      this.removeWidget(view.widget.id);
    }, this);
    menu.addMenuItem(removeItem);

    view.contextMenu = menu;
    menu.open();
  };

  _destroyContextMenu(view) {
    // PopupMenuManager has no destroy() in GNOME 51; destroying the menu
    // removes it from its manager automatically.
    view.contextMenu?.destroy();
    view.contextMenu = null;
  };

  // ── Widget pages (widget-in-widget) ───────────────────────────────────
  // Edit-mode panel pinned over the widget slot: added pages listed above
  // the current one, each with a delete button; «Add page» opens the
  // gallery window; «Done» saves and closes.

  // ── Stack panel: centered modal with widget preview + add buttons ─────
  // Instead of a small list over the widget, show a large centered window
  // with the current widget in the middle, + buttons above/below to add
  // pages, and a list of added pages at the side. Matches the gallery UX.

  // ── Stack panel UI helpers ────────────────────────────────────────────
  // Press arms, release (button 1, still on the actor) fires — deferred
  // to idle so a handler may destroy the panel it lives in.
  _stackPanelActivate(actor, fn) {
    let armed = false;
    actor.connect('button-press-event', (_a, event) => {
      armed = event.get_button() === 1;
      return Clutter.EVENT_STOP;
    });
    actor.connect('leave-event', () => {
      armed = false;
      return Clutter.EVENT_PROPAGATE;
    });
    actor.connect('button-release-event', (_a, event) => {
      if (armed && event.get_button() === 1) {
        armed = false;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          fn();
          return GLib.SOURCE_REMOVE;
        });
      };
      armed = false;
      return Clutter.EVENT_STOP;
    });
    actor.connect('key-press-event', (_a, event) => {
      const key = event.get_key_symbol();
      if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter || key === Clutter.KEY_space) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          fn();
          return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_STOP;
      };
      return Clutter.EVENT_PROPAGATE;
    });
  };

  // Hover tint for inline-styled actors (inline styles have no :hover).
  _stackPanelHover(actor, base, hover) {
    actor.track_hover = true;
    actor.set_style(base);
    actor.connect('notify::hover', () => {
      if (!isActorDestroyed(actor))
        actor.set_style(actor.hover ? hover : base);
    });
  };

  // Small round icon button (close, move, delete).
  _stackPanelIconButton(iconName, accessibleName, theme, {danger = false, enabled = true, size = 30} = {}) {
    const fill = theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    const fillHover = danger
      ? 'rgba(224,27,36,0.22)'
      : (theme.dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.12)');
    const color = !enabled ? theme.muted : (danger ? '#ff6b6b' : theme.text);
    const shape = `width: ${size}px; height: ${size}px; border-radius: ${size / 2}px; padding: 0;`;
    const button = new St.Button({
      reactive: enabled,
      can_focus: enabled,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      opacity: enabled ? 255 : 90,
      child: new St.Icon({
        icon_name: iconName,
        icon_size: Math.round(size * 0.47),
        style: `color: ${color};`,
      }),
    });
    button.accessible_name = accessibleName;
    this._stackPanelHover(button,
      `${shape} background-color: ${fill};`,
      `${shape} background-color: ${enabled ? fillHover : fill};`);
    return button;
  };

  // Full-width dashed «Add page above / below» row.
  _stackPanelAddButton(text, theme, enabled, fn) {
    const box = new St.BoxLayout(boxLayoutProps({
      x_align: Clutter.ActorAlign.CENTER,
      style: 'spacing: 8px;',
    }));
    const color = enabled ? theme.accent : theme.muted;
    box.add_child(new St.Icon({
      icon_name: 'list-add-symbolic',
      icon_size: 14,
      y_align: Clutter.ActorAlign.CENTER,
      style: `color: ${color};`,
    }));
    box.add_child(this._label(text, 'widget-text',
      `font-size: 13px; font-weight: 600; color: ${color};`));

    const button = new St.Button({
      child: box,
      x_expand: true,
      reactive: enabled,
      can_focus: enabled,
      opacity: enabled ? 255 : 120,
    });
    button.accessible_name = text;
    const shape = 'border-radius: 12px; padding: 9px 12px;';
    const line = theme.dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.2)';
    this._stackPanelHover(button,
      `${shape} border: 1px dashed ${line}; background-color: transparent;`,
      `${shape} border: 1px dashed ${enabled ? theme.accent : line};`
        + ` background-color: ${enabled ? (theme.dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)') : 'transparent'};`);
    if (enabled)
      this._stackPanelActivate(button, fn);
    return button;
  };

  // One page row: thumbnail, name + position/size, «Showing» badge, and
  // for added pages: move up / move down / delete. A click on the row
  // shows that page on the desktop.
  _createStackPageRow({view, theme, entry, title, subtitle, isMain, isActive, canUp, canDown, onShow, onMove, onDelete}) {
    const row = new St.BoxLayout(boxLayoutProps({
      x_expand: true,
      reactive: true,
      can_focus: true,
    }));
    row.accessible_name = title;

    const fill = theme.dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.035)';
    const fillHover = theme.dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.07)';
    const shape = 'border-radius: 14px; padding: 8px 10px 8px 8px; spacing: 12px;';
    const edge = isActive ? `border: 2px solid ${theme.accent};` : 'border: 2px solid transparent;';
    this._stackPanelHover(row,
      `${shape} ${edge} background-color: ${fill};`,
      `${shape} ${edge} background-color: ${fillHover};`);

    // Thumbnail
    const thumbSize = 48;
    const thumb = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      width: thumbSize,
      height: thumbSize,
      y_align: Clutter.ActorAlign.CENTER,
      style: `border-radius: 11px; background-color: ${theme.dark ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.06)'};`,
    });
    const icon = this._stackWidgetSvgIcon(entry.type, 38);
    if (icon) {
      icon.x_align = Clutter.ActorAlign.CENTER;
      icon.y_align = Clutter.ActorAlign.CENTER;
      thumb.add_child(icon);
    } else {
      thumb.add_child(new St.Icon({
        icon_name: 'application-x-addon-symbolic',
        icon_size: 22,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        style: `color: ${theme.muted};`,
      }));
    };
    row.add_child(thumb);

    // Name + where it sits
    const text = new St.BoxLayout(boxLayoutProps({
      vertical: true,
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
      style: 'spacing: 2px;',
    }));
    const titleLabel = this._label(title, 'widget-text',
      `font-size: 14px; font-weight: 700; color: ${theme.text};`);
    titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    text.add_child(titleLabel);
    const subLabel = this._label(subtitle, 'widget-text',
      `font-size: 12px; color: ${theme.muted};`);
    subLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    text.add_child(subLabel);
    row.add_child(text);

    if (isActive) {
      row.add_child(this._label(_('Showing'), 'widget-text',
        `font-size: 11px; font-weight: 700; color: #ffffff; background-color: ${theme.accent};`
          + ' border-radius: 9px; padding: 2px 8px;'));
      row.get_last_child().y_align = Clutter.ActorAlign.CENTER;
    };

    if (!isMain) {
      const actions = new St.BoxLayout(boxLayoutProps({
        y_align: Clutter.ActorAlign.CENTER,
        style: 'spacing: 4px;',
      }));
      const up = this._stackPanelIconButton('go-up-symbolic', _('Move up'), theme, {enabled: canUp, size: 28});
      const down = this._stackPanelIconButton('go-down-symbolic', _('Move down'), theme, {enabled: canDown, size: 28});
      const del = this._stackPanelIconButton('user-trash-symbolic', _('Delete page'), theme, {danger: true, size: 28});
      if (canUp)
        this._stackPanelActivate(up, () => onMove(-1));
      if (canDown)
        this._stackPanelActivate(down, () => onMove(1));
      this._stackPanelActivate(del, onDelete);
      actions.add_child(up);
      actions.add_child(down);
      actions.add_child(del);
      row.add_child(actions);
    };

    if (!isActive)
      this._stackPanelActivate(row, onShow);
    return row;
  };

  // ── Stack panel: one centered window ─────────────────────────────────
  // Header (title, page count, close), the column of pages in flip order —
  // pages above, the main widget, pages below — with «Add page above» on
  // top and «Add page below» at the bottom, a how-to-flip hint and Done.
  _openStackPanel(view) {
    this._closeStackPanel();

    const theme = this._gnomeTheme();
    const [stageW, stageH] = global.stage.get_size();
    // Panel state is re-read on every in-place refresh (move / delete /
    // show): the list rebuilds its rows, the window itself stays open.
    const readState = () => {
      const entries = Array.isArray(view.widget.stack)
        ? view.widget.stack.filter(entry => entry && entry.type)
        : [];
      const above = entries.filter(entry => entry.side === 'above');
      const below = entries.filter(entry => (entry.side ?? 'below') !== 'above');
      return {
        entries,
        above,
        below,
        canAddMore: entries.length < STACK_PAGE_LIMIT,
        // Visible page → index in the prism (0 = main, then above, then below).
        activePage: view._stackPrism?.getActivePage?.() ?? 0,
        pageIndexOf: entry => {
          const a = above.indexOf(entry);
          if (a >= 0)
            return 1 + a;
          const b = below.indexOf(entry);
          return b >= 0 ? 1 + above.length + b : -1;
        },
      };
    };
    let state = readState();

    const typeName = type => WIDGET_TYPE_LABELS[type] ?? type;
    const sizeOf = entry => sizeLabel(entry?.size || view.widget.size);

    // Backdrop swallows clicks outside the card and closes the panel.
    const overlay = new St.Widget({
      reactive: true,
      can_focus: true,
      x: 0,
      y: 0,
      width: Math.max(320, stageW),
      height: Math.max(240, stageH),
      style: 'background-color: rgba(0, 0, 0, 0.5);',
      // The layout keeps the card centered at its REAL size: measuring it
      // before it was on stage (no theme yet) placed it off-center until
      // the first refresh.
      layout_manager: new Clutter.BinLayout(),
    });

    const cardW = Math.min(420, Math.max(320, stageW - 48));
    const card = new St.BoxLayout(boxLayoutProps({
      vertical: true,
      width: cardW,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      style: `background-color: ${theme.background};`
        + ` border: 1px solid ${theme.border};`
        + ` border-radius: ${Math.min(30, Math.max(14, theme.radius + 8))}px;`
        + ' padding: 18px 18px 16px 18px; spacing: 14px;'
        + ' box-shadow: 0 12px 40px rgba(0,0,0,0.45);',
      reactive: true,
      can_focus: true,
    }));

    // Header
    const header = new St.BoxLayout(boxLayoutProps({x_expand: true, style: 'spacing: 10px;'}));
    const titles = new St.BoxLayout(boxLayoutProps({
      vertical: true,
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
      style: 'spacing: 2px;',
    }));
    titles.add_child(this._label(_('Widget pages'), 'widget-text',
      `font-size: 17px; font-weight: 800; color: ${theme.text};`));
    const countText = () =>
      `${typeName(view.widget.type)} · ${_('%d of %d pages added').format(state.entries.length, STACK_PAGE_LIMIT)}`;
    const countLabel = this._label(countText(), 'widget-text', `font-size: 12px; color: ${theme.muted};`);
    titles.add_child(countLabel);
    header.add_child(titles);
    const closeButton = this._stackPanelIconButton('window-close-symbolic', _('Close'), theme);
    closeButton.y_align = Clutter.ActorAlign.START;
    header.add_child(closeButton);
    card.add_child(header);

    // Pages column
    const list = new St.BoxLayout(boxLayoutProps({vertical: true, x_expand: true, style: 'spacing: 6px;'}));

    // Rows are keyed (entry key, or 'main') so an in-place refresh can
    // slide each surviving row from its old spot to its new one.
    const rowKey = entry => (entry === null ? '__main__' : (entry.key || entry.type));

    const refresh = () => {
      if (isActorDestroyed(list))
        return;
      // Old row positions, before the rebuild.
      const oldY = new Map();
      for (const child of list.get_children()) {
        if (child._stackRowKey)
          oldY.set(child._stackRowKey, child.get_allocation_box().y1);
      };
      state = readState();
      countLabel.text = countText();
      list.destroy_all_children();
      fillList(oldY); // the overlay's BinLayout re-centers the card
    };

    // Same flip order the desktop uses, with the main widget in it; moving
    // a page past the main widget switches its side.
    const moveEntry = (entry, delta) => {
      const order = [...state.above, null, ...state.below];
      const from = order.indexOf(entry);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= order.length)
        return;
      // Keep showing whatever page is on screen now.
      const showing = state.activePage === 0
        ? null
        : [...state.above, ...state.below][state.activePage - 1] ?? null;
      [order[from], order[to]] = [order[to], order[from]];
      const mainAt = order.indexOf(null);
      const above = order.slice(0, mainAt).map(e => Object.assign(e, {side: 'above'}));
      const below = order.slice(mainAt + 1).map(e => Object.assign(e, {side: 'below'}));
      const rest = (view.widget.stack ?? []).filter(e => !e || !e.type);
      view.widget.stack = [...above, ...below, ...rest];
      let startPage = 0;
      if (showing) {
        const a = above.indexOf(showing);
        startPage = a >= 0 ? 1 + a : 1 + above.length + below.indexOf(showing);
      };
      this._applyStackChange(view, {reopenPanel: false, startPage});
      refresh();
    };
    const deleteEntry = (entry) => {
      const stack = view.widget.stack ?? [];
      let index = stack.indexOf(entry);
      if (index === -1)
        index = stack.findIndex(e => e && (e.key || '') === (entry.key || ''));
      if (index === -1)
        return;
      const showing = state.activePage === 0
        ? null
        : [...state.above, ...state.below][state.activePage - 1] ?? null;
      stack.splice(index, 1);
      // Keep showing the visible page unless it was the one deleted.
      const left = readState();
      const startPage = showing && showing !== entry ? Math.max(0, left.pageIndexOf(showing)) : 0;
      this._applyStackChange(view, {reopenPanel: false, startPage});
      refresh();
    };
    const showPage = (pageIndex) => {
      if (!view._stackPrism?.showPage)
        return;
      view._stackPrism.showPage(pageIndex);
      view._stackStartPage = pageIndex;
      refresh(); // moves the «Showing» badge
    };

    const slideFrom = (row, fromY) => {
      if (fromY === undefined)
        return;
      // First allocation of the new row: start it where its old row was
      // and glide into place (paint-only translation, no relayout).
      const id = row.connect('notify::allocation', () => {
        row.disconnect(id);
        const delta = fromY - row.get_allocation_box().y1;
        if (Math.abs(delta) < 1)
          return;
        row.translation_y = delta;
        row.ease({
          translation_y: 0,
          duration: 220,
          mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
      });
    };

    const fillList = (oldY = new Map()) => {
      const {above, below, canAddMore, activePage, pageIndexOf} = state;

      list.add_child(this._stackPanelAddButton(
        canAddMore ? _('Add page above') : _('Page limit reached'), theme, canAddMore, () => {
          this._closeStackPanel();
          this._openStackGallery(view, 'above');
        }));

      const order = [...above, null, ...below];
      order.forEach((entry, pos) => {
        let row;
        if (entry === null) {
          row = this._createStackPageRow({
            view, theme,
            entry: view.widget,
            title: typeName(view.widget.type),
            subtitle: `${_('Main widget')} · ${sizeOf(view.widget)}`,
            isMain: true,
            isActive: activePage === 0,
            onShow: () => showPage(0),
          });
        } else {
          const where = entry.side === 'above' ? _('Above') : _('Below');
          const pageIndex = pageIndexOf(entry);
          row = this._createStackPageRow({
            view, theme, entry,
            title: typeName(entry.type),
            subtitle: `${where} · ${sizeOf(entry)}`,
            isMain: false,
            isActive: activePage === pageIndex,
            canUp: pos > 0,
            canDown: pos < order.length - 1,
            onShow: () => showPage(pageIndex),
            onMove: delta => moveEntry(entry, delta),
            onDelete: () => deleteEntry(entry),
          });
        };
        row._stackRowKey = rowKey(entry);
        list.add_child(row);
        slideFrom(row, oldY.get(row._stackRowKey));
      });

      list.add_child(this._stackPanelAddButton(
        canAddMore ? _('Add page below') : _('Page limit reached'), theme, canAddMore, () => {
          this._closeStackPanel();
          this._openStackGallery(view, 'below');
        }));
    };

    fillList();

    // Many pages on a short screen: the column scrolls.
    const listMaxH = Math.max(200, stageH - 300);
    const scroll = new St.ScrollView({
      x_expand: true,
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.AUTOMATIC,
      overlay_scrollbars: true,
      style: `max-height: ${listMaxH}px;`,
    });
    if (typeof scroll.set_child === 'function')
      scroll.set_child(list);
    else
      scroll.add_actor(list);
    card.add_child(scroll);

    // How to flip
    const hint = new St.BoxLayout(boxLayoutProps({
      x_expand: true,
      style: `spacing: 10px; padding: 10px 12px; border-radius: 12px;`
        + ` background-color: ${theme.dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)'};`,
    }));
    hint.add_child(new St.Icon({
      icon_name: 'input-mouse-symbolic',
      icon_size: 16,
      y_align: Clutter.ActorAlign.CENTER,
      style: `color: ${theme.muted};`,
    }));
    const hintLabel = this._label(
      _('Hold the right mouse button on the widget and drag up or down to flip pages.'),
      'widget-text', `font-size: 12px; color: ${theme.muted};`);
    hintLabel.x_expand = true;
    hintLabel.clutter_text.line_wrap = true;
    hintLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    hintLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    hint.add_child(hintLabel);
    card.add_child(hint);

    // Done
    const doneButton = new St.Button({
      label: _('Done'),
      x_expand: true,
      reactive: true,
      can_focus: true,
    });
    const doneShape = 'padding: 10px 26px; border-radius: 12px; font-weight: 700; font-size: 14px; color: #ffffff;';
    this._stackPanelHover(doneButton,
      `${doneShape} background-color: ${theme.accent}; border: 1px solid transparent;`,
      `${doneShape} background-color: ${theme.accent}; border: 1px solid rgba(255,255,255,0.4);`);
    const finish = () => {
      this._saveWidgets();
      this._closeStackPanel();
    };
    this._stackPanelActivate(doneButton, finish);
    this._stackPanelActivate(closeButton, finish);
    card.add_child(doneButton);

    overlay.add_child(card);


    card.connect('button-press-event', () => Clutter.EVENT_STOP);
    card.connect('button-release-event', () => Clutter.EVENT_STOP);
    overlay.connect('button-press-event', (_actor, event) => {
      if (event.get_button() === 1)
        this._closeStackPanel();
      return Clutter.EVENT_STOP;
    });

    Main.uiGroup.add_child(overlay);
    view._stackPanel = overlay;
    this._stackPanelView = view;

    // Gentle open: fade + slight rise.
    card.opacity = 0;
    card.translation_y = 12;
    card.ease({opacity: 255, translation_y: 0, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});

    overlay.connect('key-press-event', (_actor, event) => {
      if (event.get_key_symbol() === Clutter.KEY_Escape) {
        this._closeStackPanel();
        return Clutter.EVENT_STOP;
      };
      return Clutter.EVENT_PROPAGATE;
    });

    // Capture-phase backstop: Escape is stopped on the stage before any
    // child sees it, even after internal focus changes.
    global.stage.connectObject('captured-event', (_stage, event) => {
      if (event.type() === Clutter.EventType.KEY_PRESS
        && event.get_key_symbol() === Clutter.KEY_Escape) {
        this._closeStackPanel();
        return Clutter.EVENT_STOP;
      };
      return Clutter.EVENT_PROPAGATE;
    }, overlay);

    // Real modal grab (Wayland): routes keys to the shell so Escape works.
    overlay.modalGrab = Main.pushModal(overlay, {actionMode: Shell.ActionMode.NORMAL});
  };

  _closeStackPanel() {
    const view = this._stackPanelView;

    if (view?._stackPanel && !isActorDestroyed(view._stackPanel)) {
      // Release the modal grab BEFORE destroying the overlay, or the grab
      // would dangle and swallow system input.
      if (view._stackPanel.modalGrab) {
        Main.popModal(view._stackPanel.modalGrab);
        view._stackPanel.modalGrab = null;
      };
      view._stackPanel.destroy();
    };
    if (view) {
      view._stackPanel = null;
    };
    this._stackPanelView = null;
  };

  // A panel edit re-renders the whole slot: the fill path rebuilds the
  // prism from the fresh widget.stack, the save persists it, and the panel
  // reopens on the new tiles. Reopening is unconditional: after deleting
  // the last page the panel shows just the current widget and the two «+».
  _applyStackChange(view, {reopenPanel = true, startPage = 0} = {}) {
    // Guard: view must still be valid
    if (!view || !this._views.has(view.widget.id)) {
      console.warn('[stack-change] View no longer valid, aborting');
      return;
    };
    
    const stackLength = view.widget.stack?.length ?? 0;

    
    this._closeStackGallery({animate: false});
    this._saveWidgets();
    
    // Recreate edit controls ONLY if stack size changed enough to affect visibility
    // (2+ widgets show size button, <2 widgets don't)
    if (this._editMode) {
      const hadControls = view.sizeButton !== null && view.sizeButton !== undefined;
      const totalWidgets = 1 + stackLength;
      const shouldHaveControls = totalWidgets >= 2;
      
      // Only recreate if the state changed (appeared or disappeared)
      if (hadControls !== shouldHaveControls) {
        // Remove old edit controls
        view.editBorder?.destroy();
        view.removeButton?.destroy();
        view.pinButton?.destroy();
        view.sizeButton?.destroy();
        view.sizeMenu?.destroy();
        view.photoButton?.destroy();
        
        view.editBorder = null;
        view.removeButton = null;
        view.pinButton = null;
        view.sizeButton = null;
        view.sizeMenu = null;
        view.photoButton = null;
        
        // Recreate edit controls with new stack size
        this._addEditControls(view);
      }
    }
    
    // Rebuild the stacked pages from the edited list. The first added
    // page used to be ignored (the rebuild ran only for an existing stack).
    // After an edit the stack opens on the primary page.
    this._disposeStack(view);
    view._stackStartPage = stackLength > 0 ? startPage : 0;
    if (stackLength > 0)
      this._ensureStack(view, view._stackStartPage);
    else
      this._safeFillWidgetBody(view.widget, view.body);

    // The panel refreshes itself in place on move / delete; other callers
    // (the gallery adding a page) reopen it.
    if (reopenPanel)
      this._openStackPanel(view);
  };


  _stackGalleryAllowedSizes(hostWidget) {
    // Use the HOST widget's size (the first/main widget), not the active page
    const hostSize = hostWidget?.size ?? 'small';
    
    // Show ONLY the exact same size as the host widget
    // If host is medium (2x1), show only medium, not mini (2x1 mini)
    return [hostSize];
  };

  // Catalog for the pages drawer: every module type whose supported sizes
  // intersect the ones that fit the host's slot.
  _stackGalleryCatalog(hostWidget) {
    // Use the HOST widget's size (the first/main widget), not the active page
    const hostSize = hostWidget?.size ?? 'small';

    // Show ONLY widgets that support the EXACT same size as host widget
    // If host is medium (2x1), show only widgets that support medium, not mini
    return WIDGET_MODULES
      .map(widgetModule => {
        const type = widgetModule.type;
        const native = Array.isArray(widgetModule.supportedSizes) && widgetModule.supportedSizes.length > 0
          ? widgetModule.supportedSizes
          : null;
        
        // Check if widget supports host size
        const supportsHostSize = !native || native.includes(hostSize);
        
        // If widget doesn't support host size, exclude it
        if (!supportsHostSize) {
          return null;
        };

        return {
          type,
          label: _(WIDGET_TYPE_LABELS[type] ?? type),
          description: _(GALLERY_HINTS[type] ?? ''),
          sizes: [hostSize], // Only show host size, no other sizes
          defaultSize: hostSize,
        };
      })
      .filter(record => record !== null); // Remove excluded widgets
  };

  // Widget-type → SVG display shown in the gallery cards: the real files
  // live in icons/widgets/, and their names do not follow the type ids.
  _stackWidgetSvgIcon(type, size = 112) {
    const svgNames = {
      applauncher: 'app_launcher.svg',
      battery: 'battery.svg',
      binaryclock: 'binary_clock.svg',
      calendar: 'calendar.svg',
      clock: 'clock.svg',
      digitalclock: 'digidal_clock.svg',
      folder: 'folder.svg',
      github: 'github.svg',
      lava: 'lavat.svg',
      music: 'music.svg',
      notes: 'notes.svg',
      photos: 'photo.svg',
      pomodoro: 'pomodoro.svg',
      screentime: 'sreen_time.svg',
      stopwatch: 'stopwatch.svg',
      system: 'system_monitor.svg',
      todo: 'task.svg',
      timer: 'timer.svg',
      weather: 'weather.svg',
    };

    const name = svgNames[type];
    if (!name || !EXTENSION_PATH) {
      return null;
    };

    const file = Gio.File.new_for_path(
      GLib.build_filenamev([EXTENSION_PATH, 'icons', 'widgets', name]));

    if (!file.query_exists(null)) {
      return null;
    };

    return new St.Icon({gicon: new Gio.FileIcon({file}), icon_size: size});
  };


  // ── Widget-pages gallery ─────────────────────────────────────────────
  // Same look as the pages panel: a centered rounded window with a header
  // (back, title, where the page goes, close), a search field and a grid
  // of tiles — preview, name and a one-line hint. A click adds the page;
  // back (or Escape) returns to the pages panel.
  _openStackGallery(view, slot = 'below') {
    // From which «Add page» the gallery was opened: 'above' stages the
    // picked page ABOVE the main widget, 'below' — after it.
    this._stackGallerySlot = slot;
    if (this._galleryPart)
      this._closeStackGallery({animate: false});

    const theme = this._gnomeTheme();
    const [stageW, stageH] = global.stage.get_size();
    const subtle = theme.dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.035)';
    const subtleHover = theme.dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.07)';
    const hostSize = view.widget.size ?? 'small';
    const typeName = type => WIDGET_TYPE_LABELS[type] ?? type;

    const overlay = new St.Widget({
      reactive: true,
      can_focus: true,
      x: 0,
      y: 0,
      width: Math.max(320, stageW),
      height: Math.max(240, stageH),
      style: 'background-color: rgba(0, 0, 0, 0.5);',
    });

    const cardW = Math.min(900, Math.max(340, stageW - 80));
    const cardH = Math.min(660, Math.max(320, stageH - 80));
    const card = new St.BoxLayout(boxLayoutProps({
      vertical: true,
      style: `background-color: ${theme.background};`
        + ` border: 1px solid ${theme.border};`
        + ` border-radius: ${Math.min(30, Math.max(14, theme.radius + 8))}px;`
        + ' padding: 18px; spacing: 14px;'
        + ' box-shadow: 0 12px 40px rgba(0,0,0,0.45);',
      reactive: true,
      can_focus: true,
    }));
    card.set_size(cardW, cardH);

    const backToPanel = () => {
      this._closeStackGallery({animate: false});
      this._openStackPanel(view);
    };
    const closeAll = () => this._closeStackGallery();

    // Header: back · title + where the page goes · close
    const header = new St.BoxLayout(boxLayoutProps({x_expand: true, style: 'spacing: 10px;'}));
    const backButton = this._stackPanelIconButton('go-previous-symbolic', _('Back'), theme);
    backButton.y_align = Clutter.ActorAlign.CENTER;
    this._stackPanelActivate(backButton, backToPanel);
    header.add_child(backButton);

    const titles = new St.BoxLayout(boxLayoutProps({
      vertical: true,
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
      style: 'spacing: 2px;',
    }));
    titles.add_child(this._label(_('Add a page'), 'widget-text',
      `font-size: 17px; font-weight: 800; color: ${theme.text};`));
    const where = slot === 'above' ? _('Above %s').format(typeName(view.widget.type))
      : _('Below %s').format(typeName(view.widget.type));
    titles.add_child(this._label(`${where} · ${sizeLabel(hostSize)}`, 'widget-text',
      `font-size: 12px; color: ${theme.muted};`));
    header.add_child(titles);

    const closeButton = this._stackPanelIconButton('window-close-symbolic', _('Close'), theme);
    closeButton.y_align = Clutter.ActorAlign.CENTER;
    this._stackPanelActivate(closeButton, closeAll);
    header.add_child(closeButton);
    card.add_child(header);

    // Search
    const search = new St.Entry({
      x_expand: true,
      can_focus: true,
      style: `background-color: ${subtle};`
        + ` border: 1px solid ${theme.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)'};`
        + ` border-radius: 12px; padding: 8px 12px; color: ${theme.text};`,
      hint_text: _('Search widgets'),
      primary_icon: new St.Icon({
        icon_name: 'system-search-symbolic',
        icon_size: 16,
        style: `color: ${theme.muted};`,
      }),
    });
    card.add_child(search);

    // Grid
    const scroll = new St.ScrollView({
      x_expand: true,
      y_expand: true,
      overlay_scrollbars: true,
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.AUTOMATIC,
      enable_mouse_scrolling: true,
    });
    const gridBox = new St.BoxLayout(boxLayoutProps({vertical: true, x_expand: true}));
    if (typeof scroll.set_child === 'function')
      scroll.set_child(gridBox);
    else
      scroll.add_actor(gridBox);
    card.add_child(scroll);

    const records = this._stackGalleryCatalog(view.widget);
    const GAP = 12;
    const MIN_TILE_W = 200;
    const innerW = cardW - 36 - 8; // padding + scrollbar room
    const columns = Math.max(1, Math.min(4, Math.floor((innerW + GAP) / (MIN_TILE_W + GAP))));
    const tileW = Math.floor((innerW - GAP * (columns - 1)) / columns);
    const previewH = Math.round(Math.min(150, Math.max(110, tileW * 0.6)));
    const canAdd = (view.widget.stack?.length ?? 0) < STACK_PAGE_LIMIT;

    const addPage = (record) => {
      if (!Array.isArray(view.widget.stack))
        view.widget.stack = [];
      if (view.widget.stack.length >= STACK_PAGE_LIMIT)
        return;
      const entry = makeStackEntry(record.type, record.defaultSize);
      entry.side = this._stackGallerySlot === 'above' ? 'above' : 'below';
      if (entry.side === 'above')
        view.widget.stack.unshift(entry);
      else
        view.widget.stack.push(entry);
      this._applyStackChange(view); // closes the gallery, reopens the panel
    };

    const makeTile = (record) => {
      const tile = new St.BoxLayout(boxLayoutProps({
        vertical: true,
        width: tileW,
        reactive: canAdd,
        can_focus: canAdd,
      }));
      tile.accessible_name = record.label;
      const shape = 'border-radius: 16px; padding: 8px 8px 10px 8px; spacing: 8px;';
      this._stackPanelHover(tile,
        `${shape} border: 2px solid transparent; background-color: ${subtle};`,
        `${shape} border: 2px solid ${canAdd ? theme.accent : 'transparent'}; background-color: ${subtleHover};`);

      const preview = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        x_expand: true,
        height: previewH,
        style: `border-radius: 11px; background-color: ${theme.dark ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.05)'};`,
      });
      const iconSize = Math.round(previewH * 0.78);
      const icon = this._stackWidgetSvgIcon(record.type, iconSize);
      if (icon) {
        icon.x_align = Clutter.ActorAlign.CENTER;
        icon.y_align = Clutter.ActorAlign.CENTER;
        preview.add_child(icon);
      } else {
        preview.add_child(new St.Icon({
          icon_name: 'application-x-addon-symbolic',
          icon_size: 40,
          x_align: Clutter.ActorAlign.CENTER,
          y_align: Clutter.ActorAlign.CENTER,
          style: `color: ${theme.muted};`,
        }));
      };
      tile.add_child(preview);

      const text = new St.BoxLayout(boxLayoutProps({vertical: true, style: 'spacing: 2px; padding: 0 4px;'}));
      const name = this._label(record.label, 'widget-text',
        `font-size: 14px; font-weight: 700; color: ${theme.text};`);
      name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
      text.add_child(name);
      if (record.description) {
        const hint = this._label(record.description, 'widget-text',
          `font-size: 12px; color: ${theme.muted};`);
        hint.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(hint);
      };
      tile.add_child(text);

      if (canAdd)
        this._stackPanelActivate(tile, () => addPage(record));
      return tile;
    };

    let firstMatch = null;
    const rebuildGrid = () => {
      gridBox.destroy_all_children();
      const query = (search.get_text() ?? '').trim().toLocaleLowerCase();
      const terms = query.split(/\s+/).filter(Boolean);
      const matching = records.filter(record =>
        terms.every(term => `${record.label} ${record.type} ${record.description}`.toLocaleLowerCase().includes(term)));
      firstMatch = matching[0] ?? null;

      if (matching.length === 0) {
        const empty = new St.BoxLayout(boxLayoutProps({
          vertical: true,
          x_expand: true,
          x_align: Clutter.ActorAlign.CENTER,
          style: 'padding: 48px; spacing: 10px;',
        }));
        empty.add_child(new St.Icon({
          icon_name: 'system-search-symbolic',
          icon_size: 32,
          x_align: Clutter.ActorAlign.CENTER,
          style: `color: ${theme.muted};`,
        }));
        empty.add_child(this._label(_('No widgets found'), 'widget-text',
          `font-size: 13px; color: ${theme.muted};`));
        gridBox.add_child(empty);
        return;
      };

      const layout = new Clutter.GridLayout({column_spacing: GAP, row_spacing: GAP});
      const grid = new St.Widget({layout_manager: layout, x_expand: true, style: 'padding: 2px;'});
      matching.forEach((record, index) => {
        layout.attach(makeTile(record), index % columns, Math.floor(index / columns), 1, 1);
      });
      gridBox.add_child(grid);
    };
    search.clutter_text.connectObject('text-changed', () => rebuildGrid(), search);
    // Enter adds the first match.
    search.clutter_text.connectObject('activate', () => {
      if (firstMatch && canAdd)
        addPage(firstMatch);
    }, search);
    rebuildGrid();

    card.connect('button-press-event', () => Clutter.EVENT_STOP);
    card.connect('button-release-event', () => Clutter.EVENT_STOP);
    overlay.connect('button-press-event', () => {
      backToPanel();
      return Clutter.EVENT_STOP;
    });

    card.set_position(
      Math.round(Math.max(16, (stageW - cardW) / 2)),
      Math.round(Math.max(16, (stageH - cardH) / 2)));
    overlay.add_child(card);
    Main.uiGroup.add_child(overlay);
    this._galleryPart = overlay;

    card.opacity = 0;
    card.translation_y = 12;
    card.ease({opacity: 255, translation_y: 0, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});

    // Typing works straight away: once mapped, the search entry takes key
    // focus (pushModal focuses the overlay itself). St.Widget has no 'map'
    // signal — notify::mapped is the one to use.
    overlay.connectObject('notify::mapped', () => {
      if (overlay.mapped && !overlay.searchFocused) {
        overlay.searchFocused = true;
        search.clutter_text.grab_key_focus();
      };
    }, overlay);

    // Escape: back to the pages panel. Caught in the capture phase so the
    // search entry cannot swallow it.
    global.stage.connectObject('captured-event', (_stage, event) => {
      if (event.type() === Clutter.EventType.KEY_PRESS
        && event.get_key_symbol() === Clutter.KEY_Escape) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          if (this._galleryPart === overlay)
            backToPanel();
          return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_STOP;
      };
      return Clutter.EVENT_PROPAGATE;
    }, overlay);

    // Real modal grab (Wayland): routes keys to the shell. ActionMode NORMAL
    // keeps system keybindings (screenshots) alive.
    overlay.modalGrab = Main.pushModal(overlay, {actionMode: Shell.ActionMode.NORMAL});
  };

  _closeStackGallery({animate = true} = {}) {
    const overlay = this._galleryPart;
    if (!overlay)
      return;
    this._galleryPart = null;
    // Release the modal grab BEFORE destroying (or fading) the overlay.
    if (overlay.modalGrab && !isActorDestroyed(overlay)) {
      Main.popModal(overlay.modalGrab);
      overlay.modalGrab = null;
    };
    if (isActorDestroyed(overlay))
      return;
    global.stage.disconnectObject(overlay);

    const card = overlay.get_child_at_index(0);
    if (!animate || !card) {
      overlay.destroy();
      return;
    };
    overlay.reactive = false;
    card.remove_all_transitions();
    card.ease({
      opacity: 0,
      translation_y: 12,
      duration: 140,
      mode: Clutter.AnimationMode.EASE_IN_QUAD,
      onStopped: () => {
        if (!isActorDestroyed(overlay))
          overlay.destroy();
      },
    });
  };


  // Runs (and disconnects) the 'destroy' handlers the previous render hung
  // on this body. A refill (resize, refresh, theme) destroys only the
  // body's CHILDREN — the body survives — so those handlers never fired:
  // a running stopwatch/timer/pomodoro kept ticking into disposed labels
  // after a resize (and persisted stale state), notes kept its settings
  // handlers, etc. This gives every render the teardown it expects.
  _runBodyDisposers(body) {
    const disposers = body._dwDisposers ?? [];
    body._dwDisposers = [];
    for (const {id, handler} of disposers) {
      try {
        body.disconnect(id);
      } catch (_e) {}
      try {
        handler(body);
      } catch (e) {
        warn('widget-teardown', `Widget teardown failed: ${e}`);
      };
    };
  };

  _fillWidgetBody(widget, body, paneRootOverride = null) {
    this._runBodyDisposers(body);
    body.destroy_all_children();
    const widgetModule = WIDGETS.get(widget.type);

    if (!widgetModule?.render) {
      body.add_child(this._label(_('Unknown widget'), 'widget-text'));
      return;
    };

    // Record the 'destroy' handlers this render connects on the body, so
    // the next refill can run them (see _runBodyDisposers).
    body._dwDisposers = [];
    const nativeConnect = body.connect;
    let patched = false;
    try {
      body.connect = function (signal, handler, ...rest) {
        const id = nativeConnect.call(this, signal, handler, ...rest);
        if (signal === 'destroy' && typeof handler === 'function')
          this._dwDisposers.push({id, handler});
        return id;
      };
      patched = Object.prototype.hasOwnProperty.call(body, 'connect');
    } catch (_e) {
      // The wrapper refused the override: render without recording
      // (old behaviour) rather than failing the whole refill.
      patched = false;
    };
    try {
      this._renderWidgetModule(widgetModule, widget, body, paneRootOverride);
    } finally {
      if (patched) {
        try {
          delete body.connect;
        } catch (_e) {}
      };
    };
  };

  _renderWidgetModule(widgetModule, widget, body, paneRootOverride) {
    widgetModule.render({
        body,
        widget,
        theme: this._gnomeTheme(),
        weather: this._weather,
        weatherLocation: this._weatherLocation,
        createLabel: this._label.bind(this),
        sizeForWidget: this._sizeFor.bind(this),
        settings: this._layoutSettings,
        events: this._eventsClient,
        // The pane wrapper (plain fixed layout, unpadded/unclipped) —
        // widgets that need absolute overlays (system monitor page dashes)
        // pin them here, escaping the pane's padding and the body clip.
        // A stacked page passes ITS OWN actor so its overlays travel with
        // the page (paneRootOverride).
        paneRoot: paneRootOverride ?? this._views.get(widget.id)?.actor ?? null,
        onPhotoChange: path => this._setWidgetPhoto(widget, body, path),
        suppressAppClick: () => {
          this._suppressAppClickUntil = Date.now() + 400;
        },
      });
    // Widget-in-widget: a primary with added pages gets its stack mounted
    // (kept across plain refills; rebuilt when the host's size changed).
    const hostView = paneRootOverride ? null : this._views.get(widget.id);
    if (hostView && hostView.body === body)
      this._ensureStack(hostView);

  };

  _refreshCalendarWeekdays() {
    for (const [id, view] of this._views) {
      if (view.widget.type !== 'calendar' || !view.body) {
        continue;
      };

      try {
        this._fillWidgetBody(view.widget, view.body);
      } catch (error) {
        warn('calendar-weekday-refresh', `refresh failed: ${error}`);
      };
    };
  };

  _setWidgetPhoto(widget, body, path) {
    if (!widget || !path || widget.type !== 'photos') {
      return;
    };

    widget.data = {...(widget.data ?? {}), photo: path};

    if (!widget.data.sizeManual) {
      const sizeKey = PhotosWidget.preferredSize(this._layoutSettings, widget);

      if (sizeKey && widget.size !== sizeKey) {
        this._onWidgetSizeChange(widget, sizeKey);
      };
    };

    this._saveWidgets();
    this._safeFillWidgetBody(widget, body);
    // Glass follows the photo state: placeholder keeps the glass backdrop,
    // a real photo removes it (re-selecting empty state brings it back).
    this._syncWidgetGlass(widget);
  };

  _label(text, styleClass, style = null) {
    const params = {
      text,
      style_class: styleClass,
      x_expand: true,
      x_align: Clutter.ActorAlign.START,
    };

    if (style) {
      params.style = style;
    };

    const label = new St.Label(params);

    label.clutter_text.set_line_wrap(true);
    label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

    return label;
  };

  _readWidgetGap() {
    try {
      const gap = this._layoutSettings.get_int('widget-gap');
      return Number.isFinite(gap) && gap >= 0 ? gap : 15;
    } catch (_error) {
      return 15;
    };
  };

  // The widget size always comes from the current gap so that the actor and
  // its content never disagree on the numbers.
  _sizeFor(widget) {
    return sizeForWidget(widget, this._widgetGap ?? WIDGET_GAP);
  };

  _rectFor(widget) {
    return rectForWidget(widget, this._widgetGap ?? WIDGET_GAP);
  };

  _clampWidget(widget) {
    const layerX = this._layerX ?? 0;
    const layerY = this._layerY ?? 0;
    const [width, height] = this._sizeFor(widget);
    const monitor = monitorAtStage(
      effectiveMonitors(),
      widget.x + layerX + width / 2,
      widget.y + layerY + height / 2);

    if (!monitor) {
      return false;
    };

    const monX = monitor.x - layerX;
    const monY = monitor.y - layerY;
    const gap = this._widgetGap ?? WIDGET_GAP;
    const minX = monX + gap;
    const minY = monY + topYFor(monitor) + gap;
    const maxX = Math.max(minX, monX + monitor.width - width - gap);
    const maxY = Math.max(minY, monY + monitor.height - height - gap);
    const x = clamp(widget.x, minX, maxX);
    const y = clamp(widget.y, minY, maxY);

    if (x === widget.x && y === widget.y) {
      return false;
    };

    widget.x = x;
    widget.y = y;

    return true;
  };

  _animateWidget(widget, animate) {
    const view = this._views.get(widget.id);

    if (!view) {
      return;
    };

    const [width, height] = this._sizeFor(widget);

    if (!animate) {
      view.actor.set_position(widget.x, widget.y);
      view.actor.set_size(width, height);
      // notify::width/height hooks don't reliably track cluster changes, so
      // sync the children we care about right here.
      if (view.box) {
        view.box.set_size(width, height);
      };

      if (view.glass && width > 0 && height > 0) {
        view.glass.set_size(width, height);
        const [gsx, gsy] = view.actor.get_transformed_position();

        if (Number.isFinite(gsx) && Number.isFinite(gsy)) {
          view.glass.setGeometry(gsx, gsy, width, height);
        };
      };

      this._syncEditControls(widget);
      return;
    };

    const [curW, curH] = view.actor.get_size();
    const duration = 200;
    const mode = Clutter.AnimationMode.EASE_OUT_CUBIC;

    // The frame, the styled content box and the glass pane tween together so
    // nothing snaps at the end of the animation; the body keeps reflowing
    // inside the box (clip_to_allocation) instead of popping.
    view.actor.ease({
      x: widget.x,
      y: widget.y,
      width,
      height,
      duration,
      mode,
    });

    if (view.box?.ease) {
      view.box.ease({
        width,
        height,
        duration,
        mode,
      });
    };

    if (view.glass?.ease) {
      view.glass.ease({
        width,
        height,
        duration,
        mode,
      });
    };

    this._syncEditControls(widget, true);
  };

  _positionIsFreeAgainst(widget, x, y, blockingWidgets) {
    const [width, height] = this._sizeFor(widget);
    const rect = {x, y, width, height};
    const gap = this._widgetGap ?? WIDGET_GAP;

    return !blockingWidgets.some(other => other !== widget && rectsOverlap(rect, this._rectFor(other), gap));
  };

  _findOpenPosition(widget, blockingWidgets = []) {
    const layerX = this._layerX ?? 0;
    const layerY = this._layerY ?? 0;
    const [width, height] = this._sizeFor(widget);
    const monitor = monitorAtStage(
      effectiveMonitors(),
      widget.x + layerX + width / 2,
      widget.y + layerY + height / 2);

    if (!monitor) {
      return {x: widget.x, y: widget.y};
    };

    const monX = monitor.x - layerX;
    const monY = monitor.y - layerY;
    const gap = this._widgetGap ?? WIDGET_GAP;
    const minX = monX + gap;
    const minY = monY + topYFor(monitor) + gap;
    const maxX = Math.max(minX, monX + monitor.width - width - gap);
    const maxY = Math.max(minY, monY + monitor.height - height - gap);
    const originX = clamp(widget.x, minX, maxX);
    const originY = clamp(widget.y, minY, maxY);
    const candidates = [];

    for (let y = minY; y <= maxY; y += GRID_SIZE) {
      for (let x = minX; x <= maxX; x += GRID_SIZE) {
        const snappedX = clamp(x, minX, maxX);
        const snappedY = clamp(y, minY, maxY);
        const distance = Math.abs(snappedX - originX) + Math.abs(snappedY - originY);
        candidates.push({x: snappedX, y: snappedY, distance});
      };
    };

    candidates.sort((a, b) => a.distance - b.distance);

    for (const candidate of candidates) {
      if (this._positionIsFreeAgainst(widget, candidate.x, candidate.y, blockingWidgets)) {
        return {x: candidate.x, y: candidate.y};
      };
    };

    return {x: originX, y: originY};
  };

  _resolveLayout(anchor = null, animate = false, save = false) {
    const orderedWidgets = anchor
      ? [anchor, ...this._widgets.filter(widget => widget !== anchor)]
      : [...this._widgets];
    const settled = [];
    const before = new Map(this._widgets.map(widget => [widget.id, {x: widget.x, y: widget.y}]));
    const gap = this._widgetGap ?? WIDGET_GAP;
    let changed = false;

    for (const widget of orderedWidgets) {
      if (widget.pinned) {
        settled.push(widget);
        continue;
      };

      this._clampWidget(widget);

      if (settled.some(other => rectsOverlap(this._rectFor(widget), this._rectFor(other), gap))) {
        // First, try spreading the stack (column/row) around the anchor/middle,
        // and only if that fails and overlap remains — a free cell.
        this._spaceOut(widget, settled, anchor === widget ? widget : null);

        if (settled.some(other => rectsOverlap(this._rectFor(widget), this._rectFor(other), gap))) {
          const position = this._findOpenPosition(widget, settled);
          widget.x = position.x;
          widget.y = position.y;
          this._clampWidget(widget);
        };
      };

      settled.push(widget);
    };

    for (const widget of this._widgets) {
      const was = before.get(widget.id);

      if (was && (was.x !== widget.x || was.y !== widget.y)) {
        changed = true;
        this._animateWidget(widget, animate);
      };
    };

    if (changed && save) {
      this._saveWidgets();
    };

    return changed;
  };

  
};

export default class DesktopWidgetsExtension extends Extension {
  // GNOME extension lifecycle. enable() creates the WidgetController (which
  // builds the widget layer) and must be idempotent across lock screens;
  // disable() releases everything (timers, signals, stylesheet themes) so the
  // extension can be re-enabled without restart. Widget actor weights/styles
  // live in the controller, not here.
  _loadWidgetStylesheets() {
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    this._widgetStylesheets = [];

    for (const widgetModule of WIDGET_MODULES) {
      if (!widgetModule.stylesheet) {
        continue;
      };

      const file = Gio.File.new_for_path(GLib.build_filenamev([EXTENSION_PATH, widgetModule.stylesheet]));

      if (!file.query_exists(null)) {
        continue;
      };

      theme.load_stylesheet(file);
      this._widgetStylesheets.push(file);
    };
  };

  _unloadWidgetStylesheets() {
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();

    for (const file of this._widgetStylesheets ?? []) {
      theme.unload_stylesheet(file);
    };

    this._widgetStylesheets = [];
  };

  enable() {
    configureLogger(this.getLogger());
    this._loadWidgetStylesheets();
    this._controller = new WidgetController(this);
    this._controller.enable();
    // Opt-in daily "is a newer version out?" check (Settings → About).
    this._updateChecker = new UpdateChecker(this, this.getSettings());
  };

  disable() {
    this._updateChecker?.destroy();
    this._updateChecker = null;
    this._controller?.destroy();
    this._controller = null;
    PhotosWidget.cleanup();
    this._unloadWidgetStylesheets();
    resetLogger();
  };
};
