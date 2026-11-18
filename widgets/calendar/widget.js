import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Shell from 'gi://Shell';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { clamp } from '../../utils.js';
import { isActorDestroyed } from '../../utils/ported.js';
import { warn } from '../../logger.js';
import { boxLayoutProps } from '../../utils/gnomeCompat.js';
import { createPageIndicator } from '../../lib/pageIndicator.js';
import { createHoldWatch, BUTTON3_MASK } from '../../lib/pager.js';

const EXTENSION_PATH = GLib.path_get_dirname(GLib.path_get_dirname(GLib.path_get_dirname(import.meta.url.replace('file://', ''))));

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

const CALENDAR_SERVER_BUS = 'org.gnome.Shell.CalendarServer';
const CALENDAR_SERVER_PATH = '/org/gnome/Shell/CalendarServer';
const CALENDAR_SERVER_IFACE = 'org.gnome.Shell.CalendarServer';
const EVENTS_REFRESH_SECONDS = 300;
const EVENTS_WINDOW_DAYS = 35;
// The events list looks this far ahead; the schema stores the index
// (mirror of the reference widget's lookahead idea: 0 = only today and
// tomorrow, 1 = 7, 2 = 14, 3 = 30, 4 = 60 days).
const LOOKAHEAD_DAYS = [1, 7, 14, 30, 60];

function lookaheadDays(settings) {
	const index = settings?.get_int('calendar-lookahead') ?? 3;
	return LOOKAHEAD_DAYS[index] ?? 30;
}
const SWIPE_THRESHOLD = 30;
const ANIMATION_DURATION = 250;

const VIEW_CALENDAR = 0;
const VIEW_EVENTS = 1;

// 1x1 view memory. Theme/style changes rebuild the card in place — the
// open view must survive that instead of snapping back to the calendar
// page (in-memory only: a shell restart starts on the calendar view).
let lastCalendarView = VIEW_CALENDAR;

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

  eventsInRange(since, until) {
    // Events starting inside the window — the Calendar app's "upcoming"
    // semantics for the events list lookahead.
    const out = [];

    for (const event of this._events.values()) {
      if (event.start >= since && event.start <= until) {
        out.push(event);
      };
    };

    return out.sort((a, b) => a.start - b.start);
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

function weekdayLabels(format, firstDay = 1) {
	const referenceDates = [
		new Date(2024, 0, 7), // Sunday
		new Date(2024, 0, 1), // Monday
		new Date(2024, 0, 2), // Tuesday
		new Date(2024, 0, 3), // Wednesday
		new Date(2024, 0, 4), // Thursday
		new Date(2024, 0, 5), // Friday
		new Date(2024, 0, 6), // Saturday
	];

	return Array.from({length: 7}, (_unused, column) => {
		const label = referenceDates[(firstDay + column) % 7].toLocaleDateString(undefined, {weekday: format === 'narrow' ? 'narrow' : 'short'});

		if (format === 'narrow') {
			return label.charAt(0).toUpperCase();
		};

		const two = label.slice(0, 2);

		return two.charAt(0).toUpperCase() + two.slice(1);
	});
};

// Which days count as weekend, and which day a week starts on — resolved
// from the user locale (Intl.Locale.getWeekInfo), with the GNOME
// "first day of week" setting as a fallback. Mirror of the reference
// calendar widget.
function localeCalendarInfo() {
	const localeName = Intl.DateTimeFormat().resolvedOptions().locale;
	let weekend = new Set([0, 6]);

	try {
		const locale = new Intl.Locale(localeName);
		const info = typeof locale.getWeekInfo === 'function'
			? locale.getWeekInfo()
			: locale.weekInfo;

		if (info) {
			const localeWeekend = (info.weekend ?? []).map(day => Number(day) % 7);
			if (localeWeekend.length > 0) {
				weekend = new Set(localeWeekend);
			};

			if (Number.isFinite(Number(info.firstDay))) return {firstDay: Number(info.firstDay) % 7, weekend};
		};
	} catch (_error) {
	};

	const shellFirstDay = typeof Shell.util_get_week_start === 'function'
		? Number(Shell.util_get_week_start())
		: NaN;

	return {
		firstDay: Number.isInteger(shellFirstDay) && shellFirstDay >= 0 && shellFirstDay <= 6
			? shellFirstDay
			: 1,
		weekend,
	};
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

function formatEventTime(event, settings, forceShowMinutes = false) {
	const start = new Date(event.start * 1000);
	const minutes = String(start.getMinutes()).padStart(2, '0');
	const hourFormat = settings?.get_string('calendar-hour-format') ?? '24';
	if (hourFormat === '12') {
		const hours = ((start.getHours() + 11) % 12) + 1;
		const amPm = start.getHours() < 12 ? _('AM') : _('PM');
		// For events list, always show minutes and AM/PM
		const time = (forceShowMinutes || start.getMinutes() !== 0)
			? `${hours}:${minutes}`
			: String(hours);
		return `${time} ${amPm}`;
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

// White or near-black day number so the highlighted day stays readable on
// any accent color — including white / very light custom accents where a
// hardcoded white label would vanish into the pill.
function readableOnColor(color) {
	const s = String(color ?? '').trim();

	let r = null;
	let g = null;
	let b = null;

	const hex = s.match(/^#?([0-9a-f]{6})$/i);

	if (hex) {
		const v = parseInt(hex[1], 16);
		r = (v >> 16) & 255;
		g = (v >> 8) & 255;
		b = v & 255;
	} else {
		// The custom accent arrives as "rgba(R, G, B, A)" (Gdk.RGBA.to_string).
		const rgb = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);

		if (rgb) {
			r = Number(rgb[1]);
			g = Number(rgb[2]);
			b = Number(rgb[3]);
		}
	}

	if (r === null) {
		return '#ffffff';
	};

	// Perceived (relative) luminance, 0..1
	const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

	return lum > 0.62 ? '#1c1c1e' : '#ffffff';
}

function isTomorrowEvent(event, now) {
	const d = new Date(event.start * 1000);
	const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
	return d.getFullYear() === tomorrow.getFullYear() &&
		d.getMonth() === tomorrow.getMonth() &&
		d.getDate() === tomorrow.getDate();
};

function isUpcomingEvent(event, now) {
	// Anything from the day after tomorrow onward — gets a date subtitle.
	const d = new Date(event.start * 1000);
	const dayAfter = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
	return d.getTime() >= dayAfter.getTime();
};

// "Wed, Oct 24" / "ср, 24 жовт." — locale-driven day label for the
// upcoming-events lookahead rows.
function formatEventDay(date) {
	return date.toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'});
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
		useAccentColor,
		firstDay = 1,
		weekend = new Set([0, 6]),
		weekendColor = null,
		cellsInteractive = true,
	} = options;
	const grid = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		style_class: 'widget-calendar-grid',
		x_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${gap}px;`,
	}));
	const weekdayRow = new St.BoxLayout(boxLayoutProps({
		style_class: 'widget-calendar-row',
		x_expand: true,
		style: `spacing: ${gap}px;`,
	}));

	for (const [column, weekday] of weekdays.entries()) {
		const nativeDay = (firstDay + column) % 7;

		weekdayRow.add_child(calendarCell(
			weekday,
			`font-size: ${Math.max(8, weekdayFont)}px; font-weight: 700; color: ${weekendColor && weekend.has(nativeDay) ? weekendColor : secondary};`,
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
	const start = (first.getDay() - firstDay + 7) % 7;
	const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
	let day = 1;

	for (let rowIndex = 0; rowIndex < weekCount; rowIndex++) {
		const row = new St.BoxLayout(boxLayoutProps({
			style_class: 'widget-calendar-row',
			x_expand: true,
			style: `spacing: ${gap}px;`,
		}));

		for (let column = 0; column < 7; column++) {
			if ((rowIndex === 0 && column < start) || day > days) {
				row.add_child(calendarCell('', '', null, createLabel, cellWidth, cellHeight, false));
				continue;
			};

			const isToday = day === today;
			const nativeDay = (firstDay + column) % 7;
			const isWeekend = weekendColor && weekend.has(nativeDay);
			const labelStyle = isToday
				? `font-size: ${dayFont}px; font-weight: 800; color: ${readableOnColor(accent)};`
				: `font-size: ${dayFont}px; font-weight: 600; color: ${isWeekend ? weekendColor : text};`;
			const cellStyle = isToday
				? `background-color: ${accent}; border-radius: 999px;`
				: null;

			row.add_child(calendarCell(String(day), labelStyle, cellStyle, createLabel, cellWidth, cellHeight, cellsInteractive, 0, label => {
				// The accent pill is drawn by the cell style at the cell size;
				// no extra width anywhere, so the row never shifts around the
				// highlighted day.
				label.clutter_text.set_line_wrap(false);
			}));
			day++;
		};

		grid.add_child(row);
	};

	return grid;
};

function monthLabel(now, createLabel, dayFont, theme, useAccentColor, scale = 1) {
	const color = useAccentColor ? theme.accent : (theme.text ?? TEXT);
	const label = createLabel(
		uppercaseMonth(now),
		'widget-calendar-month',
		`font-size: ${Math.max(9, Math.round(13 * scale * (dayFont / 12)))}px; font-weight: 800; color: ${color};`);

	label.x_expand = true;
	label.x_align = Clutter.ActorAlign.START;
	label.clutter_text.set_line_wrap(false);
	label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
	return label;
};

export function style(theme) {
	// Inner padding kept tighter than the original framing; the bottom is
	// 4px so the 1x1 page dots can sit close to the frame edge.
	return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text}; border-radius: 16px; padding: 17px 15px 4px 15px;`;
};

function buildCalendarView(options) {
	const {createLabel, now, today, weekCount, cellWidth, cellHeight, dayFont, weekdayFont, gap, text, secondary, theme, useAccentColor, weekdays, firstDay, weekend, weekendColor, cellsInteractive = true} = options;

	const view = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		x_expand: true,
		y_expand: true,
	}));

	view.add_child(monthLabel(now, createLabel, dayFont, theme, useAccentColor));

	view.add_child(buildGrid({
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
		useAccentColor,
		firstDay,
		weekend,
		weekendColor,
		cellsInteractive,
	}));

	view.add_child(new St.Widget({y_expand: true}));
	return view;
};

function buildEventsView(options) {
	const {createLabel, eventsClient, now, text, secondary, settings, width, theme} = options;

	const view = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		x_expand: true,
		y_expand: true,
		style: 'spacing: 8px;',
	}));

	// Header
	const header = createLabel(
		_('Events'),
		'widget-calendar-month',
		`font-size: 13px; font-weight: 800; color: ${text};`
	);
	header.x_expand = true;
	header.x_align = Clutter.ActorAlign.START;
	header.clutter_text.set_line_wrap(false);
	header.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
	view.add_child(header);

	// Events scroll container
	const eventsScroll = new St.ScrollView({
		x_expand: true,
		y_expand: true,
		overlay_scrollbars: true,
	});
	eventsScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

	const eventsBox = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		style: 'spacing: 6px;',
	}));
	eventsScroll.set_child(eventsBox);

	fillEventsBox(eventsBox, {eventsClient, now, secondary, createLabel, settings, text, theme});

	view.add_child(eventsScroll);
	return {view, eventsBox};
};

const eventsHandlers = new WeakMap();

function fillEventsBox(container, {eventsClient, now, secondary, createLabel, settings, text, theme}) {
	container.destroy_all_children();

	const eventLabel = (labelText, style) => createLabel(
		labelText,
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
	const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
	const tomorrowEvents = eventsClient.eventsForDate(tomorrow);

	// Upcoming events from the day after tomorrow through the lookahead
	// window (mirror of the reference widget's "upcoming" group).
	const upcomingSince = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
	const upcomingSinceUnix = Math.floor(upcomingSince.getTime() / 1000);
	const horizon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + lookaheadDays(settings));
	const horizonUnix = Math.floor(horizon.getTime() / 1000) + 86399;
	const upcomingEvents = eventsClient.eventsInRange?.(upcomingSinceUnix, horizonUnix) ?? [];

	// Show all today's events + tomorrow's + upcoming ones inside the window
	const shown = [...todayEvents, ...tomorrowEvents, ...upcomingEvents];

	if (!shown.length) {
		container.add_child(eventLabel(noEventsToday()));
		return 0;
	};

	for (const event of shown) {
		const eventText = event.summary && event.summary.trim() ? event.summary.trim() : '…';
		// Use accent color for the event indicator line
		const eventColor = theme?.accent ?? '#ff6600';

		// Event item container - vertical layout like in CALD design
		const eventItem = new St.BoxLayout(boxLayoutProps({
			vertical: false,
			style_class: 'widget-calendar-event-item',
			style: `spacing: 0;`,
		}));

		// Colored vertical indicator line on the left (4px like in Lua)
		const colorBar = new St.Widget({
			style_class: 'widget-calendar-event-color',
			style: `background-color: ${eventColor}; width: 4px; border-radius: 2px; min-height: 28px;`,
		});
		eventItem.add_child(colorBar);

		// Text container (title + subtitle)
		const textBox = new St.BoxLayout(boxLayoutProps({
			vertical: true,
			x_expand: true,
			style: `spacing: 2px; padding-left: 8px;`,
		}));

		// Event title
		const eventTextLabel = createLabel(
			eventText,
			'widget-calendar-events',
			`font-size: 15px; font-weight: 600; color: ${text};`
		);
		eventTextLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
		eventTextLabel.clutter_text.line_wrap = false;
		eventTextLabel.x_expand = true;
		textBox.add_child(eventTextLabel);

		// Subtitle: time for today, "Tomorrow" for the next day, and a
		// locale day label for upcoming events (or "All day" variants).
		let subtitleText;
		if (isUpcomingEvent(event, now)) {
			const dayStr = formatEventDay(new Date(event.start * 1000));
			subtitleText = isAllDayEvent(event)
				? dayStr
				: `${dayStr}, ${formatEventTime(event, settings, true)}`;
		} else if (isAllDayEvent(event)) {
			subtitleText = isTomorrowEvent(event, now)
				? _('Tomorrow')
				: _('All day');
		} else {
			// Show time for both today and tomorrow events (always with minutes and AM/PM)
			const timeStr = formatEventTime(event, settings, true);
			subtitleText = isTomorrowEvent(event, now)
				? _('Tomorrow, %s').format(timeStr)
				: timeStr;
		};

		const eventSubtitle = createLabel(
			subtitleText,
			'widget-calendar-events',
			`font-size: 12px; font-weight: 500; color: ${secondary};`
		);
		eventSubtitle.clutter_text.line_wrap = false;
		eventSubtitle.x_expand = true;
		textBox.add_child(eventSubtitle);

		eventItem.add_child(textBox);
		container.add_child(eventItem);
	};
	return shown.length;
};

export function render({body, createLabel, events, sizeForWidget, widget, theme, settings}) {
	const [widgetWidth, widgetHeight] = sizeForWidget(widget);
	const text = theme?.text ?? TEXT;
	const secondary = theme?.muted ?? SECONDARY;
	const weekdayFormat = settings?.get_string('calendar-weekday-format') ?? 'short';
	const useAccentColor = settings?.get_boolean('calendar-use-accent-color') ?? false;
	const localeInfo = localeCalendarInfo();
	// First day of the week: 0 = auto (locale / GNOME setting), otherwise a
	// reference-enum day (1 = Sunday, 2 = Monday) mapped to JS getDay().
	const firstDaySetting = settings?.get_int('calendar-first-day') ?? 0;
	const firstDay = firstDaySetting === 1
		? 0
		: firstDaySetting === 2 ? 1 : localeInfo.firstDay;
	const weekend = localeInfo.weekend;
	// Dimmed text for weekend days — slightly lighter on dark themes and
	// darker gray on light ones (reference calendar treatment). The light
	// shade is dark enough to hold its own on the milky light glass.
	const weekendColor = theme?.dark ? 'rgba(255, 255, 255, 0.55)' : 'rgba(36, 31, 49, 0.62)';
	const weekdays = weekdayLabels(weekdayFormat, firstDay);
	const now = new Date();
	const today = now.getDate();
	const first = new Date(now.getFullYear(), now.getMonth(), 1);
	const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
	const start = (first.getDay() - firstDay + 7) % 7;
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
		// Header sizes keep the width-derived day font (they don't shrink).
		const baseDayFont = Math.max(9, Math.round(DAY_BASE_FONT * (cellWidth / 20)));
		// Fit the grid to the card HEIGHT too: a 6-week month (e.g. November
		// 2026 with Monday first) needed month + weekday row + 6 rows ≈ 181px
		// in a ~167px card and the last row ("30") was cut off. Rows, gaps
		// and — when rows get shorter — the day font follow the height.
		const monthFontPx = Math.max(9, Math.round(13 * (cellWidth / 20) * (baseDayFont / 12)));
		const monthH = Math.ceil(monthFontPx * 1.3) + 4;
		const gridH = widgetHeight - 17 - 4 - 2 - monthH;
		const rows = weekCount + 1;
		const gap = weekCount >= 6 ? GAP_BASE - 1 : GAP_BASE;
		const fitH = Math.floor((gridH - gap * (rows - 1)) / rows);
		const cellHeight = Math.max(12, Math.min(Math.round(cellWidth * (compact ? 0.95 : 1)), fitH));
		const dayFont = Math.max(9, Math.min(baseDayFont, Math.round(cellHeight * 0.74)));
		const weekdayFont = fitWeekdayFontSize(weekdays, cellWidth, dayFont);

		const container = new St.BoxLayout(boxLayoutProps({
			x_expand: true,
			y_expand: true,
			style: `spacing: 20px;`,
		}));

		const left = new St.BoxLayout(boxLayoutProps({
			vertical: true,
			x_expand: true,
			style: 'spacing: 4px;',
		}));

		const weekdayNameColor = useAccentColor ? theme.accent : text;
		const dayNameLabel = createLabel(
			uppercaseWeekday(now),
			'widget-calendar-day-name',
			`font-size: 15px; font-weight: 700; color: ${weekdayNameColor};`);
		const dayNumberLabel = createLabel(
			String(today),
			'widget-calendar-day-number',
			`font-size: 58px; font-weight: 700; color: ${text};`);
		const dateSpacer = new St.Widget({y_expand: true});
		// "Events" header, as on the 1x1 events page — shown only when the
		// date block steps aside. Same size/weight as the month header on
		// the right ("NOVEMBER") so both titles sit on one line.
		const eventsHeader = createLabel(
			_('Events'),
			'widget-calendar-month',
			`font-size: ${monthFontPx}px; font-weight: 800; color: ${text}; margin-bottom: 4px;`);
		eventsHeader.x_expand = true;
		eventsHeader.x_align = Clutter.ActorAlign.START;
		eventsHeader.clutter_text.set_line_wrap(false);
		eventsHeader.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
		eventsHeader.visible = false;
		left.add_child(eventsHeader);
		left.add_child(dayNameLabel);
		left.add_child(dayNumberLabel);
		left.add_child(dateSpacer);

		// Scroll container for events list
		const eventsScroll = new St.ScrollView({
			x_expand: true,
			y_expand: false,
			style: 'margin-bottom: 6px;',
			overlay_scrollbars: true,
		});
		eventsScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

		const eventsBox = new St.BoxLayout(boxLayoutProps({
			vertical: true,
			style: 'spacing: 4px;',
		}));
		eventsScroll.set_child(eventsBox);
		left.add_child(eventsScroll);

		// Many events: the weekday + big number step aside so the list gets
		// the whole column (optional, Calendar settings). Capacity = event
		// rows (title + subtitle ≈ 46px) that fit under the date block.
		const hideDateWhenBusy = settings?.get_boolean('calendar-hide-date-many-events') ?? true;
		const EVENT_ROW_H = 46;
		const dateBlockH = Math.round(15 * 1.4) + Math.round(58 * 1.2) + 8;
		const eventCapacity = Math.max(1, Math.floor((widgetHeight - 34 - dateBlockH - 6) / EVENT_ROW_H));
		const applyBusyLayout = (count) => {
			const busy = hideDateWhenBusy && count > eventCapacity;
			eventsHeader.visible = busy;
			dayNameLabel.visible = !busy;
			dayNumberLabel.visible = !busy;
			dateSpacer.visible = !busy;
			eventsScroll.y_expand = busy;
		};

		if (events) {
			const refresh = () => {
				// Fill regardless of mapping: if the body is unmapped when we
				// render (freshly created layer, rebuild while the overview is
				// open), the events box would stay empty forever — the client
				// is already loaded and requestRange() no-ops on the same
				// range, so nothing ever re-triggers this again. Populating an
				// unmapped box is harmless; it shows once mapped.
				applyBusyLayout(fillEventsBox(eventsBox, {eventsClient: events, now, secondary, createLabel, settings, text, theme}) ?? 0);
			};

			const dispose = events.onChange(refresh);
			eventsHandlers.set(body, dispose);
			body.connect('destroy', dispose);
			refresh();

			const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			const startEpoch = Math.floor(dayStart.getTime() / 1000);
			events.requestRange(startEpoch, startEpoch + Math.max(EVENTS_WINDOW_DAYS, lookaheadDays(settings) + 1) * 86400);
		} else {
			fillEventsBox(eventsBox, {eventsClient: null, now, secondary, createLabel, settings, text, theme});
		};

		const right = new St.BoxLayout(boxLayoutProps({
			vertical: true,
			style: 'spacing: 4px;',
		}));

		right.set_width(rightWidth);
		right.add_child(monthLabel(now, createLabel, baseDayFont, theme, useAccentColor, cellWidth / 20));

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
			useAccentColor,
			firstDay,
			weekend,
			weekendColor,
		}));

		container.add_child(left);
		container.add_child(right);
		body.add_child(container);
		return;
	};

	// Small widget (1x1) with swipe navigation
	const scale = clamp(Math.min(widgetWidth, widgetHeight) / 220, 0.8, 2.2);
	const availWidth = widgetWidth - 32;
	const gap = Math.max(2, Math.round(GAP_BASE * scale));
	const cellWidth = Math.max(DAY_BASE_FONT + 6, Math.floor((availWidth - 6 * gap) / 7));
	// Fit the page to the card HEIGHT as well (month label + weekday row +
	// week rows, with room kept for the page dots overlaid at the bottom).
	// A 6-week month was ~7px taller than the card: the month label got
	// cut at the top, and since the events page is shorter, the page stack
	// changed height mid-swipe — the dots jumped down and back up.
	const monthH = Math.ceil(Math.max(9, Math.round(13 * (DAY_BASE_FONT / 12))) * 1.3);
	const DOTS_RESERVE = 10;
	const gridH = widgetHeight - 17 - 4 - 2 - monthH - DOTS_RESERVE;
	const rows = weekCount + 1;
	const fitH = Math.floor((gridH - gap * (rows - 1)) / rows);
	const cellHeight = Math.max(12, Math.min((compact ? COMPACT_CELL_BASE_HEIGHT : CELL_BASE_HEIGHT) * scale, fitH));
	const dayFont = Math.max(9, Math.min(DAY_BASE_FONT, Math.round(cellHeight * 0.78)));
	const weekdayFont = fitWeekdayFontSize(weekdays, cellWidth, dayFont);

	let currentView = lastCalendarView;
	let viewContainer = null;
	let currentEventBox = null;
	const animatingActors = new Set();
	// The 1x1 page-indicator dots are toggleable (prefs → Calendar Widget).
	const showPageDots = settings?.get_boolean('calendar-show-page-dots') ?? true;

	// Pages overlap in a BinLayout (a vertical BoxLayout could not hold the
	// leaving and the entering page at the same time, which is why the old
	// swipe ran as two separate legs). Clipped so the off-page neighbour
	// stays hidden.
	const container = new St.Widget({
		layout_manager: new Clutter.BinLayout(),
		x_expand: true,
		y_expand: true,
		clip_to_allocation: true,
	});

	// Page-indicator dots: a BinLayout stacks the pages and the dots in the
	// same area; the shared component pins the row to the very bottom-center
	// of the shared rect on both pages. The color is the accent when the
	// Calendar Widget switch is on, otherwise the neutral theme text
	// (white on dark, black on light).
	const indicatorColor = settings?.get_boolean('calendar-page-indicator-accent') ?? true
		? (theme?.accent ?? text)
		: text;
	const indicator = createPageIndicator({settings, count: 2, color: indicatorColor});

	const pageStack = new St.Widget({
		layout_manager: new Clutter.BinLayout(),
		x_expand: true,
		y_expand: true,
	});
	container.x_align = Clutter.ActorAlign.FILL;
	container.y_align = Clutter.ActorAlign.FILL;
	pageStack.add_child(container);
	if (showPageDots) {
		pageStack.add_child(indicator.wrap); // dots paint above the pages
	};

	// The dots delegate to the shared page-indicator component; the wrap
	// guard lives inside refresh().
	const refreshDots = () => indicator.refresh(currentView);

	// The events view registers one eventsClient listener per build; each
	// swipe rebuilds the view, so the CURRENT swap's dispose is kept here
	// and released when that view goes away (see rebuild + the swipe path).
	let pendingEventsDispose = null;

	const rebuild = (enterX = 0, animate = true) => {
		if (viewContainer) {
			container.remove_child(viewContainer);
			// Swapped-out views are never destroyed (they are only removed),
			// so an onChange listener registered through viewContainer's
			// 'destroy' hook would survive every swap. Cancel the previous
			// one explicitly so events view swipes cannot accumulate
			// stale refresh closures.
			pendingEventsDispose?.();
			pendingEventsDispose = null;
			// ...and drop the view itself: its cached layout is useless, and
			// keeping it alive holds every label actor it created.
			if (!animatingActors.has(viewContainer)) {
				viewContainer.destroy();
			};
			viewContainer = null;
		}

		if (currentView === VIEW_CALENDAR) {
			viewContainer = buildCalendarView({
				createLabel,
				now,
				today,
				weekCount,
				cellWidth,
				cellHeight,
				dayFont,
				weekdayFont,
				gap,
				text,
				secondary,
				theme,
				useAccentColor,
				weekdays,
				firstDay,
				weekend,
				weekendColor,
				cellsInteractive: false,
			});
			currentEventBox = null;
		} else {
			const result = buildEventsView({
				createLabel,
				eventsClient: events,
				now,
				text,
				secondary,
				settings,
				width: widgetWidth,
				theme,
			});
			viewContainer = result.view;
			currentEventBox = result.eventsBox;

			// Setup events refresh for events view. The dispose handle is
			// tracked per-swap (pendingEventsDispose): viewContainer is only
			// ever REMOVED from the container, never destroyed mid-widget —
			// a 'destroy' hook alone would leak one listener per swipe.
			if (events) {
				const refresh = () => {
					if (currentEventBox && currentView === VIEW_EVENTS) {
						fillEventsBox(currentEventBox, {eventsClient: events, now, secondary, createLabel, settings, text, theme});
					}
				};

				const ownDispose = events.onChange(refresh);
				pendingEventsDispose = ownDispose;
				// Maltese-cross: if the view ever IS destroyed (widget teardown),
				// release ITS listener — not whatever page is current by then
				// (a swiped-away view is destroyed after the new one exists).
				viewContainer.connect('destroy', () => {
					ownDispose();
					if (pendingEventsDispose === ownDispose)
						pendingEventsDispose = null;
				});
			}
		}

		viewContainer.translation_x = enterX;
		viewContainer.opacity = 255;
		viewContainer.x_expand = true;
		viewContainer.y_expand = true;

		if (!animatingActors.has(viewContainer)) {
			container.add_child(viewContainer);
		}

		if (enterX !== 0 && animate) {
			animatingActors.add(viewContainer);
			viewContainer.ease({
				opacity: 255,
				translation_x: 0,
				duration: ANIMATION_DURATION,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
				onComplete: () => {
					animatingActors.delete(viewContainer);
				},
			});
		}

		refreshDots();
	};

	// Apple-style pager (right button): the current page follows the
	// pointer and the other page rides right beside it on ONE strip, so
	// both move in the same frame. Release past the threshold (or a quick
	// flick) settles on the new page, otherwise the strip springs back.
	const PAGE_GAP = 12;
	let drag = null;
	let settling = false;
	container.reactive = true;

	const pageDistance = () => Math.max(1, Math.round(container.width || widgetWidth)) + PAGE_GAP;
	const endGrab = () => {
		if (drag?.grab) {
			try {
				drag.grab.dismiss();
			} catch (_e) {}
			drag.grab = null;
		}
	};
	container.connect('destroy', () => endGrab());

	// Builds the other page beside the current one (no animation): the old
	// view, its events listener and kind are kept for a cancel.
	const beginEntering = (dx) => {
		const d = pageDistance();
		const old = {
			view: viewContainer,
			dispose: pendingEventsDispose,
			kind: currentView,
			eventBox: currentEventBox,
		};
		pendingEventsDispose = null;
		viewContainer = null;
		currentView = currentView === VIEW_CALENDAR ? VIEW_EVENTS : VIEW_CALENDAR;
		rebuild(dx < 0 ? d + dx : -d + dx, false);
		return {old, entering: viewContainer};
	};

	container.connect('button-press-event', (actor, event) => {
		// An open gesture here lost its release: close it, then go on.
		if (drag)
			finishDrag(false);
		if (event.get_button() !== 3 || settling)
			return Clutter.EVENT_PROPAGATE;
		const [x, y0] = event.get_coords();
		drag = {startX: x, startY: y0, claimed: false, lastX: x, lastTime: GLib.get_monotonic_time() / 1000, velocity: 0, dx: 0, pair: null, grab: null, hold: createHoldWatch(BUTTON3_MASK)};
		return Clutter.EVENT_PROPAGATE;
	});

	container.connect('motion-event', (actor, event) => {
		if (!drag || isActorDestroyed(container))
			return Clutter.EVENT_PROPAGATE;
		if (!drag.hold.held(event)) {
			finishDrag(false);
			return Clutter.EVENT_PROPAGATE;
		}
		if (!drag.claimed) {
			const [cx, cy] = event.get_coords();
			const ax = Math.abs(cx - drag.startX);
			const ay = Math.abs(cy - drag.startY);
			if (ax < 8 && ay < 8)
				return Clutter.EVENT_PROPAGATE;
			if (ay >= ax) {
				// Vertical: left to the widget-in-widget stack.
				drag = null;
				return Clutter.EVENT_PROPAGATE;
			}
			drag.claimed = true;
			drag.startX = cx;
			drag.lastX = cx;
			try {
				drag.grab = global.stage.grab(container);
			} catch (_e) {}
		}
		const [x] = event.get_coords();
		const now = GLib.get_monotonic_time() / 1000;
		drag.velocity = (x - drag.lastX) / Math.max(1, now - drag.lastTime);
		drag.lastX = x;
		drag.lastTime = now;
		drag.dx = x - drag.startX;
		// Two pages: nothing lies beyond the neighbour — clamp to one page.
		drag.dx = Math.max(-pageDistance(), Math.min(pageDistance(), drag.dx));

		if (!drag.pair && Math.abs(drag.dx) > 2)
			drag.pair = beginEntering(drag.dx);
		if (drag.pair) {
			const d = pageDistance();
			const {old, entering} = drag.pair;
			if (old.view && !isActorDestroyed(old.view))
				old.view.translation_x = drag.dx;
			if (entering && !isActorDestroyed(entering))
				entering.translation_x = drag.dx + (drag.dx < 0 ? d : -d);
		}
		return Clutter.EVENT_STOP;
	});

	const finishDrag = (allowCommit) => {
		if (!drag)
			return;
		const {dx, velocity, pair} = drag;
		endGrab();
		drag = null;
		if (!pair || isActorDestroyed(container))
			return;

		const {old, entering} = pair;
		const d = pageDistance();
		const flick = Math.abs(velocity) > 0.5 && Math.sign(velocity) === Math.sign(dx);
		const commit = allowCommit && (Math.abs(dx) > SWIPE_THRESHOLD || flick);
		const remaining = commit ? d - Math.abs(dx) : Math.abs(dx);
		const duration = Math.round(Math.min(380, Math.max(200, remaining * 1.1)));
		const mode = Clutter.AnimationMode.EASE_OUT_CUBIC;
		const dropView = view => {
			animatingActors.delete(view);
			if (!view || isActorDestroyed(view))
				return;
			view.get_parent()?.remove_child(view);
			view.destroy();
		};

		settling = true;
		if (commit) {
			// The old page's events listener goes with it.
			old.dispose?.();
			lastCalendarView = currentView;
			refreshDots();
			if (old.view) {
				animatingActors.add(old.view);
				old.view.ease({
					translation_x: dx < 0 ? -d : d,
					duration,
					mode,
					onStopped: () => {
						settling = false;
						dropView(old.view);
					},
				});
			} else {
				settling = false;
			}
			entering?.ease({translation_x: 0, duration, mode});
		} else {
			// Spring back: the old page (and its listener) is current again.
			pendingEventsDispose?.();
			pendingEventsDispose = old.dispose;
			currentView = old.kind;
			viewContainer = old.view;
			currentEventBox = old.eventBox;
			refreshDots();
			old.view?.ease({translation_x: 0, duration, mode});
			if (entering) {
				animatingActors.add(entering);
				entering.ease({
					translation_x: dx < 0 ? d : -d,
					duration,
					mode,
					onStopped: () => {
						settling = false;
						dropView(entering);
					},
				});
			} else {
				settling = false;
			}
		}
	};
	container.connect('button-release-event', (actor, event) => {
		if (!drag || event.get_button() !== 3)
			return Clutter.EVENT_PROPAGATE;
		finishDrag(true);
		return Clutter.EVENT_STOP;
	});
	// A swallowed release (an app or the overview grabbed the pointer
	// mid-gesture), hiding, another press or Escape end the gesture —
	// the pointer grab must never stay stuck on the widget.
	container.connect('notify::mapped', () => {
		if (!container.mapped)
			finishDrag(false);
	});
	container.connect('key-press-event', (actor, event) => {
		if (drag && event.get_key_symbol() === Clutter.KEY_Escape) {
			finishDrag(false);
			return Clutter.EVENT_STOP;
		}
		return Clutter.EVENT_PROPAGATE;
	});

	rebuild();

	// Request events data
	if (events) {
		const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const startEpoch = Math.floor(dayStart.getTime() / 1000);
		events.requestRange(startEpoch, startEpoch + Math.max(EVENTS_WINDOW_DAYS, lookaheadDays(settings) + 1) * 86400);
	}

	body.add_child(pageStack);
};
