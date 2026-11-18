import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather';
import St from 'gi://St';

import { warn } from '../../logger.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { boxLayoutProps } from '../../utils/gnomeCompat.js';
import { createPageIndicator, indicatorBandHeight } from '../../lib/pageIndicator.js';
import { createHoldWatch, BUTTON3_MASK } from '../../lib/pager.js';

const EXTENSION_PATH = GLib.path_get_dirname(GLib.path_get_dirname(GLib.path_get_dirname(import.meta.url.replace('file://', ''))));

export const type = 'weather';
export const label = 'Weather';
export const stylesheet = 'widgets/weather/stylesheet.css';
export const appIds = ['org.gnome.Weather.desktop'];
export const settingsSchema = 'org.gnome.Weather';
export const cacheTtlMs = 10 * 60 * 1000;
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium', 'large', 'wide'];

const HOUR_MS = 3600 * 1000;
const HOURS_AHEAD = 24;
// 1x1 pager: a drag past 30px (or a flick) commits the page change.
const WEATHER_SWIPE_THRESHOLD = 30;
// The swipe page survives the card's periodic re-renders (module-wide,
// the same way the calendar keeps its view across event refreshes).
let weatherCompactPage = 0;

export function style(theme) {
	// Bottom padding matches the calendar widget (4px): the 1x1 page
	// indicator dots must sit at the exact same offset from the frame edge,
	// inside the card, + the dots row's own 2px bottom margin.
	return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text}; border-radius: 16px; padding: 18px 18px 4px 18px;`;
};

export function locationNameFromSettings(settings) {
	const strings = locationStringsFromSettings(settings);

	return strings[0] || null;
};

function locationStringsFromSettings(settings) {
	if (!settings) {
		return [];
	};

	const locations = settings.get_value('locations');

	if (locations.n_children() === 0) {
		return [];
	};

	const serialized = locations.get_child_value(0).print(true);

	return [...serialized.matchAll(/'([^']*)'/g)].map(match => match[1]);
};

export function locationFromSettings(settings) {
	if (!settings) {
		return null;
	};

	try {
		const locations = settings.get_value('locations');

		return locations.n_children() > 0
			? GWeather.Location.get_world()?.deserialize(locations.get_child_value(0).deep_unpack()) ?? null
			: null;
	} catch (error) {
		warn('weather-location-deserialize', `Could not deserialize Weather app location: ${error.message}`);
		return null;
	};
};

export function infoForLocation(location) {
	const info = GWeather.Info.new(location);

	info.set_application_id('org.gnome.shell.extensions.desktop-widgets-r3nhick');
	info.set_contact_info('https://github.com/r3nhick/desktop-widgets');
	info.set_enabled_providers(
		GWeather.Provider.METAR |
		GWeather.Provider.MET_NO |
		GWeather.Provider.OWM);
	return info;
};

export function weatherFromInfo(info, location, displayName = null) {
	const currentInfo = currentConditionsInfo(info);
	const locationName = currentInfo.get_location_name();
	const apparent = formatTemperature(currentInfo.get_apparent());
	const {hourly, daily} = forecastSeries(info, Date.now());

	return {
		temp: formatTemperature(currentInfo.get_temp()),
		summary: summaryOrIconLabel(
			cleanSummary(currentInfo.get_weather_summary(), locationName),
			currentInfo.get_icon_name()),
		location: location.get_city_name() || displayName || locationName,
		icon: currentInfo.get_icon_name() || 'weather-clear',
		feelsLike: apparent && apparent !== '--' ? `${_('It feels like')} ${apparent}` : null,
		hourly,
		daily,
	};
};

function currentConditionsInfo(info) {
	return formatTemperature(info.get_temp()) !== '--' ? info : currentForecastInfo(info);
};

function forecastUpdateTime(info) {
	const [ok, updateTime] = info.get_value_update();

	return ok ? updateTime : null;
};

function currentForecastInfo(info) {
	const forecasts = info.get_forecast_list() ?? [];
	const now = Math.floor(Date.now() / 1000);
	let bestPast = null;
	let bestFuture = null;

	for (const forecast of forecasts) {
		const updateTime = forecastUpdateTime(forecast);
		const temp = formatTemperature(forecast.get_temp());

		if (updateTime === null || temp === '--') {
			continue;
		};

		if (updateTime <= now && (!bestPast || updateTime > bestPast.updateTime)) {
			bestPast = {forecast, updateTime};
		} else if (updateTime > now && (!bestFuture || updateTime < bestFuture.updateTime)) {
			bestFuture = {forecast, updateTime};
		};
	};

	return bestPast?.forecast ?? bestFuture?.forecast ?? info;
};

function forecastSeries(info, nowMs) {
	const list = info.get_forecast_list() ?? [];
	const hourly = [];
	const dayMap = new Map();
	const todayStart = todayStartMs(nowMs);
	const horizon = nowMs + HOURS_AHEAD * HOUR_MS;

	for (const forecast of list) {
		const updateTime = forecastUpdateTime(forecast);

		if (updateTime === null) {
			continue;
		};

		const timeMs = updateTime * 1000;
		const date = new Date(timeMs);
		const hour = date.getHours();
		const minute = date.getMinutes();
		const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
		const maxN = tempNumber(formatTemperature(forecast.get_temp_max?.()));
		const minN = tempNumber(formatTemperature(forecast.get_temp_min?.()));
		const tempN = tempNumber(formatTemperature(forecast.get_temp?.()));
		const dayKey = dayStart;

		if (!dayMap.has(dayKey)) {
			const isToday = dayStart === todayStart;

			dayMap.set(dayKey, {
				time: dayStart,
				day: isToday ? _('Today') : date.toLocaleDateString(undefined, {weekday: 'short'}),
				icon: forecastSymbolicIcon(forecast),
				maxN: null,
				minN: null,
			});
		};

		const entry = dayMap.get(dayKey);
		const dayHigh = maxN !== null ? maxN : tempN;
		const dayLow = minN !== null ? minN : tempN;

		if (dayHigh !== null && (entry.maxN === null || dayHigh > entry.maxN)) {
			entry.maxN = dayHigh;
		};

		if (dayLow !== null && (entry.minN === null || dayLow < entry.minN)) {
			entry.minN = dayLow;
		};

		if (hour === 0 && minute === 0) {
			entry.icon = forecastSymbolicIcon(forecast);
		};

		if (timeMs >= nowMs && timeMs <= horizon && tempN !== null) {
			hourly.push({
				time: timeMs,
				label: date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'}),
				icon: forecastSymbolicIcon(forecast),
				temp: formatTemperature(tempN),
			});
		};
	};

	const daily = [...dayMap.values()]
		.filter(day => day.time >= todayStart && day.maxN !== null)
		.sort((a, b) => a.time - b.time)
		.map(day => ({
			time: day.time,
			day: day.day,
			icon: day.icon,
			high: formatTemperature(day.maxN),
			low: formatTemperature(day.minN),
		}));

	hourly.sort((a, b) => a.time - b.time);

	return {
		hourly: sampleHourly(hourly),
		daily,
	};
};

function todayStartMs(nowMs) {
	const start = new Date(nowMs);

	start.setHours(0, 0, 0, 0);
	return start.getTime();
};

function forecastSymbolicIcon(forecast) {
	return String(forecast.get_symbolic_icon_name?.() ?? forecast.get_icon_name?.() ?? 'weather-clear');
};

function sampleHourly(hourly) {
	const sampled = [];
	let lastTime = -Infinity;

	for (const item of hourly) {
		if (item.temp === '--') {
			continue;
		};

		if (item.time - lastTime < 3 * HOUR_MS) {
			continue;
		};

		sampled.push(item);
		lastTime = item.time;

		if (sampled.length >= 6) {
			break;
		};
	};

	return sampled;
};

function formatTemperature(temperature) {
	const text = String(temperature ?? '--').trim();
	const match = text.match(/-?\d+(?:[.,]\d+)?/);

	if (!match) {
		return '--';
	};

	const value = Number(match[0].replace(',', '.'));

	return Number.isFinite(value) ? `${Math.round(value)}°` : '--';
};

// Natural width of a piece of text at the given font; used to size the
// hourly cells so the full time label ("9:00 PM") fits without clipping.
function measureLabelWidth(text, fontPx, weight) {
	const label = new St.Label({
		text: String(text ?? ''),
		style: `font-size: ${fontPx}px; font-weight: ${weight};`,
	});
	const [, natural] = label.get_preferred_width(-1);
	label.destroy();
	return natural;
};

// Condition names by icon, for when GWeather has no sky report: METAR
// stations often omit it (at night especially) and the summary reads
// "Unknown" while the icon (moon, clouds…) is perfectly known.
const ICON_SUMMARIES = [
	[/storm/, () => _('Thunderstorm')],
	[/snow/, () => _('Snow')],
	[/showers-scattered/, () => _('Light rain')],
	[/showers|rain/, () => _('Rain')],
	[/fog|mist/, () => _('Fog')],
	[/overcast/, () => _('Cloudy')],
	[/few-clouds/, () => _('Partly cloudy')],
	[/clear-night/, () => _('Clear')],
	[/clear/, () => _('Sunny')],
	[/wind/, () => _('Windy')],
];

function summaryOrIconLabel(summary, iconName) {
	const text = String(summary ?? '').trim();
	let unknownTr = 'Unknown';
	try {
		unknownTr = GLib.dgettext('libgweather-4.0', 'Unknown');
	} catch (_e) {}
	const unknown = !text || text === '-' || /^unknown$/i.test(text) || text === unknownTr;
	if (!unknown)
		return summary;
	const icon = String(iconName ?? '');
	for (const [pattern, label] of ICON_SUMMARIES) {
		if (pattern.test(icon))
			return label();
	}
	return summary;
};

function cleanSummary(summary, locationName) {
	if (!summary) {
		return _('Weather unavailable');
	};

	if (locationName && summary.startsWith(`${locationName}: `)) {
		return summary.slice(locationName.length + 2);
	};

	const separator = summary.indexOf(': ');

	return separator >= 0 ? summary.slice(separator + 2) : summary;
};

function fallbackIcon(text) {
	const lower = String(text || '').toLowerCase();

	if (lower.includes('thunder') || lower.includes('storm')) {
		return 'weather-storm';
	};
	if (lower.includes('snow') || lower.includes('ice')) {
		return 'weather-snow';
	};
	if (lower.includes('rain') || lower.includes('shower') || lower.includes('drizzle')) {
		return 'weather-showers';
	};
	if (lower.includes('fog') || lower.includes('mist') || lower.includes('haze')) {
		return 'weather-fog';
	};
	if (lower.includes('cloud') || lower.includes('overcast')) {
		return 'weather-few-clouds';
	};

	return 'weather-clear';
};

function fullColorWeatherIcon(iconName) {
	const baseName = String(iconName || 'weather-clear')
		.replace(/-symbolic$/, '')
		.replace(/-(small|large)$/, '');
	const candidates = [
		`${baseName}-large.svg`,
		`${baseName}-small.svg`,
		`${baseName}.svg`,
	];

	for (const candidate of candidates) {
		const path = GLib.build_filenamev(['/usr/share/icons/hicolor/scalable/status', candidate]);
		const file = Gio.File.new_for_path(path);

		if (file.query_exists(null)) {
			return Gio.FileIcon.new(file);
		};
	};

	return null;
};

function symbolicIconName(iconName) {
	const base = String(iconName || 'weather-clear').replace(/-symbolic$/, '');

	return `${base}-symbolic`;
};

function scaledFont(base, scale) {
	return Math.max(1, Math.round(base * scale));
};

function smallWeatherIcon(iconName, styleClass, theme, sizePx) {
	return new St.Icon({
		style_class: styleClass,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		icon_name: symbolicIconName(iconName),
		style: `icon-size: ${sizePx}px; color: ${theme.text};`,
	});
};

function buildHourlyStrip(hours, theme, createLabel, stripScale, cellCount, opts = {}) {
	const timeFontBase = opts.timeFont ?? 11;
	const timeWeight = opts.timeWeight ?? 600;
	const iconSizeBase = opts.iconSize ?? 15;
	const tempFontBase = opts.tempFont ?? 13;
	const tempWeight = opts.tempWeight ?? 700;
	const timeColor = opts.timeColor ?? theme.muted;
	const spacing = opts.spacing ?? 6;
	const strip = new St.BoxLayout(boxLayoutProps({
		style_class: 'widget-weather-hourly',
		x_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		style: `spacing: ${Math.round(spacing * stripScale)}px;`,
	}));

	for (let index = 0; index < cellCount; index++) {
		const hour = hours[index];
		const cell = new St.BoxLayout(boxLayoutProps({
			vertical: true,
			style_class: 'widget-weather-hour',
			x_expand: true,
			y_align: Clutter.ActorAlign.CENTER,
		}));

		const timeLabel = createLabel(
			hour ? hour.label : '',
			'widget-weather-hour-time',
			`color: ${timeColor}; font-size: ${scaledFont(timeFontBase, stripScale)}px; font-weight: ${timeWeight}; text-align: center;`);

		timeLabel.x_align = Clutter.ActorAlign.CENTER;
		cell.add_child(timeLabel);
		cell.add_child(smallWeatherIcon(hour ? hour.icon : null, 'widget-weather-hour-icon', theme, scaledFont(iconSizeBase, stripScale)));

		const tempLabel = createLabel(
			hour ? hour.temp : '',
			'widget-weather-hour-temp',
			`color: ${theme.text}; font-size: ${scaledFont(tempFontBase, stripScale)}px; font-weight: ${tempWeight}; text-align: center;`);

		tempLabel.x_align = Clutter.ActorAlign.CENTER;
		cell.add_child(tempLabel);

		strip.add_child(cell);
	};

	return strip;
};

function tempNumber(value) {
	const match = String(value ?? '').match(/-?\d+(?:[.,]\d+)?/);

	return match ? Number(match[0].replace(',', '.')) : null;
};

function temperatureRange(daily, theme, createLabel, scale, size = 11, weight = 400, color) {
	const today = daily[0];

	if (!today) {
		return null;
	};

	const high = tempNumber(today.high);
	const low = tempNumber(today.low);

	if (high === null || low === null) {
		return null;
	};

	return createLabel(
		_('H:%s L:%s').format(today.high, today.low),
		'widget-weather-range',
		`color: ${color ?? theme.muted}; font-size: ${scaledFont(size, scale)}px; font-weight: ${weight};`);
};

function buildHeader(rendered, theme, createLabel, scale, opts = {}) {
	// The main temperature carries the accent color when the toggle allows it.
	const tempColor = opts.tempColor ?? theme.text;
	const cityFont = opts.cityFont ?? 17;
	const cityWeight = opts.cityWeight ?? 800;
	const tempFont = opts.tempFont ?? 38;
	const tempWeight = opts.tempWeight ?? 400;
	const condFont = opts.condFont ?? 13;
	const condWeight = opts.condWeight ?? 700;
	const condIcon = opts.condIcon ?? false;
	const condIconSize = opts.condIconSize ?? 16;
	const left = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		x_align: Clutter.ActorAlign.START,
		style: 'spacing: 0px;',
	}));

	// City name with navigation icon
	const cityRow = new St.BoxLayout(boxLayoutProps({
		vertical: false,
		x_align: Clutter.ActorAlign.START,
		style: 'spacing: 6px;',
	}));

	cityRow.add_child(createLabel(
		rendered.location,
		'widget-weather-city',
		`color: ${theme.text}; font-size: ${scaledFont(cityFont, scale)}px; font-weight: ${cityWeight};`));

	// Navigation icon (use white or black based on theme)
	const iconName = theme.dark ? 'navigation-white' : 'navigation-black';
	const iconPath = `${EXTENSION_PATH}/icons/widgets_settings/weather/${iconName}.svg`;
	const iconFile = Gio.File.new_for_path(iconPath);
	
	if (iconFile.query_exists(null)) {
		const navIcon = new St.Icon({
			gicon: Gio.icon_new_for_string(iconPath),
			icon_size: scaledFont(14, scale),
			y_align: Clutter.ActorAlign.START,
			style: `margin-top: ${scaledFont(1, scale)}px;`,
		});
		cityRow.add_child(navIcon);
	}

	left.add_child(cityRow);

	left.add_child(createLabel(
		rendered.temp,
		'widget-weather-temp-main',
		`color: ${tempColor}; font-size: ${scaledFont(tempFont, scale)}px; font-weight: ${tempWeight};`));

	const right = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		x_align: Clutter.ActorAlign.END,
		y_align: Clutter.ActorAlign.START,
		style: 'spacing: 0px;',
	}));
	// Apple Weather layout: icon, condition and H/L share ONE left edge
	// inside a block that is pinned to the right edge of the card. Each
	// line used to be right-aligned on its own, so a shorter H/L line sat
	// indented under the condition. Horizontal rows with an expanding
	// spacer do the pinning (cross-axis alignment is not relied upon).
	const block = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		style: 'spacing: 0px;',
	}));
	// A plain horizontal row packs its child at the start (left). No
	// expanding spacer inside: x_expand would propagate up to the block
	// and it would stop hugging the right edge.
	const leftAligned = actor => {
		const row = new St.BoxLayout(boxLayoutProps({}));
		row.add_child(actor);
		return row;
	};

	if (condIcon) {
		const iconParams = {
			style_class: 'widget-weather-condition-icon',
			style: `icon-size: ${scaledFont(condIconSize, scale)}px; icon-shadow: 0 2px 4px rgba(0, 0, 0, 0.42);`,
			x_align: Clutter.ActorAlign.END,
			y_align: Clutter.ActorAlign.CENTER,
		};
		const gicon = fullColorWeatherIcon(rendered.icon);

		if (gicon) {
			iconParams.gicon = gicon;
		} else {
			iconParams.icon_name = rendered.icon;
		};

		iconParams.x_align = Clutter.ActorAlign.START;
		block.add_child(leftAligned(new St.Icon(iconParams)));
	};

	const condRow = new St.BoxLayout(boxLayoutProps({
		x_align: Clutter.ActorAlign.START,
		y_align: Clutter.ActorAlign.CENTER,
		style: 'spacing: 4px;',
	}));

	condRow.add_child(createLabel(
		rendered.summary,
		'widget-weather-condition',
		`color: ${theme.text}; font-size: ${scaledFont(condFont, scale)}px; font-weight: ${condWeight};`));

	// H/L: condition row minus 1 unit (dialed scaledown); 600 weight stays.
	const range = temperatureRange(rendered.daily, theme, createLabel, scale, condFont - 1, 600);

	block.add_child(leftAligned(condRow));
	if (range) {
		range.x_align = Clutter.ActorAlign.START;
		block.add_child(leftAligned(range));
	};

	// Explicit x_expand=false stops the labels' x_expand (createLabel sets
	// it) from propagating up: only the spacer takes the free width.
	block.x_expand = false;
	const anchor = new St.BoxLayout(boxLayoutProps({x_expand: true}));
	anchor.add_child(new St.Widget({x_expand: true}));
	anchor.add_child(block);
	right.add_child(anchor);

	// With equalColumnWidth (2x1) the header splits into two exact halves;
	// otherwise the left column keeps its natural width and the rest goes
	// to a spacer. Fixed widths are used instead of layout-manager
	// homogeneous settings: St/Clutter allocation quirks made the left
	// column disappear with those.
	const header = new St.BoxLayout(boxLayoutProps({
		style_class: 'widget-weather-header',
		x_expand: true,
		y_align: Clutter.ActorAlign.START,
		style: 'spacing: 8px;',
	}));

	if (opts.equalColumnWidth) {
		left.set_width(opts.equalColumnWidth);
		right.set_width(opts.equalColumnWidth);
	};

	header.add_child(left);
	if (!opts.equalColumnWidth) {
		header.add_child(new St.Widget({x_expand: true}));
	};
	header.add_child(right);
	return header;
};

// Apple Weather–style temperature scale (°C): the bar's gradient runs from
// the color of the day's low to the color of its high.
const TEMP_COLOR_STOPS = [
	[-20, [0x5e, 0x5c, 0xe6]],
	[-8, [0x0a, 0x84, 0xff]],
	[2, [0x64, 0xd2, 0xff]],
	[10, [0x30, 0xd1, 0x58]],
	[18, [0xff, 0xd6, 0x0a]],
	[26, [0xff, 0x9f, 0x0a]],
	[34, [0xff, 0x45, 0x3a]],
];

function tempColor(celsius) {
	const stops = TEMP_COLOR_STOPS;
	if (!Number.isFinite(celsius))
		return '#8e8e93';
	if (celsius <= stops[0][0])
		return `rgb(${stops[0][1].join(', ')})`;
	for (let i = 1; i < stops.length; i++) {
		const [t1, c1] = stops[i];
		if (celsius <= t1) {
			const [t0, c0] = stops[i - 1];
			const k = (celsius - t0) / (t1 - t0);
			const rgb = c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
			return `rgb(${rgb.join(', ')})`;
		}
	}
	return `rgb(${stops[stops.length - 1][1].join(', ')})`;
}

// Apple Weather–style range bar: a thin rounded capsule track (centered on
// the row, never stretched to the row height — St's default FILL alignment
// made it ~20px tall), the day's low→high span colored by temperature, and
// on today's row a dot marking the current temperature.
function buildTempBar(day, allDays, trackWidth = 110, {theme = null, currentTemp = null, scale = 1} = {}) {
	const trackHeight = Math.max(3, Math.round(4 * scale));
	const radius = trackHeight / 2;
	const fahrenheit = /F/.test(`${day.low}${day.high}`);
	const toC = t => (t === null ? null : fahrenheit ? (t - 32) * 5 / 9 : t);

	const lows = allDays.map(d => tempNumber(d.low)).filter(n => n !== null);
	const highs = allDays.map(d => tempNumber(d.high)).filter(n => n !== null);
	const min = Math.min(...lows);
	const max = Math.max(...highs);
	const low = tempNumber(day.low);
	const high = tempNumber(day.high);
	const span = max - min;
	const frac = t => (Number.isFinite(span) && span > 0 ? (t - min) / span : 0.5);

	let start = 0.15;
	let end = 0.7;
	if (low !== null && high !== null && Number.isFinite(span) && span > 0) {
		start = frac(low);
		end = frac(high);
	}
	start = Math.max(0, Math.min(1, start));
	end = Math.max(start, Math.min(1, end));

	const dark = theme?.dark ?? true;
	const track = new St.Widget({
		style: `background-color: ${dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.10)'}; border-radius: ${radius}px;`,
		x_align: Clutter.ActorAlign.START,
		y_align: Clutter.ActorAlign.CENTER,
		x_expand: false,
		y_expand: false,
	});
	track.set_size(trackWidth, trackHeight);

	const offset = Math.round(trackWidth * start);
	const fillWidth = Math.max(trackHeight, Math.round(trackWidth * (end - start)));
	const fill = new St.Widget({
		style: `background-gradient-direction: horizontal; background-gradient-start: ${tempColor(toC(low))};`
			+ ` background-gradient-end: ${tempColor(toC(high))}; border-radius: ${radius}px;`,
	});
	fill.set_size(fillWidth, trackHeight);
	fill.set_position(Math.min(offset, trackWidth - fillWidth), 0);
	track.add_child(fill);

	// Today: the current temperature as a dot ringed in the card color.
	const now = tempNumber(currentTemp);
	if (now !== null && Number.isFinite(span) && span > 0) {
		const dot = Math.max(trackHeight + 2, Math.round(6 * scale));
		const x = Math.round(Math.max(0, Math.min(1, frac(now))) * trackWidth - dot / 2);
		const ring = theme?.background ?? '#1c1c1e';
		const dotActor = new St.Widget({
			style: `background-color: #ffffff; border-radius: ${dot / 2}px; border: ${Math.max(1, Math.round(scale * 1.5))}px solid ${ring};`,
		});
		dotActor.set_size(dot + 2, dot + 2);
		dotActor.set_position(Math.max(-1, Math.min(trackWidth - dot - 1, x - 1)), Math.round((trackHeight - dot) / 2) - 1);
		track.add_child(dotActor);
	}
	return track;
};

function buildWeekList(days, theme, createLabel, scale, barWidth = 110, fill = false, currentTemp = null) {
	const list = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		style_class: 'widget-weather-week',
		style: `spacing: ${Math.round(4 * scale)}px;`,
		clip_to_allocation: true,
	}));

	// With fill the list itself claims every free pixel under the hourly
	// strip, and its rows split that height equally — the card has no empty
	// gap at the bottom.
	if (fill) {
		list.y_expand = true;
	};

	for (const day of days) {
		const row = new St.BoxLayout(boxLayoutProps({
			style_class: 'widget-weather-day-row',
			x_expand: true,
			x_align: Clutter.ActorAlign.FILL,
			y_align: Clutter.ActorAlign.CENTER,
			style: `spacing: ${Math.round(4 * scale)}px;`,
		}));

		// With fill the rows share the leftover height of the card equally,
		// so the week list reaches the bottom edge with no empty gap.
		if (fill) {
			row.y_expand = true;
		};
		const name = createLabel(
			day.day,
			'widget-weather-day-name',
			`color: ${theme.text}; font-size: ${scaledFont(14, scale)}px; font-weight: 500; width: ${Math.round(56 * scale)}px;`);

		name.x_expand = false;
		name.clutter_text.set_line_wrap(false);
		name.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
		row.add_child(name);
		row.add_child(smallWeatherIcon(day.icon, 'widget-weather-day-icon', theme, scaledFont(20, scale)));

		const low = createLabel(
			day.low,
			'widget-weather-day-temps widget-weather-day-low',
			`color: ${theme.muted}; font-size: ${scaledFont(16, scale)}px; font-weight: 400; text-align: right; width: ${Math.round(30 * scale)}px;`);

		low.x_expand = false;
		row.add_child(low);
		row.add_child(buildTempBar(day, days, barWidth, {
			theme,
			scale,
			// Apple marks the current temperature on today's row only.
			currentTemp: day === days[0] ? currentTemp : null,
		}));

		const high = createLabel(
			day.high,
			'widget-weather-day-temps widget-weather-day-high',
			`color: ${theme.text}; font-size: ${scaledFont(16, scale)}px; font-weight: 600; text-align: right; width: ${Math.round(30 * scale)}px;`);

		high.x_expand = false;
		row.add_child(high);
		list.add_child(row);
	};

	return list;
};

function stripDivider() {
	return new St.Widget({
		x_expand: true,
		style: 'height: 1px; min-height: 1px; background-color: rgba(255, 255, 255, 0.12); margin-top: 4px; margin-bottom: 2px;',
	});
};

// Compact (1×1) card in the W01 style: location label, a bold accent-colored
// temperature, then the condition icon, the sky summary and the day's
// high/low, stacked in a single left-aligned column.
function buildCompactRegime(body, rendered, theme, createLabel, scale, tempColor, settings) {
	// City name with navigation icon — one standard horizontal layout box:
	// the arrow joins the name on the same visual line through the box's
	// cross-axis centering (vertical-align: middle), no absolute
	// positioning and no manual margins.
	const cityRow = new St.BoxLayout(boxLayoutProps({
		vertical: false,
		x_align: Clutter.ActorAlign.START,
		style: 'spacing: 5px;',
	}));

	cityRow.add_child(createLabel(
		rendered.location,
		'widget-weather-city',
		`color: ${theme.text}; font-size: ${scaledFont(16, scale)}px; font-weight: 800;`));

	// Navigation icon (use white or black based on theme)
	const iconName = theme.dark ? 'navigation-white' : 'navigation-black';
	const iconPath = `${EXTENSION_PATH}/icons/widgets_settings/weather/${iconName}.svg`;
	const iconFile = Gio.File.new_for_path(iconPath);

	if (iconFile.query_exists(null)) {
		const navIcon = new St.Icon({
			gicon: Gio.icon_new_for_string(iconPath),
			icon_size: scaledFont(12, scale),
			// Standard box alignment: the icon centers on the name's line
			// box, so label and arrow share one visual baseline.
			y_align: Clutter.ActorAlign.CENTER,
		});
		cityRow.add_child(navIcon);
	}

	body.add_child(cityRow);

	// Main temperature, restored: plain labels only — a Pango markup span
	// invalid-attribute parse failure is what cleared the text before, so
	// markup stays out. The temperature is the card's focal point: double
	// the previous mid size (48 base, capped at 56 so the page never
	// feels clipped); the degree mark is its own small label pinned to
	// the digits' line top — the superscript look — with no fixed
	// heights and no manual margins.
	const tempFont = Math.min(scaledFont(48, scale), 56);
	const tint = tempColor ?? theme.accent;

	const tempRow = new St.BoxLayout(boxLayoutProps({
		vertical: false,
		x_align: Clutter.ActorAlign.START,
		style: 'spacing: 1px;',
	}));

	const digitsLabel = createLabel(
		String(rendered.temp ?? '--').replace('°', ''),
		'widget-weather-temp-main',
		`color: ${tint}; font-size: ${tempFont}px; font-weight: 600;`);
	const degFont = Math.max(11, Math.min(Math.round(tempFont * 0.5), 30));
	const degLabel = createLabel(
		'°',
		'widget-weather-temp-degree',
		`color: ${tint}; font-size: ${degFont}px; font-weight: 600;`);
	// createLabel defaults to x_expand: true (the framework's _label) —
	// in a full-width row that would fling the ° toward the right edge;
	// pin both to their natural width, packed left after the digits.
	digitsLabel.x_expand = false;
	degLabel.x_expand = false;
	// Superscript: cross-axis start keeps the mark at the top of the
	// digits' line box, sharing the digits' baseline as ordinary type.
	degLabel.y_align = Clutter.ActorAlign.START;

	tempRow.add_child(digitsLabel);
	tempRow.add_child(degLabel);
	body.add_child(tempRow);

	// Balanced lower half: an equal expanding filler above the condition
	// block and one below it split the page's remaining air, so the gap
	// between the big temperature and the icon/summary/H-L rows equals
	// the gap between that block and the dots at the bottom edge — the
	// lower group centers in the space under the temperature instead of
	// packing tight against it.
	body.add_child(new St.Widget({y_expand: true}));

	const bottom = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		x_align: Clutter.ActorAlign.START,
		// Removed y_align: END and bottomLift margin — content naturally sits
		// in the middle now that the spacer below (not above) pushes it up.
		style: `spacing: 2px;`,
	}));
	const iconParams = {
		style_class: 'widget-weather-icon',
		style: `icon-size: ${scaledFont(24, scale)}px; icon-shadow: 0 2px 4px rgba(0, 0, 0, 0.42);`,
		x_align: Clutter.ActorAlign.START,
		y_align: Clutter.ActorAlign.CENTER,
	};
	const gicon = fullColorWeatherIcon(rendered.icon);

	if (gicon) {
		iconParams.gicon = gicon;
	} else {
		iconParams.icon_name = rendered.icon;
	};

	bottom.add_child(new St.Icon(iconParams));
	bottom.add_child(createLabel(
		rendered.summary,
		'widget-weather-summary',
		`color: ${theme.text}; font-size: ${scaledFont(13, scale)}px; font-weight: 600;`));

	// H/L: mirrors the condition line directly above it — same 13-unit
	// font, same 600 weight, same full-strength text color (no muted
	// dimming), so the two small rows read as one visual voice.
	const range = temperatureRange(rendered.daily, theme, createLabel, scale, 13, 600, theme.text);

	if (range) {
		bottom.add_child(range);
	};

	// Clear dot gap: the expanding filler under the condition block keeps
	// its equal share with the filler above it (proportional air), and a
	// fixed foot under that reserves the dots band (dot/dash + its row
	// margin, height from the shared component) plus a small extra
	// margin. The H/L line therefore always sits a clear distance above
	// the pagination indicators — never touching or sliding under them —
	// and the dots render on top of the transparent foot.
	body.add_child(bottom);
	body.add_child(new St.Widget({y_expand: true}));
	body.add_child(new St.Widget({
		width: 1,
		height: indicatorBandHeight(settings),
	}));
};

export function render({body, widget, createLabel, theme, weather, weatherLocation, sizeForWidget, settings}) {
	// The main temperature is accent-colored by default; the toggle in the
	// widget's preferences switches it back to the neutral text color.
	const useAccentColor = settings?.get_boolean('weather-use-accent-color') ?? true;
	const tempColor = useAccentColor ? theme.accent : theme.text;
	const detail = widget.data?.detail || _('Weather unavailable');
	const renderedWeather = weather ?? {
		temp: formatTemperature(String(detail).split(/\s+/)[0] || '--'),
		summary: String(detail).replace(/^\S+\s*/, '') || _('Open Weather to set a location'),
		location: weatherLocation || widget.data?.location || _('GNOME Weather'),
		icon: fallbackIcon(detail),
		feelsLike: null,
		hourly: [],
		daily: [],
	};
	const [widgetWidth, widgetHeight] = sizeForWidget(widget);

	// Three coherent regimes, decided by width and height:
	//   compact (width < 340):        location + accent temp + icon/summary/H-L (1x1)
	//   wide    (width >= 340, short): header + hourly strip             (2x4)
	//   large   (width >= 340, tall):  header + hourly + temp-bar week   (4x4)
	const large = widgetWidth >= 340 && widgetHeight >= 340;
	const wide = widgetWidth >= 340 && !large;
	// Exact equal halves for the 2x1 header: content box = cell width minus
	// the card chrome (18px padding on each side + 1px border), minus the
	// 8px gap between the two header columns.
	const equalColumnWidth = Math.floor((widgetWidth - 38 - 8) / 2);
	// HTML mockups are drawn at 360px (wide/large) and 170px (compact),
	// but the real widgets are 454px / 220px wide, so scale fonts up
	// proportionally to keep them looking the same size as in the mockups.
	const scale = Math.max(1, Math.min(1.6, widgetWidth / 360));
	const compactScale = large || wide ? 1 : Math.max(0.9, Math.min(1.6, Math.min(widgetWidth, widgetHeight) / 170));

	if (!wide && !large) {
		// ── 1x1 — two swipeable pages, the calendar's flip animation ──────
		// Page one is the classic compact card (location, temp, icon,
		// summary, H/L). Page two carries the incoming hours — time, icon
		// and temperature per column, the wide card's hourly strip scaled
		// down. The right-button swipe plays the calendar's sequential
		// leg: the page slides out and fades, the other one waits
		// off-stage, then slides in from the opposite side. Page dots
		// accompany both pages, always rendered.
		// Page dots (calendar's classic look, ALWAYS rendered): dash/dot
		// follows the global page-indicator-style, the color is the accent
		// while the weather accent toggle is on, otherwise the neutral
		// theme text.
		const pages = [];

		const conditionsPage = new St.BoxLayout(boxLayoutProps({
			vertical: true,
			x_expand: true,
			y_expand: true,
		}));
		buildCompactRegime(conditionsPage, renderedWeather, theme, createLabel, compactScale, tempColor, settings);
		pages.push(conditionsPage);

		const hoursPage = new St.BoxLayout(boxLayoutProps({
			vertical: true,
			x_expand: true,
			y_expand: true,
		}));
		const hourly = renderedWeather.hourly ?? [];
		if (hourly.length > 0) {
			// Two rows of two cells (the mockup look) — a 2x2 grid of
			// upcoming hours, vertically centered on the page. Each cell
			// reuses the hourly strip cell: time, icon, temperature.
			const rowIndexes = [0, 2];
			const hoursGrid = new St.BoxLayout(boxLayoutProps({
				vertical: true,
				x_expand: true,
				x_align: Clutter.ActorAlign.FILL,
				style: `spacing: ${Math.round(8 * compactScale)}px;`,
			}));

			rowIndexes.forEach(rowIndex => {
				const rowHours = hourly.slice(rowIndex, rowIndex + 2);

				if (rowHours.length === 0) {
					return;
				};

				hoursGrid.add_child(buildHourlyStrip(rowHours, theme, createLabel, compactScale, 2, {
					timeFont: 10,
					timeWeight: 700,
					iconSize: 26,
					tempFont: 15,
					tempWeight: 700,
					timeColor: theme.muted,
				}));
			});

			// Vertical centering that accounts for the indicator band: the
			// dots overlay the page's bottom band (7px), so plain equal
			// fillers would leave the air to the top border and the air
			// to the dots unequal. A fixed foot (exactly the dots band
			// height, from the shared component) sits under the bottom
			// filler, so the two equal fillers only split the space ABOVE
			// the band — the grid centers within (page height - band) and
			// the air above it equals the air between it and the dots.
			// The foot is invisible; the dots render on top of it.
			hoursPage.add_child(new St.Widget({y_expand: true}));
			hoursPage.add_child(hoursGrid);
			hoursPage.add_child(new St.Widget({y_expand: true}));
			hoursPage.add_child(new St.Widget({
				width: 1,
				height: indicatorBandHeight(settings),
			}));
		} else {
			// No forecast payload: keep the page real but quiet.
			const emptyLabel = createLabel(
				_('No forecast'),
				'widget-weather-hours-empty',
				`color: ${theme.muted}; font-size: 12px; font-weight: 600;`);
			emptyLabel.x_align = Clutter.ActorAlign.CENTER;

			hoursPage.add_child(new St.Widget({y_expand: true}));
			hoursPage.add_child(emptyLabel);
			hoursPage.add_child(new St.Widget({y_expand: true}));
		}
		pages.push(hoursPage);
		pages.forEach(page => {
			page.x_align = Clutter.ActorAlign.FILL;
			page.y_align = Clutter.ActorAlign.FILL;
		});

		// dash/dot follows the global page-indicator-style,
		// the color is the accent while the page-indicator toggle is on,
		// otherwise the neutral theme text — the shared page indicator
		// component (the calendar's pagination, identical spacing, size,
		// active-state opacity and vertical offset).
		const indicatorColor = settings?.get_boolean('weather-page-indicator-accent') ?? true
			? (theme?.accent ?? theme.text)
			: theme.text;
		const indicator = createPageIndicator({settings, count: pages.length, color: indicatorColor});

		const pageStack = new St.Widget({
			layout_manager: new Clutter.BinLayout(),
			x_expand: true,
			y_expand: true,
			clip_to_allocation: true,
		});
		pageStack.add_child(pages[weatherCompactPage]);

		// ── EXACTLY the calendar widget's indicator hierarchy ─────────────
		// The dots wrap is added to the SAME BinLayout stack as the pages
		// (dots paint above the pages) and pins itself to the very
		// bottom-center of the shared rect through its internal
		// y-expanding filler — the "vertical-align: end" of the main
		// vertical box. The dots are added UNCONDITIONALLY: no pref, no
		// content height and no overflow path can leave this indicator out
		// of the layout child list. The card's bottom padding is 4px (the
		// calendar's value), so the band rests 6px above the frame edge,
		// identical spacing/size/active-state to the calendar's dots.
		pageStack.add_child(indicator.wrap);

		body.add_child(pageStack);

		// The dots delegate to the shared page-indicator component; the
		// wrap guard lives inside refresh().
		const refreshDots = () => indicator.refresh(weatherCompactPage);
		refreshDots();

		// Dispose safety: re-renders replace this whole page stack; the
		// late flight timers of a swipe must never touch disposed actors.
		const stackLifetime = {alive: true};
		const pageLifetimes = pages.map(page => {
			const lifetime = {alive: true};
			page.connect('destroy', () => { lifetime.alive = false; });
			return lifetime;
		});
		pageStack.connect('destroy', () => { stackLifetime.alive = false; });

		// Apple-style pager (right button): both pages ride ONE strip — the
		// current page follows the pointer and the other page is attached
		// right beside it, so every frame shows both moving together. On
		// release past the threshold (or a quick flick) the strip settles on
		// the new page; otherwise it springs back. The old swipe ran two
		// separate legs (slide+fade out, then a delayed slide+fade in).
		const PAGE_GAP = 12;
		let drag = null; // {startX, startTime, lastX, lastTime, dx, entering, grab}
		let settling = false;
		pageStack.reactive = true;

		const pageDistance = () => Math.max(1, Math.round(pageStack.width || widgetWidth)) + PAGE_GAP;
		const placeEntering = (entering, dx) => {
			const d = pageDistance();
			entering.translation_x = dx + (dx < 0 ? d : -d);
		};
		const endGrab = () => {
			if (drag?.grab) {
				try {
					drag.grab.dismiss();
				} catch (_e) {}
				drag.grab = null;
			}
		};

		pageStack.connect('button-press-event', (actor, event) => {
			// An open gesture here lost its release: close it, then go on.
			if (drag)
				finishDrag(false);
			if (event.get_button() !== 3 || settling)
				return Clutter.EVENT_PROPAGATE;
			const [x, y0] = event.get_coords();
			const now = GLib.get_monotonic_time() / 1000;
			drag = {startX: x, startY: y0, claimed: false, lastX: x, lastTime: now, velocity: 0, dx: 0, entering: null, grab: null, hold: createHoldWatch(BUTTON3_MASK)};
			return Clutter.EVENT_PROPAGATE;
		});

		pageStack.connect('motion-event', (actor, event) => {
			if (!drag || !stackLifetime.alive)
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
					drag.grab = global.stage.grab(pageStack);
				} catch (_e) {}
			}
			const [x] = event.get_coords();
			const now = GLib.get_monotonic_time() / 1000;
			const dt = Math.max(1, now - drag.lastTime);
			drag.velocity = (x - drag.lastX) / dt; // px per ms
			drag.lastX = x;
			drag.lastTime = now;
			drag.dx = x - drag.startX;
			// Two pages: nothing lies beyond the neighbour — clamp to one page.
			drag.dx = Math.max(-pageDistance(), Math.min(pageDistance(), drag.dx));

			const leaving = pages[weatherCompactPage];
			const entering = pages[1 - weatherCompactPage];
			if (!drag.entering && Math.abs(drag.dx) > 2) {
				drag.entering = entering;
				entering.remove_all_transitions();
				entering.opacity = 255;
				if (entering.get_parent() !== pageStack)
					pageStack.insert_child_below(entering, indicator.wrap);
			}
			leaving.remove_all_transitions();
			leaving.opacity = 255;
			leaving.translation_x = drag.dx;
			if (drag.entering)
				placeEntering(entering, drag.dx);
			return Clutter.EVENT_STOP;
		});

		const finishDrag = (allowCommit) => {
			if (!drag)
				return;
			const {dx, velocity, entering} = drag;
			endGrab();
			drag = null;
			if (!entering || !stackLifetime.alive)
				return;

			const leavingIndex = weatherCompactPage;
			const leaving = pages[leavingIndex];
			const d = pageDistance();
			const flick = Math.abs(velocity) > 0.5 && Math.sign(velocity) === Math.sign(dx);
			const commit = allowCommit && (Math.abs(dx) > WEATHER_SWIPE_THRESHOLD || flick);
			const remaining = commit ? d - Math.abs(dx) : Math.abs(dx);
			const duration = Math.round(Math.min(380, Math.max(200, remaining * 1.1)));
			const mode = Clutter.AnimationMode.EASE_OUT_CUBIC;

			settling = true;
			if (commit) {
				weatherCompactPage = 1 - weatherCompactPage;
				refreshDots();
				entering.ease({translation_x: 0, duration, mode});
				leaving.ease({
					translation_x: dx < 0 ? -d : d,
					duration,
					mode,
					onStopped: () => {
						settling = false;
						if (pageLifetimes[leavingIndex].alive && leaving.get_parent() === pageStack) {
							pageStack.remove_child(leaving);
							leaving.translation_x = 0;
						}
					},
				});
			} else {
				leaving.ease({translation_x: 0, duration, mode});
				entering.ease({
					translation_x: dx < 0 ? d : -d,
					duration,
					mode,
					onStopped: () => {
						settling = false;
						const idx = 1 - leavingIndex;
						if (pageLifetimes[idx].alive && entering.get_parent() === pageStack) {
							pageStack.remove_child(entering);
							entering.translation_x = 0;
						}
					},
				});
			}
		};
		pageStack.connect('button-release-event', (actor, event) => {
			if (!drag || event.get_button() !== 3)
				return Clutter.EVENT_PROPAGATE;
			finishDrag(true);
			return Clutter.EVENT_STOP;
		});
		// A swallowed release (an app or the overview grabbed the pointer
		// mid-gesture), hiding, another press or Escape end the gesture —
		// the pointer grab must never stay stuck on the widget.
		pageStack.connect('notify::mapped', () => {
			if (!pageStack.mapped)
				finishDrag(false);
		});
		pageStack.connect('key-press-event', (actor, event) => {
			if (drag && event.get_key_symbol() === Clutter.KEY_Escape) {
				finishDrag(false);
				return Clutter.EVENT_STOP;
			}
			return Clutter.EVENT_PROPAGATE;
		});
		pageStack.connect('destroy', () => endGrab());
		return;
	};

	const hourly = renderedWeather.hourly;
	// Size the hourly cells from the measured time label so the full
	// "9:00 PM" always fits (12h locales) instead of being clipped.
	const stripTimeFont = large ? 12 : 10;
	const stripTimeWeight = large ? 700 : 800;
	const widestHourTime = hourly.slice(0, 6).reduce(
		(maxW, item) => Math.max(maxW, item ? measureLabelWidth(item.label, scaledFont(stripTimeFont, scale), stripTimeWeight) : 0),
		0);
	const hourCellWidth = Math.max(Math.round(52 * scale), widestHourTime + Math.round(8 * scale));
	const hourCount = Math.min(6, Math.max(4, Math.floor((widgetWidth - Math.round(40 * scale)) / hourCellWidth)), hourly.length || 0);

	if (large) {
		body.add_child(buildHeader(renderedWeather, theme, createLabel, scale, {
			cityFont: 17,
			cityWeight: 800,
			tempFont: 38,
			tempWeight: 600,
			tempColor,
			condFont: 13,
			condWeight: 800,
			condIcon: true,
			condIconSize: 16,
		}));

		if (hourly.length > 0 && hourCount >= 4) {
			body.add_child(stripDivider());
			body.add_child(buildHourlyStrip(hourly, theme, createLabel, scale, hourCount, {
				timeFont: 12,
				timeWeight: 700,
				iconSize: 24,
				tempFont: 14,
				tempWeight: 700,
				timeColor: theme.muted,
			}));
		};

		if (renderedWeather.daily.length > 0) {
			const stripContentH = Math.round((12 + 24 + 14 + 16) * scale);
			const headerH = Math.round((17 + 2 + 38) * scale);
			const availableH = Math.max(1, widgetHeight - Math.round(20 * scale) - headerH - stripContentH - (hourCount >= 4 ? Math.round(12 * scale) : 0) - Math.round(4 * scale));
			// 2x2 (square) can fit a longer week list, the 4x2 (wide) layout
			// keeps a 5-day summary: square/tall widgets show as many days as
			// the available height allows (up to 8 days, incl. the day after
			// Saturday); wide widgets show exactly one more than before.
			const wideLayout = widgetWidth >= widgetHeight * 1.6;
			let targetDays = Math.min(5, renderedWeather.daily.length);
			if (!wideLayout) {
				const maxDays = Math.min(8, renderedWeather.daily.length);
				for (let n = targetDays + 1; n <= maxDays; n++) {
					if (availableH / (n * 20 + (n - 1) * 4) >= 0.6)
						targetDays = n;
					else
						break;
				};
			};
			const days = renderedWeather.daily.slice(0, targetDays);
			const weeklyScale = Math.max(0.6, Math.min(scale, availableH / (targetDays * 20 + (targetDays - 1) * 4)));
			const rowSpacing = Math.round(6 * weeklyScale);
			const rowWidths = Math.round(56 * weeklyScale) + Math.round(20 * weeklyScale) + Math.round(30 * weeklyScale) + Math.round(30 * weeklyScale) + rowSpacing * 4;
			const barWidth = Math.max(60, widgetWidth - Math.round(36 * weeklyScale) - rowWidths);

			if (days.length > 0) {
				body.add_child(stripDivider());
				body.add_child(buildWeekList(days, theme, createLabel, weeklyScale, barWidth, true, renderedWeather.temp));
			};
		} else {
			// No week data: the old bottom spacer keeps the hourly strip
			// anchored under the header instead of stretching it.
			body.add_child(new St.Widget({y_expand: true}));
		};
		return;
	};

	// Wide (2x4, Tokyo): city + temp left, condition (icon + text + range) right,
	// hourly strip at the bottom.
	body.add_child(buildHeader(renderedWeather, theme, createLabel, scale, {
		cityFont: 17,
		cityWeight: 800,
		tempFont: 34,
		tempWeight: 600,
		tempColor,
		condFont: 14,
		condWeight: 700,
		condIcon: true,
		condIconSize: 16,
		equalColumnWidth,
	}));

	if (!(hourly.length > 0 && hourCount >= 4)) {
		body.add_child(new St.Widget({y_expand: true}));
		return;
	};

	body.add_child(new St.Widget({y_expand: true}));
	body.add_child(buildHourlyStrip(hourly, theme, createLabel, scale, hourCount, {
		timeFont: 12,
		timeWeight: 800,
		iconSize: 26,
		tempFont: 18,
		tempWeight: 700,
		timeColor: theme.muted,
	}));
};