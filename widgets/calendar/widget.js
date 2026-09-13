import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { clamp } from '../../utils.js';
import { warn } from '../../logger.js';

export const type = 'calendar';
export const label = 'Calendar';
export const stylesheet = 'widgets/calendar/stylesheet.css';
export const appIds = ['org.gnome.Calendar.desktop'];
export const defaultSize = 'small';
export const supportedSizes = ['small', 'medium'];

const TEXT = '#f5f5f7';
const SECONDARY = '#86868b';
const CELL_BASE_HEIGHT = 24;
const COMPACT_CELL_BASE_HEIGHT = 23;
const CELL_BASE_WIDTH = 24;
const DAY_BASE_FONT = 14;
const GAP_BASE = 4;
const WIDE_THRESHOLD = 340;
const TODAY_BOOST = 4;

const CALENDAR_SERVER_BUS = 'org.gnome.Shell.CalendarServer';
const CALENDAR_SERVER_PATH = '/org/gnome/Shell/CalendarServer';
const CALENDAR_SERVER_IFACE = 'org.gnome.Shell.CalendarServer';
const EVENTS_REFRESH_SECONDS = 300;
const EVENTS_WINDOW_DAYS = 35;

export class CalendarEventsClient {
  constructor() {
    this._events = new Map();
    this._listeners = [];
    this._loaded = false;
    this._range = null;
    this._subIds = [];
    this._timeoutId = 0;
    this._loadedFallbackId = 0;
  };

  get loaded() {
    return this._loaded;
  };

  _connect() {
    if (this._subIds.length) {
      return;
    };

    const bus = Gio.DBus.session;

    this._subIds.push(bus.signal_subscribe(
      CALENDAR_SERVER_BUS,
      CALENDAR_SERVER_IFACE,
      'EventsAddedOrUpdated',
      CALENDAR_SERVER_PATH,
      null,
      Gio.DBusSignalFlags.NONE,
      (_bus, _sender, _path, _iface, _signal, params) => this._onEvents(params)));
    this._subIds.push(bus.signal_subscribe(
      CALENDAR_SERVER_BUS,
      CALENDAR_SERVER_IFACE,
      'EventsRemoved',
      CALENDAR_SERVER_PATH,
      null,
      Gio.DBusSignalFlags.NONE,
      (_bus, _sender, _path, _iface, _signal, params) => this._onRemoved(params)));
  };

  _onEvents(params) {
    const events = params?.get_child_value(0)?.recursiveUnpack() ?? [];

    for (const ev of events) {
      const uid = ev?.[0];

      if (!uid) {
        continue;
      };

      this._events.set(uid, {
        start: Number(ev?.[2]) || 0,
        end: Number(ev?.[3]) || 0,
        summary: String(ev?.[1] ?? ''),
      });
    };

    this._loaded = true;
    this._notify();
  };

  _onRemoved(params) {
    const ids = params?.get_child_value(0)?.recursiveUnpack() ?? [];

    for (const id of ids) {
      this._events.delete(id);
    };

    this._notify();
  };

  _clearLoadedFallback() {
    if (this._loadedFallbackId) {
      GLib.source_remove(this._loadedFallbackId);
      this._loadedFallbackId = 0;
    };
  };

  _armLoadedFallback() {
    this._clearLoadedFallback();
    this._loadedFallbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
      this._loaded = true;
      this._loadedFallbackId = 0;
      this._notify();
      return GLib.SOURCE_REMOVE;
    });
  };

  requestRange(since, until, force = false) {
    this._connect();
    this.startRefresh();

    if (this._range && this._range.since === since && this._range.until === until && !force) {
      return;
    };

    this._range = {since, until};
    this._events.clear();
    this._loaded = false;
    this._armLoadedFallback();

    try {
      const params = GLib.Variant.new('(xxb)', [since, until, !!force]);

      Gio.DBus.session.call(
        CALENDAR_SERVER_BUS,
        CALENDAR_SERVER_PATH,
        CALENDAR_SERVER_IFACE,
        'SetTimeRange',
        params,
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (connection, result) => {
          try {
            connection.call_finish(result);
          } catch (e) {
            this._loaded = true;
            this._notify();
          };
        });
    } catch (e) {
      this._loaded = true;
      this._notify();
    };
  };

  startRefresh() {
    if (this._timeoutId) {
      return;
    };

    this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, EVENTS_REFRESH_SECONDS, () => {
      if (this._range) {
        this.requestRange(this._range.since, this._range.until, true);
      };

      return GLib.SOURCE_CONTINUE;
    });
  };

  eventsForDate(date) {
    const out = [];

    for (const event of this._events.values()) {
      const d = new Date(event.start * 1000);

      if (d.getFullYear() === date.getFullYear() &&
          d.getMonth() === date.getMonth() &&
          d.getDate() === date.getDate()) {
        out.push(event);
      };
    };

    return out.sort((a, b) => a.start - b.start);
  };

  nextEventsFrom(epoch, limit = 5) {
    const out = [];

    for (const event of this._events.values()) {
      if (event.start >= epoch) {
        out.push(event);
      };
    };

    return out.sort((a, b) => a.start - b.start).slice(0, limit);
  };

  onChange(callback) {
    this._listeners.push(callback);

    return () => {
      this._listeners = this._listeners.filter(listener => listener !== callback);
    };
  };

  _notify() {
    for (const listener of [...this._listeners]) {
      try {
        listener();
      } catch (e) {
        warn('calendar-events-listener', `listener error: ${e}`);
      };
    };
  };

  destroy() {
    this._clearLoadedFallback();

    for (const id of this._subIds) {
      Gio.DBus.session.signal_unsubscribe(id);
    };

    this._subIds = [];

    if (this._timeoutId) {
      GLib.source_remove(this._timeoutId);
      this._timeoutId = 0;
    };

    this._listeners = [];
    this._events.clear();
  };
};

function uppercaseMonth(date) {
	return date.toLocaleDateString(undefined, {month: 'long'}).toUpperCase();
};

function uppercaseWeekday(date) {
	return date.toLocaleDateString(undefined, {weekday: 'long'}).toUpperCase();
};

function calendarCell(text, labelStyle, cellStyle, createLabel, cellWidth, cellHeight, interactive = false, boost = 0) {
	const binParams = {
		style_class: 'widget-calendar-cell',
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		x_expand: true,
		y_expand: false,
	};

	if (cellStyle) {
		binParams.style = cellStyle;
	};

	if (interactive) {
		binParams.reactive = true;
		binParams.track_hover = true;
	};

	const bin = new St.Bin(binParams);
	const labelActor = createLabel(text, 'widget-calendar-day', labelStyle);

	labelActor.x_expand = true;
	labelActor.x_align = Clutter.ActorAlign.CENTER;
	labelActor.y_align = Clutter.ActorAlign.CENTER;
	bin.set_size(cellWidth + boost, cellHeight + boost);
	bin.set_child(labelActor);
	return bin;
};

function buildGrid(options) {
	const {
		now,
		today,
		weekCount,
		createLabel,
		cellWidth,
		cellHeight,
		dayFont,
		gap,
		text,
		secondary,
		accent,
	} = options;
	const grid = new St.BoxLayout({
		vertical: true,
		style_class: 'widget-calendar-grid',
		x_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${gap}px;`,
	});
	const weekdays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
	const weekdayRow = new St.BoxLayout({
		style_class: 'widget-calendar-row',
		x_expand: true,
		style: `spacing: ${gap}px;`,
	});

	for (const weekday of weekdays) {
		weekdayRow.add_child(calendarCell(
			weekday,
			`font-size: ${dayFont}px; font-weight: 600; color: ${secondary};`,
			null,
			createLabel,
			cellWidth,
			cellHeight,
			false));
	};

	grid.add_child(weekdayRow);

	const first = new Date(now.getFullYear(), now.getMonth(), 1);
	const start = first.getDay();
	const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
	let day = 1;

	for (let rowIndex = 0; rowIndex < weekCount; rowIndex++) {
		const row = new St.BoxLayout({
			style_class: 'widget-calendar-row',
			x_expand: true,
			style: `spacing: ${gap}px;`,
		});

		for (let column = 0; column < 7; column++) {
			if ((rowIndex === 0 && column < start) || day > days) {
				row.add_child(calendarCell('', '', null, createLabel, cellWidth, cellHeight, false));
				continue;
			};

			const isToday = day === today;
			const labelStyle = isToday
				? `font-size: ${dayFont}px; font-weight: 500; color: #ffffff;`
				: `font-size: ${dayFont}px; font-weight: 500; color: ${text};`;
			const cellStyle = isToday
				? `background-color: ${accent}; border-radius: 999px;`
				: null;

			row.add_child(calendarCell(String(day), labelStyle, cellStyle, createLabel, cellWidth, cellHeight, true, isToday ? TODAY_BOOST : 0));
			day++;
		};

		grid.add_child(row);
	};

	return grid;
};

function monthLabel(now, createLabel, dayFont, theme, scale = 1) {
	const label = createLabel(
		uppercaseMonth(now),
		'widget-calendar-month',
		`font-size: ${Math.max(9, Math.round(13 * scale * (dayFont / 12)))}px; font-weight: 800; color: ${theme.accent};`);

	label.x_expand = true;
	label.x_align = Clutter.ActorAlign.START;
	label.clutter_text.set_line_wrap(false);
	label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
	return label;
};

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text}; border-radius: 16px; padding: 18px 16px;`;
};

const eventsHandlers = new WeakMap();

function fillEventsBox(container, {eventsClient, now, secondary, createLabel}) {
	container.destroy_all_children();

	const eventLabel = (text, style) => createLabel(
		text,
		'widget-calendar-events',
		style ?? `font-size: 15px; font-weight: 600; color: ${secondary};`);

	if (!eventsClient) {
		container.add_child(eventLabel(_('No events today')));
		return;
	};

	if (!eventsClient.loaded) {
		container.add_child(eventLabel('…'));
		return;
	};

	const todayEvents = eventsClient.eventsForDate(now);
	const shown = [...todayEvents.slice(0, 2)];

	if (todayEvents.length < 2) {
		const upcoming = eventsClient
			.nextEventsFrom(Math.floor(now.getTime() / 1000), 5)
			.filter(event => !shown.includes(event))
			.slice(0, 2 - shown.length);

		for (const event of upcoming) {
			shown.push(event);
		};
	};

	if (!shown.length) {
		container.add_child(eventLabel(_('No events today')));
		return;
	};

	for (const event of shown) {
		const text = event.summary && event.summary.trim() ? event.summary.trim() : '…';
		container.add_child(eventLabel(text));
	};

	if (todayEvents.length > 2) {
		container.add_child(eventLabel(
			`+${todayEvents.length - 2} more`,
			`font-size: 13px; font-weight: 500; color: ${secondary};`));
	};
};

export function render({body, createLabel, events, sizeForWidget, widget, theme}) {
	const [widgetWidth, widgetHeight] = sizeForWidget ? sizeForWidget(widget) : [220, 220];
	const text = theme?.text ?? TEXT;
	const secondary = theme?.muted ?? SECONDARY;
	const now = new Date();
	const today = now.getDate();
	const first = new Date(now.getFullYear(), now.getMonth(), 1);
	const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
	const start = first.getDay();
	const weekCount = Math.ceil((start + days) / 7);
	const compact = weekCount === 6;
	const wide = widgetWidth >= WIDE_THRESHOLD;

	const removeHandler = eventsHandlers.get(body);

	if (removeHandler) {
		removeHandler();
		eventsHandlers.delete(body);
	};

	if (wide) {
		const rightWidth = Math.round(clamp(widgetWidth * 0.45, 168, 230));
		const cellWidth = Math.round(20 * (rightWidth / 175));
		const cellHeight = Math.round(cellWidth * (compact ? 0.95 : 1));
		const dayFont = Math.max(9, Math.round(DAY_BASE_FONT * (cellWidth / 20)));
		const gap = GAP_BASE;

		const container = new St.BoxLayout({
			x_expand: true,
			y_expand: true,
			style: `spacing: 20px;`,
		});

		const left = new St.BoxLayout({
			vertical: true,
			x_expand: true,
			style: 'spacing: 4px;',
		});

		left.add_child(createLabel(
			uppercaseWeekday(now),
			'widget-calendar-day-name',
			`font-size: 15px; font-weight: 700; color: ${theme.accent};`));
		left.add_child(createLabel(
			String(today),
			'widget-calendar-day-number',
			`font-size: 58px; font-weight: 700; color: ${text};`));
		left.add_child(new St.Widget({y_expand: true}));

		const eventsBox = new St.BoxLayout({
			vertical: true,
			style: 'spacing: 2px; margin-bottom: 6px;',
		});
		left.add_child(eventsBox);

		if (events) {
			const refresh = () => {
				if (!body.is_mapped()) {
					return;
				};

				fillEventsBox(eventsBox, {eventsClient: events, now, secondary, createLabel});
			};

			eventsHandlers.set(body, events.onChange(refresh));
			refresh();

			const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			const startEpoch = Math.floor(dayStart.getTime() / 1000);
			events.requestRange(startEpoch, startEpoch + EVENTS_WINDOW_DAYS * 86400);
		} else {
			fillEventsBox(eventsBox, {eventsClient: null, now, secondary, createLabel});
		};

		const right = new St.BoxLayout({
			vertical: true,
			style: 'spacing: 4px;',
		});

		right.set_width(rightWidth);
		right.add_child(monthLabel(now, createLabel, dayFont, theme, cellWidth / 20));

		right.add_child(buildGrid({
			now,
			today,
			weekCount,
			createLabel,
			cellWidth,
			cellHeight,
			dayFont,
			gap,
			text,
			secondary,
			accent: theme.accent,
		}));

		container.add_child(left);
		container.add_child(right);
		body.add_child(container);
		return;
	};

	const scale = clamp(Math.min(widgetWidth, widgetHeight) / 220, 0.8, 2.2);
	const dayFont = DAY_BASE_FONT;
	const availWidth = widgetWidth - 32;
	const gap = Math.max(2, Math.round(GAP_BASE * scale));
	const cellWidth = Math.max(dayFont + 6, Math.floor((availWidth - 6 * gap) / 7));
	const cellHeight = (compact ? COMPACT_CELL_BASE_HEIGHT : CELL_BASE_HEIGHT) * scale;

	body.add_child(monthLabel(now, createLabel, dayFont, theme));

	body.add_child(buildGrid({
			now,
			today,
			weekCount,
			createLabel,
			cellWidth,
			cellHeight,
			dayFont,
			gap,
			text,
			secondary,
			accent: theme.accent,
		}));

	body.add_child(new St.Widget({y_expand: true}));
};