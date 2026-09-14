import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as BatteryWidget from './widgets/battery/widget.js';
import * as BinaryClockWidget from './widgets/binaryclock/widget.js';
import * as CalendarWidget from './widgets/calendar/widget.js';
import * as ClockWidget from './widgets/clock/widget.js';
import * as MusicWidget from './widgets/music/widget.js';
import * as PhotosWidget from './widgets/photos/widget.js';
import * as WeatherWidget from './widgets/weather/widget.js';
import { configureLogger, resetLogger, warn } from './logger.js';
import { assetPath } from './paths.js';
import { clamp } from './utils.js';
import { WorkspaceIntegration } from './workspaceIntegration.js';

const EXTENSION_PATH = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const LAYOUT_KEY = 'layout-json';
const LAYOUT_VERSION = 2;
const GRID_SIZE = 20;
const WIDGET_GAP = 14;
const SNAP_DISTANCE = 12;
const CELL_SIZE = 190;
const MEDIUM_WIDGET_WIDTH = CELL_SIZE * 2 + WIDGET_GAP;
const MINI_WIDGET_WIDTH = 260;
const MINI_WIDGET_HEIGHT = 120;
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';
const EDIT_MODE_BINDING_KEY = 'edit-mode-binding';

const WIDGET_MODULES = [
  ClockWidget,
  BinaryClockWidget,
  CalendarWidget,
  WeatherWidget,
  PhotosWidget,
  BatteryWidget,
  MusicWidget,
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
const WIDGET_SIZES = {
  mini: [MINI_WIDGET_WIDTH, 120], // 2x1 mini
  small: [CELL_SIZE, CELL_SIZE], // 1x1
  medium: [MEDIUM_WIDGET_WIDTH, CELL_SIZE], // 2x1
  portrait: [CELL_SIZE, MEDIUM_WIDGET_WIDTH], // 1x2
  large: [MEDIUM_WIDGET_WIDTH, MEDIUM_WIDGET_WIDTH], // 2x2
  tall: [MEDIUM_WIDGET_WIDTH, CELL_SIZE * 4 + WIDGET_GAP * 3], // 2x4
  wide: [CELL_SIZE * 4 + WIDGET_GAP * 3, MEDIUM_WIDGET_WIDTH], // 4x2
  huge: [CELL_SIZE * 4 + WIDGET_GAP * 3, CELL_SIZE * 4 + WIDGET_GAP * 3], // 4x4
};

const SIZE_LABELS = {
  mini: '2×1 mini',
  small: '1×1',
  medium: '2×1',
  portrait: '1×2',
  large: '2×2',
  tall: '2×4',
  wide: '4×2',
  huge: '4×4',
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

function defaultWidgetPositions() {
  const monitors = effectiveMonitors();
  const primary = monitors.find(m => m.isPrimary || m.index === Main.layoutManager.primaryIndex) ?? monitors[0];

  if (!primary) {
    return null;
  }

  const union = unionOfMonitors(monitors);
  const ox = primary.x - union.x;
  const oy = primary.y - union.y;
  const topY = snap(oy + topYFor(primary));
  const row2Y = snap(topY + CELL_SIZE + WIDGET_GAP);
  const row3Y = snap(row2Y + MINI_WIDGET_HEIGHT + WIDGET_GAP);
  const rightX = snap(Math.max(ox + WIDGET_GAP, ox + primary.width - MEDIUM_WIDGET_WIDTH - WIDGET_GAP));
  const middleX = snap(Math.max(ox + WIDGET_GAP, rightX - MEDIUM_WIDGET_WIDTH - WIDGET_GAP));
  const leftSmallX = snap(Math.max(ox + WIDGET_GAP, middleX - CELL_SIZE - WIDGET_GAP));
  const rightMiniX = snap(Math.max(ox + WIDGET_GAP, rightX - MINI_WIDGET_WIDTH - WIDGET_GAP));
  const leftMiniX = snap(Math.max(ox + WIDGET_GAP, rightMiniX - MINI_WIDGET_WIDTH - WIDGET_GAP));

  return {
    weather: {x: middleX, y: topY},
    calendar: {x: rightX, y: topY},
    clock: {x: leftSmallX, y: topY},
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

function cloneDefaultWidgets() {
  const positions = defaultWidgetPositions();

  return DEFAULT_WIDGETS.map(widget => ({
    id: widget.id,
    type: widget.type,
    size: widget.size,
    x: positions?.[widget.type]?.x ?? WIDGET_GAP,
    y: positions?.[widget.type]?.y ?? WIDGET_GAP,
    data: widget.type === 'photos' ? defaultPhotoData() : {},
  }));
};



function accentColor(settings) {
  const accent = settings?.get_string('accent-color') ?? 'blue';

  return ACCENT_COLORS[accent] ?? ACCENT_COLORS.blue;
};

function darkStyleEnabled(settings) {
  return settings?.get_string('color-scheme') === 'prefer-dark';
};

function snap(value) {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
};

function sizeForWidget(widget) {
  const widgetModule = WIDGETS.get(widget.type);
  const size = widgetModule?.defaultSize && WIDGET_SIZES[widgetModule.defaultSize]
    ? widgetModule.defaultSize
    : 'small';

  if (widget.size && WIDGET_SIZES[widget.size]) {
    return WIDGET_SIZES[widget.size];
  };

  return WIDGET_SIZES[size];
};

function rectForWidget(widget) {
  const [width, height] = sizeForWidget(widget);

  return {
    x: widget.x,
    y: widget.y,
    width,
    height,
  };
};

function rectsOverlap(a, b) {
  return a.x < b.x + b.width + WIDGET_GAP &&
    a.x + a.width + WIDGET_GAP > b.x &&
    a.y < b.y + b.height + WIDGET_GAP &&
    a.y + a.height + WIDGET_GAP > b.y;
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

  return isPrimary && Main.panel?.height ? Main.panel.height + WIDGET_GAP : WIDGET_GAP;
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
    this._editMode = false;
    this._dragActor = null;
    this._layerX = null;
    this._layerY = null;
    this._needsLayoutPersist = false;
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
  };

  enable() {
    this._widgets = this._loadWidgets();
    this._saveWidgets();
    this._editMode = this._layoutSettings.get_boolean('edit-mode');
    this._layoutSettings.connectObject(
      'changed::layout-json', () => {
        this._widgets = this._loadWidgets();
        this._rebuildWidgets();
      },
      'changed::edit-mode', () => this.setEditMode(this._layoutSettings.get_boolean('edit-mode')),
      'changed::photo-size', () => this._refreshWidgets(),
      'changed::battery-icon-size', () => this._refreshWidgets(),
      'changed::battery-slot-count', () => this._refreshWidgets(),
      'changed::battery-show-percent', () => this._refreshWidgets(),
      'changed::arrange-widgets', () => this._onArrangeRequested(),
      'changed::edit-mode-binding', () => this._registerEditModeBinding(),
      'changed::style-border-radius', () => this._rebuildWidgets(),
      'changed::style-border-width', () => this._rebuildWidgets(),
      'changed::style-background', () => this._rebuildWidgets(),
      'changed::style-border-color', () => this._rebuildWidgets(),
      'changed::style-shadow', () => this._rebuildWidgets(),
      'changed::style-widget-opacity', () => this._rebuildWidgets(),
      this
    );
    this._createLayer();
    this._rebuildWidgets();
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

    if (this._layoutSettings.get_boolean('arrange-widgets')) {
      this._onArrangeRequested();
    };

    Main.layoutManager.connectObject(
      'monitors-changed', () => this._syncLayerGeometry(),
      this
    );
  };

  destroy() {
    this._eventsClient?.destroy();
    this._eventsClient = null;
    this._workspaceIntegration.destroy();

    for (const timerId of Object.values(this._debounceTimers)) {
      if (timerId) GLib.source_remove(timerId);
    }
    this._debounceTimers = {};

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

  _debounce(key, callback, delay = 230) {
    if (this._debounceTimers[key]) {
      GLib.source_remove(this._debounceTimers[key]);
    }
    this._debounceTimers[key] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      callback();
      this._debounceTimers[key] = 0;
      return GLib.SOURCE_REMOVE;
    });
  };

  _parseWidgets(serialized) {
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch (e) {
      warn('parse-error', `Failed to parse widget layout: ${e.message}`);
      return cloneDefaultWidgets();
    }
    if (!Array.isArray(parsed.widgets)) {
      return cloneDefaultWidgets();
    };

    const widgets = parsed.widgets
      .filter(widget => widget.id && widget.type)
      .filter(widget => WIDGETS.has(widget.type))
      .map(widget => {
        const widgetModule = WIDGETS.get(widget.type);
        const fallback = widgetModule?.defaultSize && WIDGET_SIZES[widgetModule.defaultSize]
          ? widgetModule.defaultSize
          : 'small';
        const saved = String(widget.size ?? '');
        const supported = widgetModule?.supportedSizes ?? [];
        const size = WIDGET_SIZES[saved] && (supported.length === 0 || supported.includes(saved))
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

    if ((parsed.version ?? 1) !== LAYOUT_VERSION) {
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

      this._needsLayoutPersist = true;
    };

    return widgets;
  };

  _loadWidgets() {
    const serialized = this._layoutSettings.get_string(LAYOUT_KEY);
    const widgets = serialized ? this._parseWidgets(serialized) : cloneDefaultWidgets();

    if (this._needsLayoutPersist) {
      this._widgets = widgets;
      this._saveWidgets();
      this._needsLayoutPersist = false;
    };

    return widgets;
  };

  _saveWidgets() {
    this._layoutSettings.set_string(LAYOUT_KEY, JSON.stringify({version: LAYOUT_VERSION, widgets: this._widgets}));
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
      reactive: true,
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
    
    return {
      dark,
      accent: accentColor(this._interfaceSettings),
      background: this._layoutSettings.get_string('style-background') || (dark ? '#242424' : '#ffffff'),
      border: this._layoutSettings.get_string('style-border-color') || (dark ? '#3d3d3d' : '#deddda'),
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

    // Apply custom global styles dynamically
    if (theme.radius !== 16) {
      styleStr += ` border-radius: ${theme.radius}px;`;
    }
    if (theme.borderWidth !== 1) {
      styleStr += ` border-width: ${theme.borderWidth}px;`;
    }
    if (theme.shadow) {
      styleStr += ` box-shadow: ${theme.shadow};`;
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
    if (this._editMode) {
      return;
    };

    for (const view of this._views.values()) {
      if (view.widget.type === 'weather') {
        this._fillWidgetBody(view.widget, view.body);
      };
    };
  };

  _refreshBatteryViews() {
    for (const view of this._views.values()) {
      if (view.widget.type === 'battery') {
        this._fillWidgetBody(view.widget, view.body);
      };
    };
  };

  _watchBatteryChanges() {
    const refresh = () => this._refreshBatteryViews();
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
    this._rebuildWidgets();
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
    const size = WIDGET_SIZES[widgetModule.defaultSize] ? widgetModule.defaultSize : 'small';

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
    this._widgets = this._widgets.filter(widget => widget.id !== id);
    this._saveWidgets();
    this._rebuildWidgets();
  };

  togglePin(id) {
    const widget = this._widgets.find(item => item.id === id);

    if (!widget) {
      return;
    };

    widget.pinned = !widget.pinned;
    this._saveWidgets();
    this._rebuildWidgets();
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

      const [width, height] = sizeForWidget(widget);
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
      const minY = monY + topYFor(monitor);
      const widths = [...new Set(movable.map(widget => sizeForWidget(widget)[0]))].sort((a, b) => a - b);
      const columns = [];
      let colX = monX + WIDGET_GAP;

      for (const width of widths) {
        columns.push({width, x: colX, widgets: []});
        colX += width + WIDGET_GAP;
      };

      for (const widget of movable) {
        const column = columns.find(col => col.width === sizeForWidget(widget)[0]);

        if (column) {
          column.widgets.push(widget);
        };
      };

      for (const column of columns) {
        column.widgets.sort((a, b) => (a.y - b.y) || (a.x - b.x));
        let y = minY;

        for (const widget of column.widgets) {
          const [width, height] = sizeForWidget(widget);

          widget.x = clamp(snap(column.x), monX + WIDGET_GAP, Math.max(monX + WIDGET_GAP, monX + monitor.width - width - WIDGET_GAP));
          widget.y = clamp(snap(y), minY, Math.max(minY, monY + monitor.height - height - WIDGET_GAP));
          y += height + WIDGET_GAP;
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
    const [width, height] = sizeForWidget(widget);
    const layerX = this._layerX ?? 0;
    const layerY = this._layerY ?? 0;
    const monitor = monitorAtStage(
      effectiveMonitors(),
      x + layerX + width / 2,
      y + layerY + height / 2);

    const xCandidates = [(monitor?.x ?? layerX) - layerX + WIDGET_GAP];
    const yCandidates = [(monitor?.y ?? layerY) - layerY + topYFor(monitor)];

    if (monitor) {
      xCandidates.push(monitor.x - layerX + monitor.width - WIDGET_GAP - width);
      yCandidates.push(monitor.y - layerY + monitor.height - WIDGET_GAP - height);
    };

    for (const other of this._widgets) {
      if (other === widget) {
        continue;
      };

      const [ow, oh] = sizeForWidget(other);

      xCandidates.push(other.x, other.x + ow, other.x + ow - width);
      yCandidates.push(other.y, other.y + oh, other.y + oh - height);
    };

    return {
      x: this._nearestCandidate(x, xCandidates),
      y: this._nearestCandidate(y, yCandidates),
    };
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
      this._createWidget(widget);
    };
  };

  _onWidgetSizeChange(widget, sizeKey) {
    if (!widget || !WIDGET_SIZES[sizeKey]) {
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
    if (!widget || !WIDGET_SIZES[sizeKey] || widget.size === sizeKey) {
      return;
    };

    widget.size = sizeKey;
    widget.data = {...(widget.data ?? {}), sizeManual: true};
    this._views.get(widget.id)?.sizeMenu?.hide();
    this._fillWidgetBody(widget, this._views.get(widget.id)?.body);
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
      if (!['battery', 'calendar', 'photos', 'weather'].includes(view.widget.type)) {
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

    const [width, height] = sizeForWidget(widget);
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

    this._fillWidgetBody(widget, body);
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
    const [width] = sizeForWidget(widget);

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

    const overlay = rectForWidget(widget);
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
      `border-radius: ${this._layoutSettings.get_int('style-border-radius')}px;`
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

    if (view.widget.pinned) {
      pinButton.add_style_pseudo_class('active');
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

      const sizeItems = supportedSizes.map(sizeKey => {
        const item = new St.Button({
          style_class: 'widget-size-menu-item',
          label: SIZE_LABELS[sizeKey] ?? sizeKey,
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

        if (sizeMenu.visible) {
          sizeMenu.hide();
          return;
        };

        const {x, y} = this._sizeButtonPosition(view.widget, sizeButton);

        sizeItems.forEach(item => item.remove_style_pseudo_class('active'));

        const activeIndex = supportedSizes.indexOf(view.widget.size);

        if (activeIndex >= 0) {
          sizeItems[activeIndex].add_style_pseudo_class('active');
        };

        sizeButton.ensure_style();
        const [, buttonHeight] = sizeButton.get_preferred_height(-1);

        sizeMenu.set_position(x, y + buttonHeight + 6);
        sizeMenu.show();
        raiseActor(sizeMenu);
      }, this);

      sizeButton.connectObject('destroy', () => sizeMenu.destroy(), this);
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

  _openWidgetApp(type) {
    for (const appId of WIDGET_APP_IDS[type] ?? []) {
      const desktopId = appId.endsWith('.desktop') ? appId : `${appId}.desktop`;
      const app = Shell.AppSystem.get_default().lookup_app(desktopId);

      if (app) {
        app.activate();
        return;
      };

      try {
        const appInfo = Gio.DesktopAppInfo.new(appId) ?? Gio.DesktopAppInfo.new(desktopId);

        if (appInfo) {
          appInfo.launch([], null);
          return;
        };
      } catch (error) {
        warn('desktop-widgets: failed to launch', appId, error);
      };
    };
  };

  _actorIsInteractiveButton(actor) {
    for (let current = actor; current; current = current.get_parent()) {
      if (current instanceof St.Button) {
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
      if (!WIDGET_APP_IDS[view.widget.type]) {
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
      if (!WIDGET_APP_IDS[view.widget.type]) {
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
    if (this._editMode || event.type() !== Clutter.EventType.BUTTON_RELEASE) {
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
      this._openWidgetApp(view.widget.type);
    };

    return Clutter.EVENT_STOP;
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
      this._resolveLayout(widget, true, false);
      this._animateWidget(widget, true);
      this._cancelActiveDrag();
      this._saveWidgets();
    };

    const moveDrag = event => {
      if (!drag) {
        return;
      };

      const [stageX, stageY] = event.get_coords();
      const [width, height] = sizeForWidget(widget);
      const monitor = monitorAtStage(effectiveMonitors(), stageX, stageY);

      if (!monitor) {
        return;
      };

      const minX = monitor.x + WIDGET_GAP;
      const minY = monitor.y + topYFor(monitor);
      const maxX = Math.max(minX, monitor.x + monitor.width - width - WIDGET_GAP);
      const maxY = Math.max(minY, monitor.y + monitor.height - height - WIDGET_GAP);

      widget.x = clamp(snap(drag.baseStageX + stageX - drag.stageX), minX, maxX) - (this._layerX ?? 0);
      widget.y = clamp(snap(drag.baseStageY + stageY - drag.stageY), minY, maxY) - (this._layerY ?? 0);

      const snapped = this._snapEdges(widget, widget.x, widget.y);

      widget.x = snapped.x;
      widget.y = snapped.y;
      actor.set_position(widget.x, widget.y);
      this._syncEditControls(widget);
      this._resolveLayout(widget, false, false);
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

        if (isMotion) {
          moveDrag(capturedEvent);
          return Clutter.EVENT_STOP;
        };

        if (isRelease) {
          finishDrag();
          return Clutter.EVENT_STOP;
        };

        return Clutter.EVENT_PROPAGATE;
      }, actor);

      return Clutter.EVENT_STOP;
    }, this);
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

    if (supportedSizes.length > 0) {
      menu.add_child(this._contextMenuHeader(_('Widget size')));

      for (const sizeKey of supportedSizes) {
        const item = this._contextMenuItem(SIZE_LABELS[sizeKey] ?? sizeKey, () => {
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
    menu.set_position(stageX, stageY);
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
        sizeForWidget,
        settings: this._layoutSettings,
        events: this._eventsClient,
        onPhotoChange: path => this._setWidgetPhoto(widget, body, path),
      suppressAppClick: () => {
        this._suppressAppClickUntil = Date.now() + 400;
      },
    });
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
    this._fillWidgetBody(widget, body);
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

  _clampWidget(widget) {
    const layerX = this._layerX ?? 0;
    const layerY = this._layerY ?? 0;
    const [width, height] = sizeForWidget(widget);
    const monitor = monitorAtStage(
      effectiveMonitors(),
      widget.x + layerX + width / 2,
      widget.y + layerY + height / 2);

    if (!monitor) {
      return false;
    };

    const monX = monitor.x - layerX;
    const monY = monitor.y - layerY;
    const minX = monX + WIDGET_GAP;
    const minY = monY + topYFor(monitor);
    const maxX = Math.max(minX, monX + monitor.width - width - WIDGET_GAP);
    const maxY = Math.max(minY, monY + monitor.height - height - WIDGET_GAP);
    const x = clamp(snap(widget.x), minX, maxX);
    const y = clamp(snap(widget.y), minY, maxY);

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

    const [width, height] = sizeForWidget(widget);

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
    const [width, height] = sizeForWidget(widget);
    const rect = {x, y, width, height};

    return !blockingWidgets.some(other => other !== widget && rectsOverlap(rect, rectForWidget(other)));
  };

  _findOpenPosition(widget, blockingWidgets = []) {
    const layerX = this._layerX ?? 0;
    const layerY = this._layerY ?? 0;
    const [width, height] = sizeForWidget(widget);
    const monitor = monitorAtStage(
      effectiveMonitors(),
      widget.x + layerX + width / 2,
      widget.y + layerY + height / 2);

    if (!monitor) {
      return {x: widget.x, y: widget.y};
    };

    const monX = monitor.x - layerX;
    const monY = monitor.y - layerY;
    const minX = monX + WIDGET_GAP;
    const minY = monY + topYFor(monitor);
    const maxX = Math.max(minX, monX + monitor.width - width - WIDGET_GAP);
    const maxY = Math.max(minY, monY + monitor.height - height - WIDGET_GAP);
    const originX = clamp(snap(widget.x), minX, maxX);
    const originY = clamp(snap(widget.y), minY, maxY);
    const candidates = [];

    for (let y = minY; y <= maxY; y += GRID_SIZE) {
      for (let x = minX; x <= maxX; x += GRID_SIZE) {
        const snappedX = clamp(snap(x), minX, maxX);
        const snappedY = clamp(snap(y), minY, maxY);
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
    let changed = false;

    for (const widget of orderedWidgets) {
      if (widget.pinned) {
        settled.push(widget);
        continue;
      };

      const oldX = widget.x;
      const oldY = widget.y;

      this._clampWidget(widget);

      if (settled.some(other => rectsOverlap(rectForWidget(widget), rectForWidget(other)))) {
        const position = this._findOpenPosition(widget, settled);
        widget.x = position.x;
        widget.y = position.y;
        this._clampWidget(widget);
      };

      settled.push(widget);

      if (widget.x !== oldX || widget.y !== oldY) {
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
