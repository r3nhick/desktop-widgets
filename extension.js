import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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
import * as ScreenTimeWidget from './widgets/screentime/widget.js';
import * as SystemWidget from './widgets/system/widget.js';
import * as NotesWidget from './widgets/notes/widget.js';
import { configureLogger, resetLogger, warn } from './logger.js';
import { assetPath } from './paths.js';
import { isActorDestroyed } from './utils/actorLifecycle.js';
import { GlassBlur } from './utils/glassBlur.js';
import { clamp } from './utils.js';
import { WorkspaceIntegration } from './workspaceIntegration.js';
import { LAYOUT_KEY, LAYOUT_VERSION, layoutJson } from './layoutDoc.js';

const EXTENSION_PATH = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const GRID_SIZE = 20;
const WIDGET_GAP = 15;
const SNAP_DISTANCE = 12;
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
];
const WIDGETS = new Map(WIDGET_MODULES.map(widgetModule => [widgetModule.type, widgetModule]));

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
// Сітка віджета: [колонки, рядки, сім'я]. Джерело істини про форму розміру.
// Віджет на n клітинок має ширину n * база + (n - 1) * gap, тож 2x1 сідає
// впритук до двох 1x1 з одним зазором між ними, а не ширше за них.
const MAIN_FAMILY = 'main';
const MINI_FAMILY = 'mini';
const WIDGET_CELL_SIZES = {[MAIN_FAMILY]: CELL_SIZE, [MINI_FAMILY]: MINI_CELL_SIZE};
const WIDGET_SIZE_SHAPES = {
  minismall: [1, 1, MINI_FAMILY], // 1x1 mini
  mini: [2, 1, MINI_FAMILY], // 2x1 mini
  portraitmini: [1, 2, MINI_FAMILY], // 1x2 mini
  minilarge: [2, 2, MINI_FAMILY], // 2x2 mini
  small: [1, 1, MAIN_FAMILY], // 1x1
  medium: [2, 1, MAIN_FAMILY], // 2x1
  portrait: [1, 2, MAIN_FAMILY], // 1x2
  large: [2, 2, MAIN_FAMILY], // 2x2
  tall: [2, 4, MAIN_FAMILY], // 2x4
  wide: [4, 2, MAIN_FAMILY], // 4x2
  huge: [4, 4, MAIN_FAMILY], // 4x4
};
const WIDGET_SIZE_KEYS = new Set(Object.keys(WIDGET_SIZE_SHAPES));

function widgetSizesFor(gap) {
  const sizes = {};

  for (const [key, [cols, rows, family]] of Object.entries(WIDGET_SIZE_SHAPES)) {
    const base = WIDGET_CELL_SIZES[family];

    sizes[key] = [cols * base + (cols - 1) * gap, rows * base + (rows - 1) * gap];
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

  // Кожен край пресета береться з розміру віджета, який його тримає: правий
  // стовпець це 2x1, лівий маленький віджет це 1x1, міні рядок це 2x1 mini.
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

function sizeForWidget(widget, gap) {
  const key = widget.size && WIDGET_SIZE_KEYS.has(widget.size)
    ? widget.size
    : defaultSizeKeyFor(widget.type);
  const [cols, rows, family] = WIDGET_SIZE_SHAPES[key];
  const base = WIDGET_CELL_SIZES[family];

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
    this._editMode = false;
    this._dragActor = null;
    this._layerX = null;
    this._layerY = null;
    this._needsLayoutPersist = false;
    this._pendingRepack = false;
    this._eventsClient = new CalendarWidget.CalendarEventsClient();
    this._lastAppLaunchAt = 0;
    this._suppressAppClickUntil = 0;
    this._workspaceIntegration = new WorkspaceIntegration();
    this._layoutSettings = extension.getSettings();
    this._interfaceSettings = new Gio.Settings({schema_id: INTERFACE_SCHEMA});
    this._weatherSettings = new Gio.Settings({schema_id: WeatherWidget.settingsSchema});
    this._weather = null;
    this._weatherLocation = null;
    this._weatherInfo = null;
    this._weatherUpdating = false;
    this._weatherUpdateTime = 0;
    this._glass = new GlassBlur({
      isEnabled: () => this._layoutSettings?.get_boolean('style-light-glass') ?? false,
      blur: () => this._layoutSettings?.get_int('style-light-glass-blur') ?? 0,
      cornerRadius: () => this._layoutSettings?.get_int('style-border-radius') ?? 16,
      scaleFactor: () => St.ThemeContext.get_for_stage(global.stage).scale_factor,
      warn: (key, message) => warn(key, message),
    });
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
        // Один крок розкладки на осідання повзунка: перебудувати актори за
        // новим зазором, розкласти їх з анімацією і зберегти результат.
        this._debounce('gap-rebuild', () => {
          this._rebuildWidgets();
          this._resolveLayout(null, true, true);
        }, 200);
      },
      'changed::photo-size', () => this._scheduleAppearance('refresh'),
      'changed::battery-icon-size', () => this._scheduleAppearance('refresh'),
      'changed::battery-slot-count', () => this._scheduleAppearance('refresh'),
      'changed::battery-show-percent', () => this._scheduleAppearance('refresh'),
      'changed::arrange-widgets', () => this._onArrangeRequested(),
      'changed::edit-mode-binding', () => this._registerEditModeBinding(),
      'changed::calendar-weekday-format', () => this._refreshCalendarWeekdays(),
      'changed::digitalclock-hour-format', () => this._scheduleAppearance('refresh'),
      'changed::digitalclock-show-seconds', () => this._scheduleAppearance('refresh'),
      'changed::digitalclock-show-ampm', () => this._scheduleAppearance('refresh'),
      'changed::github-use-green', () => this._scheduleAppearance('refresh'),
      'changed::github-username', () => this._scheduleAppearance('refresh'),
      'changed::style-border-radius', () => this._scheduleAppearance('rebuild'),
      'changed::style-border-width', () => this._scheduleAppearance('rebuild'),
      'changed::style-background', () => this._scheduleAppearance('rebuild'),
      'changed::style-border-color', () => this._scheduleAppearance('rebuild'),
      'changed::style-shadow', () => this._scheduleAppearance('rebuild'),
      'changed::style-widget-opacity', () => this._scheduleAppearance('rebuild'),
      'changed::style-use-custom-accent', () => this._scheduleAppearance('rebuild'),
      'changed::style-accent-color', () => this._scheduleAppearance('rebuild'),
      'changed::style-light-glass', () => this._scheduleAppearance('rebuild'),
      // Glass is applied in place: a rebuild would tear down every widget, and
      // _scheduleAppearance() holds changes back until the slider is released,
      // which is exactly the lag a live blur must not have. The radius is a
      // plain effect property, so it needs no re-cropping at all.
      'changed::style-light-glass-blur', () => this._syncGlass(),
      'changed::style-light-glass-opacity', () => this._restyleWidgets(),
      'changed::drag-active', () => this._onDragActiveChanged(),
      this
    );
    this._createLayer();
    this._rebuildWidgets();

    // Розкладка, збережена до нової формули розмірів, перепаковується один раз
    // після того, як шар та актори вже існують.
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

    if (this._layoutSettings.get_boolean('arrange-widgets')) {
      this._onArrangeRequested();
    };

    Main.layoutManager.connectObject(
      'monitors-changed', () => this._syncLayerGeometry(),
      this
    );
  };

  destroy() {
    this._glass?.destroy();
    this._glass = null;

    this._eventsClient?.destroy();
    this._eventsClient = null;
    this._workspaceIntegration.destroy();

    this._batteryDevicesUnsubscribe?.();
    this._batteryDevicesUnsubscribe = null;

    for (const record of Object.values(this._debounceTimers)) {
      if (record?.id) GLib.source_remove(record.id);
    }
    this._debounceTimers = {};

    if (this._dragSafetyId) {
      GLib.source_remove(this._dragSafetyId);
      this._dragSafetyId = 0;
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

    this._clearWeatherInfo();

    this._destroyLayer();
    this._layoutSettings = null;
    this._interfaceSettings = null;
    this._weatherSettings = null;
    this._extension = null;
  };

  _debounce(key, callback, delay = 200) {
    if (this._debounceTimers[key]) {
      GLib.source_remove(this._debounceTimers[key].id);
    }

    this._debounceTimers[key] = {
      since: Date.now(),
      id: GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
        callback();
        this._debounceTimers[key] = 0;
        return GLib.SOURCE_REMOVE;
      }),
    };
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
          pinned: !!widget.pinned,
        };
      });

    const savedVersion = parsed.version ?? 1;

    if (savedVersion !== LAYOUT_VERSION) {
      // Зсув на головний монітор уже застосовувався на шляху 1 -> 2, тож
      // повторюємо його лише для схем без версії та для версії 1.
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
      // Перепакування можливе лише після того, як існують шар та віджети,
      // тому enable() розбирає цей прапорець після першої перебудови.
      this._pendingRepack = true;
    };

    return widgets;
  };

  _loadWidgets() {
    const serialized = this._layoutSettings.get_string(LAYOUT_KEY);
    const widgets = serialized ? this._parseWidgets(serialized) : cloneDefaultWidgets(this._widgetGap ?? WIDGET_GAP);

    if (this._needsLayoutPersist) {
      this._widgets = widgets;
      this._saveWidgets();
      this._needsLayoutPersist = false;
    };

    return widgets;
  };

  _saveWidgets() {
    try {
      // _lastSavedJson ставиться перед записом, щоб обробник changed::layout-json
      // впізнав власний запис і не перебудовував віджети.
      this._lastSavedJson = layoutJson(this._widgets);
      this._layoutSettings.set_string(LAYOUT_KEY, this._lastSavedJson);
    } catch (e) {
      logError(e, 'desktop-widgets: _saveWidgets failed');
      throw e;
    }
  };

  _clearViews() {
    for (const view of this._views.values()) {
      view.sizeMenu?.destroy();
      view.contextMenu?.destroy();
      view.actor.disconnectObject(this);
    };

    this._views.clear();
  };

  _destroyLayer() {
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
      // Not reactive: the layer spans the whole desktop, so making it reactive
      // would swallow every left-click meant for GNOME (desktop menu, etc.).
      // Widget actors are reactive on their own, so clicks on them still work.
      reactive: false,
      x_expand: true,
      y_expand: true,
    });

    backgroundGroup.add_child(this._layer);
    this._syncLayerGeometry();
    this._workspaceIntegration.setSource(this._layer);
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

  _gnomeTheme() {
    const dark = darkStyleEnabled(this._interfaceSettings);
    const lightGlass = this._layoutSettings.get_boolean('style-light-glass');
    const backgroundSetting = this._layoutSettings.get_string('style-background');
    const borderSetting = this._layoutSettings.get_string('style-border-color');
    const opacity = this._layoutSettings.get_double('style-light-glass-opacity');

    const background = lightGlass
      ? colorToRgba(backgroundSetting || (dark ? '#242424' : '#ffffff'), opacity)
      : (backgroundSetting || (dark ? '#242424' : '#ffffff'));
    const border = borderSetting || (lightGlass ? 'rgba(255, 255, 255, 0.3)' : (dark ? '#3d3d3d' : '#deddda'));

    return {
      dark,
      lightGlass,
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

  _styleForWidget(widget) {
    const widgetModule = WIDGETS.get(widget.type);

    if (!widgetModule?.style) {
      return null;
    };

    const theme = this._gnomeTheme();
    let styleStr = widgetModule.style(theme);

    // Текстовий колір рамки задаємо тут, а не в stylesheet.css: там він був
    // захардкоджений під темну тему, тож у світлій віджети лишались без
    // тексту. Модулі, що ставлять власний color, ставлять такий самий
    // theme.text, тому перекриття безпечне.
    styleStr += ` color: ${theme.text};`;

    // Apply custom global styles dynamically
    if (theme.radius !== 16) {
      styleStr += ` border-radius: ${theme.radius}px;`;
    } else if (theme.lightGlass) {
      // The blur is masked to the widget's own rounding by a shader, so the
      // rounding has to be the one the glass was told about - otherwise the mask
      // and the widget disagree and the corners leak.
      styleStr += ' border-radius: 16px;';
    }
    if (theme.borderWidth !== 1) {
      styleStr += ` border-width: ${theme.borderWidth}px;`;
    }
    if (theme.shadow) {
      styleStr += ` box-shadow: ${theme.shadow};`;
    } else if (theme.lightGlass) {
      // Glass carries no shadow: the blur is the whole effect, and a shadow
      // only reads as a halo spilling past the widget's own edges. This also
      // cancels the drop shadow stylesheet.css puts on every widget.
      styleStr += ' box-shadow: none;';
    }

    return styleStr;
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

    for (const view of this._views.values()) {
      if (enabled) {
        if (!view.draggable) {
          this._makeDraggable(view);
        };

        if (!view.editBorder) {
          this._addEditControls(view);
        };
      } else {
        this._cancelActiveDrag();
        this._hideContextMenus();
        // A size switch may still be mid-animation; snap the widget to its
        // final size/position so nothing is left at an intermediate state
        // after leaving edit mode.
        this._animateWidget(view.widget, false);
        view.contextMenu?.destroy();
        view.contextMenu = null;
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
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
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
    view.contextMenu?.destroy();
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
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
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

    // Знайти віджет, з яким перетинаємося. Pinned підходить як ціль:
    // він не рухається, тому віджет, що тягнеш, прилипає поруч з ним.
    const overlapping = this._widgets.find(other =>
      other !== widget && rectsOverlap(widgetRect, this._rectFor(other), gap));

    if (!overlapping) {
      return {x: widget.x, y: widget.y};
    };

    const [ow, oh] = this._sizeFor(overlapping);

    // Чотири позиції вздовж краю зачепленого віджета: зліва, справа, зверху, знизу.
    const candidates = [
      {x: overlapping.x - width - gap, y: widget.y},
      {x: overlapping.x + ow + gap, y: widget.y},
      {x: widget.x, y: overlapping.y - height - gap},
      {x: widget.x, y: overlapping.y + oh + gap},
    ];

    // Кандидат має вміщуватися в моніторі з відступом gap: інакше після clamp'у
    // віджет повернеться назад на зачеплений стос і лишиться в перетині.
    const minX = (monitor?.x ?? layerX) - layerX + gap;
    const minY = (monitor?.y ?? layerY) - layerY + topYFor(monitor) + gap;
    const maxX = monitor ? Math.max(minX, monitor.x - layerX + monitor.width - width - gap) : Infinity;
    const maxY = monitor ? Math.max(minY, monitor.y - layerY + monitor.height - height - gap) : Infinity;
    const inBounds = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;

    // Найближча вільна позиція за Manhattan distance від місця drop.
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

    // Якщо всі чотири краї зайняті чи поза межами, шукаємо будь-яку вільну клітинку на сітці монітора.
    if (!best) {
      return this._findOpenPosition(widget, this._widgets);
    };

    return {x: best.x, y: best.y};
  };

  // Розсунути «стос» (щільний вертикальний стовпчик або горизонтальний ряд),
  // щоб вмістити віджет без викидання його у вільну клітинку:
  // середній (або закріплений / вказаний) лишається на місці, решта розсувається.
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

    // Вертикальний стос: віджети в тій самій колонці (перетин проєкцій по X).
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

    // Горизонтальний ряд: віджети в тому самому ряду (перетин проєкцій по Y).
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

  // Щільний безперервний ланцюжок віджетів навколо widget вздовж осі:
  // сусіди, що прилягають один до одного з відступом не більшим за gap.
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

  // Переставити членів стосу вздовж осі так, щоб усі відступи стали точними.
  // Якір (середній / закріплений / anchorTarget) не рухається; якщо з одного боку
  // немає місця — якір переноситься на край; якщо не вміщується зовсім —
  // зайві віджети виїжджають у вільні клітинки (_findOpenPosition).
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
        // Не вміщується ні з одного боку: якір на край, зайве виїде.
        anchorIndex = start;
        placed = place(start, end);
      } else if (placed.overflowLow) {
        // Нема місця зверху/зліва: крайній лишається, решта рухається від нього.
        anchorIndex = start;
        placed = place(start, end);
      } else if (placed.overflowHigh) {
        // Нема місця знизу/справа: крайній лишається, решта рухається від нього.
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

    // Валідація: нові позиції не мають перетинатися з віджетами поза стосом.
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

    // Викинуті за межі стосу — у найближчу вільну клітинку.
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
  };

  _onWidgetSizeChange(widget, sizeKey) {
    if (!widget || !WIDGET_SIZE_KEYS.has(sizeKey)) {
      return;
    };

    if (widget.size === sizeKey) {
      return;
    };

    widget.size = sizeKey;
    this._clampWidget(widget);
    this._resolveLayout(widget, true, true);
    this._animateWidget(widget, true);
  };

  _setWidgetSize(widget, sizeKey) {
    if (!widget || !WIDGET_SIZE_KEYS.has(sizeKey) || widget.size === sizeKey) {
      return;
    };

    widget.size = sizeKey;
    widget.data = {...(widget.data ?? {}), sizeManual: true};
    this._views.get(widget.id)?.sizeMenu?.hide();
    this._safeFillWidgetBody(widget, this._views.get(widget.id)?.body);
    this._clampWidget(widget);
    this._resolveLayout(widget, true, true);
    this._animateWidget(widget, true);
    this._saveWidgets();
  };

  _refreshWidgets() {
    if (this._dragActor) {
      return;
    };

    this._refreshWeather(false);

    for (const [id, view] of this._views) {
      if (!['battery', 'calendar', 'digitalclock', 'photos', 'weather', 'github'].includes(view.widget.type)) {
        continue;
      };

      try {
        if (view.actor.get_parent() !== this._layer || view.body.get_parent() !== view.actor) {
          view.actor.disconnectObject(this);
          this._views.delete(id);
          continue;
        };

        this._fillWidgetBody(view.widget, view.body);
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
    const actorParams = {
      vertical: true,
      style_class: `widget widget-${widget.type}`,
      reactive: true,
      can_focus: true,
      track_hover: true,
    };
    const style = this._styleForWidget(widget);

    if (style) {
      actorParams.style = style;
    };

    const actor = new St.BoxLayout(actorParams);

    actor.set_size(width, height);
    actor.set_position(widget.x, widget.y);

    const opacity = this._layoutSettings.get_double('style-widget-opacity');
    actor.opacity = Math.round(clamp(opacity, 0, 1) * 255);

    const body = new St.BoxLayout({
      vertical: true,
      style_class: 'widget-body',
      x_expand: true,
      y_expand: true,
    });
    actor.add_child(body);

    this._layer.add_child(actor);
    const view = {
      widget,
      actor,
      body,
      draggable: false,
      editBorder: null,
      removeButton: null,
      pinButton: null,
      sizeButton: null,
      sizeMenu: null,
      photoButton: null,
    };
    this._views.set(widget.id, view);

    if (this._editMode) {
      this._makeDraggable(view);
      this._addEditControls(view);
    };

    this._safeFillWidgetBody(widget, body);
  };

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

      if (style) view.actor.set_style(style);
    };

    this._syncGlass();
  };

  /**
   * Hands the live widgets to GlassBlur, which attaches the backdrop blur only
   * to the ones that should have it. Nothing here re-crops or reloads: the blur
   * is a GPU effect that follows the actor, so this is cheap enough to run
   * while a slider is being dragged.
   */
  _syncGlass() {
    if (!this._glass) {
      return;
    };

    const views = [...this._views.values()]
      .filter(view => view.actor && !NO_GLASS_BACKDROP.has(view.widget.type))
      .map(view => ({...view, id: view.widget.id}));

    this._glass.sync(views);
  };

  _safeFillWidgetBody(widget, body) {
    if (!body) {
      return;
    };

    try {
      this._fillWidgetBody(widget, body);
    } catch (error) {
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

    const overlay = this._rectFor(widget);
    const button = this._removeButtonPosition(widget, view.removeButton);
    const pin = this._pinButtonPosition(widget);
    const size = this._sizeButtonPosition(widget, view.sizeButton);
    const photo = this._photoButtonPosition(widget, view.photoButton);

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
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
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

    if (supportedSizes.length > 0) {
      sizeButton = new St.Button({
        style_class: 'icon-button widget-edit-size',
        icon_name: 'view-grid-symbolic',
        reactive: true,
        can_focus: true,
        track_hover: true,
        accessible_name: _('Widget size'),
      });

      this._layer.add_child(sizeButton);

      sizeMenu = new St.BoxLayout({
        vertical: true,
        style_class: 'widget-size-menu',
        reactive: true,
      });
      this._layer.add_child(sizeMenu);
      sizeMenu.hide();

      let sizeMenuDestroyed = false;
      sizeMenu.connect('destroy', () => {
        sizeMenuDestroyed = true;
      });

      const sizeItems = orderedSizes(supportedSizes).map(sizeKey => {
        const item = new St.Button({
          style_class: 'widget-size-menu-item',
          label: sizeLabel(sizeKey),
          reactive: true,
          can_focus: true,
          track_hover: true,
        });

        item.connectObject('clicked', () => {
          this._setWidgetSize(view.widget, sizeKey);
          sizeMenu.hide();
        }, this);

        sizeMenu.add_child(item);
        return item;
      });

      sizeButton.connectObject('clicked', () => {
        this._hideContextMenus();

        // Hide other widgets' size menus so only one is open at a time.
        for (const otherView of this._views.values()) {
          if (otherView.sizeMenu && otherView.sizeMenu !== sizeMenu) {
            otherView.sizeMenu.hide();
          };
        };

        if (sizeMenu.visible) {
          sizeMenu.hide();
          return;
        };

        const {x, y} = this._sizeButtonPosition(view.widget, sizeButton);

        sizeItems.forEach(item => item.remove_style_pseudo_class('active'));

        const activeIndex = orderedSizes(supportedSizes).indexOf(view.widget.size);

        if (activeIndex >= 0) {
          sizeItems[activeIndex].add_style_pseudo_class('active');
        };

        sizeButton.ensure_style();
        const [, buttonHeight] = sizeButton.get_preferred_height(-1);

        const layerX = this._layerX ?? 0;
        const layerY = this._layerY ?? 0;
        const [menuX, menuY] = this._menuStagePosition(
          sizeMenu,
          layerX + x,
          layerY + y + buttonHeight + 6);

        sizeMenu.set_position(menuX - layerX, menuY - layerY);
        sizeMenu.show();
        raiseActor(sizeMenu);
      }, this);

      sizeButton.connectObject('destroy', () => {
        if (!sizeMenuDestroyed) {
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
    
    // Пропускаємо всі клавіатурні події, щоб не блокувати системні скріншоти (Win+Shift+S)
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
      this._clampWidget(widget);

      // Якщо віджет перетинається з іншими, прилипнути до найближчого вільного
      // краю. Під час перетягування рухається лише перетягнутий віджет.
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

        // Страховка: якщо після snap+clamp віджет усе ще перетинається —
        // відпустити його в найближчу вільну клітинку, щоб не лишався «застряглим».
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

      widget.x = clamp(drag.baseStageX + stageX - drag.stageX, minX, maxX) - (this._layerX ?? 0);
      widget.y = clamp(drag.baseStageY + stageY - drag.stageY, minY, maxY) - (this._layerY ?? 0);

      const monitorForDrag = monitorAtStage(
        effectiveMonitors(),
        drag.baseStageX + stageX - drag.stageX + width / 2,
        drag.baseStageY + stageY - drag.stageY + height / 2);
      log(`[desktop-widgets] drag gap=${gap} min=(${Math.round(minX)},${Math.round(minY)}) max=(${Math.round(maxX)},${Math.round(maxY)}) монітор=${monitorForDrag?.name ?? (monitor?.name ?? '?')} h=${monitorForDrag?.height ?? monitor?.height ?? '?'} wh=${this._layerX ?? 0}`)

      const snapped = this._snapEdges(widget, widget.x, widget.y);

      widget.x = snapped.x;
      widget.y = snapped.y;
      actor.set_position(widget.x, widget.y);
      this._syncEditControls(widget);
    };

    actor.connectObject('button-press-event', (_source, event) => {
      const button = event.get_button() ?? 1;

      if (button === 3 && this._editMode) {
        this._showContextMenu(view, event);
        return Clutter.EVENT_STOP;
      };

      if (button !== 1) {
        return Clutter.EVENT_PROPAGATE;
      };

      if (!this._editMode || view.widget.pinned) {
        return Clutter.EVENT_PROPAGATE;
      };

      this._cancelActiveDrag();
      view.sizeMenu?.hide();
      view.contextMenu?.hide();

      const [stageX, stageY] = event.get_coords();
      widget.oldX = widget.x;
      widget.oldY = widget.y;
      drag = {
        stageX,
        stageY,
        baseStageX: widget.x + (this._layerX ?? 0),
        baseStageY: widget.y + (this._layerY ?? 0),
      };

      raiseActor(actor);
      this._syncEditControls(widget);

      this._dragActor = actor;
      global.stage.connectObject('captured-event', (_stage, capturedEvent) => {
        if (!drag) {
          return Clutter.EVENT_PROPAGATE;
        };

        const eventType = capturedEvent.type();
        const isMotion = eventType === Clutter.EventType.MOTION || eventType === Clutter.EventType.MOTION_NOTIFY;
        const isRelease = eventType === Clutter.EventType.BUTTON_RELEASE;
        const isKeyPress = eventType === Clutter.EventType.KEY_PRESS;

        if (isMotion) {
          moveDrag(capturedEvent);
          return Clutter.EVENT_STOP;
        };

        if (isRelease) {
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

  _cancelActiveDrag() {
    if (!this._dragActor) {
      return;
    };

    global.stage.disconnectObject(this._dragActor);
    this._dragActor = null;
  };

  _hideContextMenus() {
    for (const view of this._views.values()) {
      view.contextMenu?.hide();
    };
  };

  _onStageEventForMenu(event) {
    let openMenuView = null;

    for (const view of this._views.values()) {
      if (view.contextMenu?.mapped) {
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
    const insideMenu = this._actorContains(openMenuView.contextMenu, pickedActor);

    if (onOwnerWidget || insideMenu) {
      return Clutter.EVENT_PROPAGATE;
    };

    const source = event.get_source();
    const onOtherWidget = !!source && (() => {
      for (const view of this._views.values()) {
        if (view.contextMenu?.mapped) {
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

  _contextMenuItem(label, callback) {
    const item = new St.Button({
      style_class: 'widget-size-menu-item widget-context-menu-item',
      label,
      reactive: true,
      can_focus: true,
      track_hover: true,
    });

    item.connectObject('button-press-event', (_source, event) => {
      if ((event.get_button() ?? 1) !== 1) {
        return Clutter.EVENT_PROPAGATE;
      };

      try {
        callback();
      } catch (error) {
        warn('context-menu-action', `"${label}" failed: ${error}`);
      };

      this._hideContextMenus();
      return Clutter.EVENT_STOP;
    }, this);
    return item;
  };

  _contextMenuHeader(label) {
    return new St.Label({
      style_class: 'widget-context-menu-title',
      text: label,
      x_expand: true,
    });
  };

  _contextMenuSeparator() {
    return new St.Widget({
      x_expand: true,
      style: 'height: 1px; min-height: 1px; background-color: rgba(255, 255, 255, 0.15); margin: 4px 6px;',
    });
  };

  _menuStagePosition(menu, stageX, stageY) {
    menu.ensure_style();
    const [, menuWidth] = menu.get_preferred_width(-1);
    const [, menuHeight] = menu.get_preferred_height(-1);
    const monitor = monitorAtStage(effectiveMonitors(), stageX, stageY);
    const margin = 8;

    if (!monitor) {
      return [stageX, stageY];
    };

    const x = Math.max(monitor.x + margin, Math.min(stageX, monitor.x + monitor.width - menuWidth - margin));
    const y = Math.max(monitor.y + margin, Math.min(stageY, monitor.y + monitor.height - menuHeight - margin));

    return [x, y];
  };

  _showContextMenu(view, event) {
    view.sizeMenu?.hide();
    this._hideContextMenus();

    view.contextMenu?.destroy();
    view.contextMenu = null;

    const menu = new St.BoxLayout({
      vertical: true,
      style_class: 'widget-size-menu widget-context-menu',
      reactive: true,
    });
    Main.uiGroup.add_child(menu);

    const widgetModule = WIDGETS.get(view.widget.type);
    const supportedSizes = widgetModule?.supportedSizes ?? [];
    const menuSizes = orderedSizes(supportedSizes);

    if (menuSizes.length > 0) {
      menu.add_child(this._contextMenuHeader(_('Widget size')));

      for (const sizeKey of menuSizes) {
        const item = this._contextMenuItem(sizeLabel(sizeKey), () => {
          this._setWidgetSize(view.widget, sizeKey);
          this._hideContextMenus();
        });

        if (view.widget.size === sizeKey) {
          item.add_style_pseudo_class('active');
        };

        menu.add_child(item);
      };

      menu.add_child(this._contextMenuSeparator());
    };

    if (view.widget.type === 'photos') {
      menu.add_child(this._contextMenuItem(_('Change photo'), () => {
        PhotosWidget.openPhotoChooser(view.widget, path => this._setWidgetPhoto(view.widget, view.body, path));
      }));
    };

    menu.add_child(this._contextMenuItem(view.widget.pinned ? _('Unpin widget') : _('Pin widget'), () => {
      this.togglePin(view.widget.id);
      this._hideContextMenus();
    }));

    const removeItem = this._contextMenuItem(_('Remove widget'), () => {
      this.removeWidget(view.widget.id);
      this._hideContextMenus();
    });
    removeItem.add_style_class_name('widget-context-menu-item-danger');
    menu.add_child(removeItem);

    const [stageX, stageY] = event.get_coords();
    const [x, y] = this._menuStagePosition(menu, stageX, stageY);

    menu.set_position(x, y);
    raiseActor(menu);
    view.contextMenu = menu;
  };

  _fillWidgetBody(widget, body) {
    body.destroy_all_children();
    const widgetModule = WIDGETS.get(widget.type);

    if (!widgetModule?.render) {
      body.add_child(this._label(_('Unknown widget'), 'widget-text'));
      return;
    };

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
        onPhotoChange: path => this._setWidgetPhoto(widget, body, path),
      suppressAppClick: () => {
        this._suppressAppClickUntil = Date.now() + 400;
      },
    });
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

  // Розмір віджета завжди береться з поточного зазору, щоб актор і вміст
  // ніколи не гадали різні числа.
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
      this._syncEditControls(widget);
      return;
    };

    view.actor.ease({
      x: widget.x,
      y: widget.y,
      width,
      height,
      duration: 130,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });

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
        // Спершу — розсування стосу (колонки/ряду) навколо якоря/середнього,
        // і лише якщо не вийшло і перетин лишився — у вільну клітинку.
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
  };

  disable() {
    this._controller?.destroy();
    this._controller = null;
    PhotosWidget.cleanup();
    this._unloadWidgetStylesheets();
    resetLogger();
  };
};
