import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { clamp } from '../../utils.js';
import { warn } from '../../logger.js';

export const type = 'calendar';
export const label = 'Calendar';
export const stylesheet = 'widgets/calendar/stylesheet.css';
export const appIds = ['org.gnome.Calendar.desktop'];
export const defaultSize = 'medium';
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
    this._listeners = new Set();
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
        id: uid,
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
    this._listeners.add(callback);

    return () => {
      this._listeners.delete(callback);
    };
  };

  _notify() {
    for (const listener of this._listeners) {
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

    this._listeners.clear();
    this._events.clear();
  };
};

function uppercaseMonth(date) {
	return date.toLocaleDateString(undefined, {month: 'long'}).toUpperCase();
};

function uppercaseWeekday(date) {
	return date.toLocaleDateString(undefined, {weekday: 'long'}).toUpperCase();
};

function weekdayLabels(format) {
	const referenceDates = [
		new Date(2024, 0, 7), // Sunday
		new Date(2024, 0, 1), // Monday
		new Date(2024, 0, 2), // Tuesday
		new Date(2024, 0, 3), // Wednesday
		new Date(2024, 0, 4), // Thursday
		new Date(2024, 0, 5), // Friday
		new Date(2024, 0, 6), // Saturday
	];

	return referenceDates.map(date => {
		const label = date.toLocaleDateString(undefined, {weekday: format === 'narrow' ? 'narrow' : 'short'});

		if (format === 'narrow') {
			return label.charAt(0).toUpperCase();
		};

		const two = label.slice(0, 2);

		return two.charAt(0).toUpperCase() + two.slice(1);
	});
};

function measureTextWidth(text, fontSizePx) {
	const layout = Pango.Layout.new(PangoCairo.font_map_get_default().create_context());
	const description = Pango.FontDescription.new();
	description.set_absolute_size(fontSizePx * Pango.SCALE);
	description.set_weight(Pango.Weight.SEMIBOLD);
	layout.set_font_description(description);
	layout.set_text(text, -1);
	const [, logical] = layout.get_pixel_extents();
	return logical.width;
};

function fitWeekdayFontSize(weekdays, cellWidth, desiredFont, minFont = 9) {
	let size = desiredFont;

	while (size > minFont) {
		let overflow = false;

		for (const weekday of weekdays) {
			if (measureTextWidth(weekday, size) + 1 > cellWidth) {
				overflow = true;
				break;
			};
		};

		if (!overflow) {
			break;
		};

		size--;
	};

	return size;
};

function noEventsToday() {
	return _('No events today');
}

function isAllDayEvent(event) {
	// The calendar server doesn't report an all-day flag, so infer it from
	// timestamps: the event starts at local midnight and spans a whole number
	// of days (a ±1 h tolerance covers DST transitions).
	const start = new Date(event.start * 1000);
	if (start.getHours() !== 0 || start.getMinutes() !== 0 || start.getSeconds() !== 0)
		return false;
	const duration = event.end - event.start;
	return duration >= 82800 && Math.abs(duration % 86400) <= 3600;
}

function formatEventTime(event, settings) {
	const start = new Date(event.start * 1000);
	const minutes = String(start.getMinutes()).padStart(2, '0');
	const hourFormat = settings?.get_string('digitalclock-hour-format') ?? '24';
	if (hourFormat === '12') {
		const hours = ((start.getHours() + 11) % 12) + 1;
		const showAmPm = settings?.get_boolean('digitalclock-show-ampm') ?? true;
		const amPm = start.getHours() < 12 ? _('AM') : _('PM');
		// Skip minutes when they're :00 so the label stays short and the
		// AM/PM marker fits in narrow rows ("9 PM" instead of "9:00 PM").
		const time = start.getMinutes() === 0 ? String(hours) : `${hours}:${minutes}`;
		return `${time}${showAmPm ? ` ${amPm}` : ''}`;
	}
	return `${String(start.getHours()).padStart(2, '0')}:${minutes}`;
}

// Palette used to color event rows. The calendar server doesn't report a
// per-source color, so each calendar gets a stable color derived from its
// source UID (embedded in the event id as "source_uid\ncomp_uid\ncomp_rid"),
// matching how the Calendar app keeps one color per calendar instead of
// cycling by list position.
const EVENT_COLORS = ['#ff6600', '#3584e4', '#33d17a', '#f6d32d', '#9141ac', '#e01b24'];

function hashString(str) {
	let hash = 5381;
	for (let i = 0; i < str.length; i++)
		hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
	return hash;
}

function sourceColor(eventId) {
	const sourceId = String(eventId ?? '').split('\n')[0];
	return EVENT_COLORS[Math.abs(hashString(sourceId)) % EVENT_COLORS.length];
}

function isTomorrowEvent(event, now) {
	const d = new Date(event.start * 1000);
	const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
	return d.getFullYear() === tomorrow.getFullYear() &&
		d.getMonth() === tomorrow.getMonth() &&
		d.getDate() === tomorrow.getDate();
};

function calendarCell(text, labelStyle, cellStyle, createLabel, cellWidth, cellHeight, interactive = false, boost = 0, labelModifier = null) {
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

	if (labelModifier) {
		labelModifier(labelActor);
	};

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
		weekdayFont,
		gap,
		text,
		secondary,
		accent,
		weekdays,
	} = options;
	const grid = new St.BoxLayout({
		vertical: true,
		style_class: 'widget-calendar-grid',
		x_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${gap}px;`,
	});
	const weekdayRow = new St.BoxLayout({
		style_class: 'widget-calendar-row',
		x_expand: true,
		style: `spacing: ${gap}px;`,
	});

	for (const weekday of weekdays) {
		weekdayRow.add_child(calendarCell(
			weekday,
			`font-size: ${Math.max(8, weekdayFont)}px; font-weight: 600; color: ${secondary};`,
			null,
			createLabel,
			cellWidth,
			cellHeight,
			false,
			0,
			label => {
				label.clutter_text.set_line_wrap(false);
				label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
			}));
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

function fillEventsBox(container, {eventsClient, now, secondary, createLabel, settings}) {
	container.destroy_all_children();

	const eventLabel = (text, style) => createLabel(
		text,
		'widget-calendar-events',
		style ?? `font-size: 15px; font-weight: 600; color: ${secondary};`);

	if (!eventsClient) {
		container.add_child(eventLabel(noEventsToday()));
		return;
	};

	if (!eventsClient.loaded) {
		container.add_child(eventLabel('…'));
		return;
	};

	const todayEvents = eventsClient.eventsForDate(now);
	// Show all today's events, not just 2
	const shown = [...todayEvents];

	// If no events today, show tomorrow's events only (capped)
	if (!shown.length) {
		const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
		const tomorrowEvents = eventsClient.eventsForDate(tomorrow).slice(0, 3);

		for (const event of tomorrowEvents) {
			shown.push(event);
		};
	};

	if (!shown.length) {
		container.add_child(eventLabel(noEventsToday()));
		return;
	};

	for (const event of shown) {
		const text = event.summary && event.summary.trim() ? event.summary.trim() : '…';
		// Stable color per calendar source (like the Calendar app)
		const eventColor = sourceColor(event.id);

		// Event item container with border and dark background
		const eventItem = new St.BoxLayout({
			vertical: false,
			style_class: 'widget-calendar-event-item',
			style: `background-color: rgba(0, 0, 0, 0.25); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 6px; padding: 0; spacing: 0;`,
		});

		// Colored vertical indicator line on the left
		const colorBar = new St.Widget({
			style_class: 'widget-calendar-event-color',
			style: `background-color: ${eventColor}; width: 3px; border-radius: 6px 0 0 6px; min-height: 26px;`,
		});
		eventItem.add_child(colorBar);

		// Event text label
		const eventTextLabel = createLabel(
			text,
			'widget-calendar-events',
			`font-size: 13px; font-weight: 500; color: ${secondary}; padding: 4px 8px;`
		);
		eventTextLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
		eventTextLabel.clutter_text.line_wrap = false;
		eventTextLabel.x_expand = true;
		eventItem.add_child(eventTextLabel);

		// "T" + time / "T" / "All day" / start time, pinned to the right of the
		// summary text (compact tomorrow marker)
		let timeText;
		if (isTomorrowEvent(event, now)) {
			timeText = isAllDayEvent(event)
				? _('T')
				: _('T %s').format(formatEventTime(event, settings));
		} else {
			timeText = isAllDayEvent(event)
				? _('All day')
				: formatEventTime(event, settings);
		};
		const eventTimeLabel = createLabel(
			timeText,
			'widget-calendar-events',
			`font-size: 11px; font-weight: 600; color: ${secondary}; padding: 4px 8px 4px 2px;`
		);
		// createLabel() defaults to x_expand=true; unset it so the label keeps
		// its natural width and, after the expanding summary label, always sits
		// flush against the right edge of the row.
		eventTimeLabel.x_expand = false;
		eventTimeLabel.clutter_text.line_wrap = false;
		eventItem.add_child(eventTimeLabel);

		container.add_child(eventItem);
	};
	// Removed "+N more" label - all events are shown
};

export function render({body, createLabel, events, sizeForWidget, widget, theme, settings}) {
	const [widgetWidth, widgetHeight] = sizeForWidget(widget);
	const text = theme?.text ?? TEXT;
	const secondary = theme?.muted ?? SECONDARY;
	const weekdayFormat = settings?.get_string('calendar-weekday-format') ?? 'short';
	const weekdays = weekdayLabels(weekdayFormat);
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
		const weekdayFont = fitWeekdayFontSize(weekdays, cellWidth, dayFont);
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

		// Scroll container for events list
		const eventsScroll = new St.ScrollView({
			x_expand: true,
			y_expand: false,
			style: 'margin-bottom: 6px;',
			overlay_scrollbars: true,
		});
		eventsScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

		const eventsBox = new St.BoxLayout({
			vertical: true,
			style: 'spacing: 4px;',
		});
		eventsScroll.set_child(eventsBox);
		left.add_child(eventsScroll);

		if (events) {
			const refresh = () => {
				// Fill regardless of mapping: if the body is unmapped when we
				// render (freshly created layer, rebuild while the overview is
				// open), the events box would stay empty forever — the client
				// is already loaded and requestRange() no-ops on the same
				// range, so nothing ever re-triggers this again. Populating an
				// unmapped box is harmless; it shows once mapped.
				fillEventsBox(eventsBox, {eventsClient: events, now, secondary, createLabel, settings});
			};

			const dispose = events.onChange(refresh);
			eventsHandlers.set(body, dispose);
			body.connect('destroy', dispose);
			refresh();

			const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			const startEpoch = Math.floor(dayStart.getTime() / 1000);
			events.requestRange(startEpoch, startEpoch + EVENTS_WINDOW_DAYS * 86400);
		} else {
			fillEventsBox(eventsBox, {eventsClient: null, now, secondary, createLabel, settings});
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
			weekdayFont,
			gap,
			text,
			secondary,
			accent: theme.accent,
			weekdays,
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
	const weekdayFont = fitWeekdayFontSize(weekdays, cellWidth, dayFont);

	body.add_child(monthLabel(now, createLabel, dayFont, theme));

	body.add_child(buildGrid({
			now,
			today,
			weekCount,
			createLabel,
			cellWidth,
			cellHeight,
			dayFont,
			weekdayFont,
			gap,
			text,
			secondary,
			accent: theme.accent,
			weekdays,
		}));

	body.add_child(new St.Widget({y_expand: true}));
};
