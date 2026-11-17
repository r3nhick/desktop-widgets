import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { bounceButton, bindHoverShrink } from '../../lib/buttonBounce.js';
import { parseCssColor } from '../../utils/ported.js';
import {
	elapsedSinceWall,
	loadWidgetStateAsync,
	saveWidgetState,
	saveWidgetStateSync,
	widgetStatePath,
} from '../../lib/widgetState.js';

export const type = 'stopwatch';
export const label = 'Stopwatch';
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium'];

// The display is derived from a monotonic anchor, so the tick rate only
// decides how often the text refreshes. The 1×1 shows mm:ss — 4 updates a
// second are plenty; the 2×1 shows centiseconds — ~30 fps reads as smooth
// (the old 10 ms timer ran 100 updates/s, faster than any monitor redraws).
const TICK_SMALL_MS = 250;
const TICK_MEDIUM_MS = 33;
const PERSIST_EVERY_MS = 1000;

// Skips the GI round-trip when the text did not change (most ticks).
function setTextIfChanged(label, text) {
	if (label.text !== text)
		label.set_text(text);
}

function formatTime(totalCentiseconds) {
	const totalSeconds = Math.floor(totalCentiseconds / 100);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const centiseconds = totalCentiseconds % 100;

	return {
		minutes: minutes.toString().padStart(2, '0'),
		seconds: seconds.toString().padStart(2, '0'),
		centiseconds: centiseconds.toString().padStart(2, '0'),
	};
}

/*
 * The whole clock lives in render-closure variables, so a theme or style
 * switch (every widget gets rebuilt) used to wipe a running stopwatch.
 * The per-instance JSON file survives those rebuilds — and the wall-clock
 * stamp even carries a running time across a GNOME relogin.
 */
function openStopwatchState({body, widget, isRunning, getCentiseconds, onRestore}) {
	const statePath = widgetStatePath('stopwatch', widget);

	const snapshot = () => ({
		centiseconds: getCentiseconds(),
		running: isRunning(),
		wall: Date.now(),
	});

	loadWidgetStateAsync(statePath, body, onRestore);

	return {
		// Called on control actions and, while running, about once a
		// second so the wall stamp stays fresh for surprise teardowns.
		persist: () => saveWidgetState(statePath, snapshot()),
		// Synchronous flush right before the widget is torn down.
		flush: () => saveWidgetStateSync(statePath, snapshot()),
	};
}

function accentColor(theme) {
	const accent = String(theme?.accent ?? '').trim();
	return accent || '#3584e4';
}

function textOnAccentColor(accent, theme) {
	const { r, g, b } = parseCssColor(accent);
	const lum = 0.299 * r + 0.587 * g + 0.114 * b;
	
	// Dark theme needs higher threshold to avoid dark text on dark accent
	const threshold = theme?.dark ? 0.6 : 0.45;
	return lum > threshold ? '#000000' : '#ffffff';
}

// Real pixel metrics of a text line, probed against the same font map and
// resolution the shell paints St text with (the pattern proven in
// lib/seekBar.js). Used to size the time row and to anchor the colon dots
// on the digit ink instead of design guesses.
function measureText(text, fontPx, weight) {
	const fallback = {
		logicalH: Math.ceil(fontPx * 1.25),
		inkCenterY: Math.round(fontPx * 0.62),
	};
	try {
		const context = PangoCairo.FontMap.get_default().create_context();
		const layout = Pango.Layout.new(context);
		// Pango markup has no "pixelsize" attribute: set_markup threw and
		// every caller silently got the rough fallback metrics (the colon
		// dots then sat below the digits' real midline).
		const desc = Pango.FontDescription.from_string(`Ubuntu ${weight === '700' ? 'Bold' : ''}`.trim());
		desc.set_absolute_size(fontPx * Pango.SCALE);
		layout.set_font_description(desc);
		layout.set_text(text, -1);
		const [ink, logical] = layout.get_pixel_extents();
		if (logical && logical.height > 0) {
			return {
				logicalH: logical.height,
				inkCenterY: ink.y + ink.height / 2,
			};
		}
	} catch (e) {}
	return fallback;
}

// Ghost buttons read against the surface: the white outline was invisible
// on light cards, so light mode draws an ink outline instead.
function ghostBorderColor(theme) {
	return theme?.dark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.18)';
}

function renderSmallTimer({body, theme, sizeForWidget, widget}) {
	const textColor = theme.text;
	const mutedColor = theme.muted;
	const accentHex = accentColor(theme);
	const accentTextColor = textOnAccentColor(accentHex, theme);
	const [totalWidth, totalHeight] = sizeForWidget(widget);
	const width = totalWidth - 34;
	const height = totalHeight - 34;
	const scale = Math.min(width / 180, height / 180);
	const px = (v) => Math.max(1, Math.round(v * scale));

	let centiseconds = 0;
	let isRunning = false;
	let timerId = null;
	let tickCount = 0;
	// The display derives from a monotonic anchor, not from per-tick
	// increments: delayed 10 ms timers would otherwise drop centiseconds
	// permanently and the stopwatch would drift slow.
	let runBaseCs = 0;
	let runAnchorMono = 0;

	const state = openStopwatchState({body, widget,
		isRunning: () => isRunning,
		getCentiseconds: () => centiseconds,
		onRestore: (saved) => {
			if (typeof saved?.centiseconds === 'number' && saved.centiseconds > 0) {
				centiseconds = saved.centiseconds;
			}
			if (saved?.running) {
				// Add every wall-clock millisecond that passed since the
				// save, so the run continues exactly where it was.
				centiseconds += Math.round(elapsedSinceWall(saved.wall) / 10);
				updateDisplay();
				if (!isRunning) {
					startTimer();
				}
			} else {
				updateDisplay();
			}
		},
	});

	const mainBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(12)}px;`,
	});

	body.add_child(mainBox);

	// Time display - vertical stack for 1x1
	const timeBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(4)}px;`,
	});

	// Minutes:Seconds (no centiseconds for the small widget)
	const timeLabel = new St.Label({
		text: '00:00',
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(42)}px; font-weight: 700;`,
	});

	const timeCaption = new St.Label({
		text: _('Min : Sec'),
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${mutedColor}; font-size: ${px(20)}px; font-weight: 600;`,
	});

	timeBox.add_child(timeLabel);
	timeBox.add_child(timeCaption);
	mainBox.add_child(timeBox);

	// Buttons - horizontal for small widget
	const buttonsBox = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(6)}px;`,
	});

	const pauseBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'media-playback-start-symbolic',
			icon_size: px(20),
			style: `color: ${accentTextColor};`,
		}),
		style: `padding: ${px(8)}px ${px(16)}px; border-radius: ${px(8)}px; background-color: ${accentHex};`,
	});

	const resetBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'view-refresh-symbolic',
			icon_size: px(20),
			style: `color: ${textColor};`,
		}),
		style: `padding: ${px(8)}px ${px(16)}px; border-radius: ${px(8)}px; background-color: transparent; border: 1px solid ${ghostBorderColor(theme)};`,
	});

	bindHoverShrink(pauseBtn);
	bindHoverShrink(resetBtn);

	buttonsBox.add_child(pauseBtn);
	buttonsBox.add_child(resetBtn);
	mainBox.add_child(buttonsBox);

	const updateDisplay = () => {
		const time = formatTime(centiseconds);
		setTextIfChanged(timeLabel, `${time.minutes}:${time.seconds}`);
	};

	const startTimer = () => {
		if (isRunning) return;
		isRunning = true;
		runBaseCs = centiseconds;
		runAnchorMono = GLib.get_monotonic_time();
		timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_SMALL_MS, () => {
			centiseconds = Math.floor(runBaseCs + (GLib.get_monotonic_time() - runAnchorMono) / 10000);
			updateDisplay();
			// Keep the wall stamp fresh (≤ ~1s stale) for surprise teardowns.
			if (++tickCount % Math.round(PERSIST_EVERY_MS / TICK_SMALL_MS) === 0) {
				state.persist();
			}
			return GLib.SOURCE_CONTINUE;
		});
		state.persist();
		pauseBtn.child.icon_name = 'media-playback-pause-symbolic';
	};

	const stopTimer = () => {
		if (!isRunning) return;
		isRunning = false;
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
		state.persist();
		pauseBtn.child.icon_name = 'media-playback-start-symbolic';
	};

	const resetTimer = () => {
		stopTimer();
		centiseconds = 0;
		updateDisplay();
		state.persist();
	};

	pauseBtn.connect('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1) {
			return Clutter.EVENT_PROPAGATE;
		}
		bounceButton(pauseBtn);
		if (isRunning) {
			stopTimer();
		} else {
			startTimer();
		}
		return Clutter.EVENT_STOP;
	});

	resetBtn.connect('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1) {
			return Clutter.EVENT_PROPAGATE;
		}
		bounceButton(resetBtn);
		resetTimer();
		return Clutter.EVENT_STOP;
	});

	body.connect('destroy', () => {
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
		// Exact snapshot for in-process rebuilds and logout marathons.
		state.flush();
	});

	updateDisplay();
}

function renderMediumTimer({body, theme, sizeForWidget, widget}) {
	const textColor = theme.text;
	const mutedColor = theme.muted;
	const accentHex = accentColor(theme);
	const accentTextColor = textOnAccentColor(accentHex, theme);
	const [width, height] = sizeForWidget(widget);
	const contentW = width - 34;
	const contentH = height - 34;
	const scale = Math.min(contentW / 540, contentH / 200);
	const px = (v) => Math.max(1, Math.round(v * scale));

	let centiseconds = 0;
	let isRunning = false;
	let timerId = null;
	let tickCount = 0;
	// Monotonic anchor (see renderSmallTimer) so the display cannot
	// accumulate drift from delayed timer fires.
	let runBaseCs = 0;
	let runAnchorMono = 0;

	const state = openStopwatchState({body, widget,
		isRunning: () => isRunning,
		getCentiseconds: () => centiseconds,
		onRestore: (saved) => {
			if (typeof saved?.centiseconds === 'number' && saved.centiseconds > 0) {
				centiseconds = saved.centiseconds;
			}
			if (saved?.running) {
				// Add every wall-clock millisecond that passed since the
				// save, so the run continues exactly where it was.
				centiseconds += Math.round(elapsedSinceWall(saved.wall) / 10);
				updateDisplay();
				if (!isRunning) {
					startTimer();
				}
			} else {
				updateDisplay();
			}
		},
	});

	const mainBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		// The cluster (digits, unit labels, buttons) is vertically CENTERED
		// inside the card by two equal expanding fillers (below); the box
		// expands to the full body height, so its own align is moot.
		y_align: Clutter.ActorAlign.CENTER,
		// Tight layer gap: the unit labels hug the digit row, and the control
		// row hugs the labels (its own extra margin sits on buttonsBox).
		style: `spacing: ${px(6)}px;`,
	});

	body.add_child(mainBox);

	// Real text metrics for the time row, probed the same way St will paint
	// them (same font map + resolution): they size the digit zones and
	// anchor the colon dots on the digits' ink midline (see buildColon).
	const digitFontPx = px(64);
	const captionFontPx = px(19);
	const digitLine = measureText('00', digitFontPx, '700');
	const captionLine = measureText(_('Minutes'), captionFontPx, '700');

	// One shared digit slot for all three columns plus a fixed colon block
	// between them. Slot 133 fits the 19px/700 "Centiseconds" caption with
	// symmetric pads and keeps the row inside the 540 canvas.
	const digitSlot = px(133);
	const colonSlot = px(16);
	// Wide, symmetric air on both sides of the colon (identical padding on
	// the left and right), so the separator sits BETWEEN the digit pairs
	// and never reads as attached to the next group (" :00").
	const colonGap = px(10);

	// Fixed-height zones (≥ measured line heights): glyph blocks center
	// inside them, so a taller resolved line box can never push text out of
	// its zone and under the next layer.
	const digitZone = Math.max(px(80), Math.ceil(digitLine.logicalH * 1.08));
	const captionZone = Math.max(px(26), captionLine.logicalH);

	// ── Layer 1: the digit columns ────────────────────────────────────────
	// Five distinct children, in order: [digits][separator][digits]
	// [separator][digits] — and each "digits" element is a vertical
	// sub-container that groups the digit pair WITH its unit label, so
	// every label centers on its own digits, never on the whole container.
	// Digit labels keep only their natural ink width, so the slot bin's
	// x/y alignment — not Pango line alignment, not a CSS width — is the
	// single force that centers every digit pair; the colon air is
	// identical on both sides (gap 10 / slot 16 / gap 10).
	const digitLabel = (text) => new St.Label({
		text,
		style: `color: ${textColor}; font-family: Ubuntu; font-size: ${digitFontPx}px; font-weight: 700; font-variant-numeric: tabular-nums; font-feature-settings: "tnum";`,
	});

	const minutesLabel = digitLabel('00');
	const secondsLabel = digitLabel('00');
	const centisecondsLabel = digitLabel('00');

	// The bin centers the glyph block inside its fixed zone — the label's
	// own line-box height (font-dependent) can never pin digits to the top.
	const digitBin = (label) => new St.Bin({
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		child: label,
	});

	const minutesBin = digitBin(minutesLabel);
	const secondsBin = digitBin(secondsLabel);
	const centisecondsBin = digitBin(centisecondsLabel);
	for (const bin of [minutesBin, secondsBin, centisecondsBin]) {
		bin.set_size(digitSlot, digitZone);
	};

	// Two-dot colon separators drawn in canvas, in the reference digital
	// clock's style: fat round dots instead of the thin font glyph. The dot
	// stack shares the digits' ink midline, probed from the same font the
	// shell paints with — level with the number row at any font or scale.
	// Ink midline of the digits AS LAID OUT, in the colon area's own
	// coordinates. Everything is summed from allocations relative to the
	// shared parent row (column → bin → label → text → glyph ink), never
	// from stage transforms, so hover/edit animations cannot skew it.
	const liveDigitMidline = (area) => {
		try {
			const text = minutesLabel.clutter_text;
			const [ink] = text.get_layout().get_pixel_extents();
			if (!(ink.height > 0) || !minutesColumn.has_allocation() || !area.has_allocation())
				return null;
			const y = minutesColumn.get_allocation_box().y1
				+ minutesBin.get_allocation_box().y1
				+ minutesLabel.get_allocation_box().y1
				+ text.get_allocation_box().y1
				+ ink.y + ink.height / 2
				- area.get_allocation_box().y1;
			return Number.isFinite(y) ? y : null;
		} catch (_e) {
			return null;
		}
	};

	const buildColon = () => {
		const area = new St.DrawingArea();
		area.connect('repaint', (canvas) => {
			const ctx = canvas.get_context();
			const rgb = parseCssColor(textColor) ?? {r: 1, g: 1, b: 1, a: 1};
			ctx.setSourceRGBA(rgb.r, rgb.g, rgb.b, 1);
			const cx = Math.round(colonSlot / 2);
			// Fallback (not laid out yet): probed metrics, line centered
			// in the zone.
			const cy = Math.round(liveDigitMidline(canvas)
				?? ((digitZone - digitLine.logicalH) / 2 + digitLine.inkCenterY));
			const r = Math.max(1, Math.round(digitFontPx * 6 / 64));
			const dy = Math.max(2, Math.round(digitFontPx * 9 / 64));
			for (const offset of [-dy, dy]) {
				ctx.arc(cx, cy + offset, r, 0, 2 * Math.PI);
				ctx.fill();
			};
			ctx.$dispose();
		});
		area.set_size(colonSlot, digitZone);
		area.style = `margin-left: ${colonGap}px; margin-right: ${colonGap}px;`;
		// Re-center whenever the digits move (layout, font, scale).
		minutesLabel.connectObject('notify::allocation', () => area.queue_repaint(), area);
		minutesColumn.connectObject('notify::allocation', () => area.queue_repaint(), area);
		return area;
	};

	// ── Column grouping: digit pair + label in one sub-container ─────────
	// The caption sits in a fixed slot exactly as wide as the digit slot,
	// centered on both axes by the bin's alignment (the same container
	// mechanism the digit bins use). The column owns both, so the label can
	// only ever center under its own digit pair — the colons between the
	// columns cannot shift or influence the label position.
	const captionCell = (text) => {
		const label = new St.Label({
			text,
			style: `color: ${mutedColor}; font-family: Ubuntu; font-size: ${captionFontPx}px; font-weight: 700;`,
		});
		const cell = new St.Bin({
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
			child: label,
		});
		cell.set_size(digitSlot, captionZone);
		return cell;
	};

	const buildColumn = (digitBin_, captionText_) => {
		const column = new St.BoxLayout({
			orientation: Clutter.Orientation.VERTICAL,
			// In-column gap: keeps the label strip a fixed fraction under
			// the digits (no dependence on row-level spacing).
			style: `spacing: ${px(10)}px;`,
		});
		column.add_child(digitBin_);
		column.add_child(captionCell(captionText_));
		return column;
	};

	const minutesColumn = buildColumn(minutesBin, _('Minutes'));
	const secondsColumn = buildColumn(secondsBin, _('Seconds'));
	const centisecondsColumn = buildColumn(centisecondsBin, _('Centiseconds'));

	const digitRow = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		x_expand: true,
	});
	digitRow.add_child(minutesColumn);
	digitRow.add_child(buildColon());
	digitRow.add_child(secondsColumn);
	digitRow.add_child(buildColon());
	digitRow.add_child(centisecondsColumn);
	// Equal expanding fillers pin the whole cluster to the card's vertical
	// center: the spare height splits in half above and below it, so the
	// top and bottom padding look symmetrical (no dead band at either end).
	mainBox.add_child(new St.Widget({y_expand: true}));
	mainBox.add_child(digitRow);

	// ── Layer 3: the control row, tucked under the caption strip ─────────
	// The old expanding spacer pinned the buttons to the card's very bottom
	// and left a dead band under the labels; a fixed margin keeps the whole
	// stack tightly grouped from the top instead.
	const buttonsBox = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(12)}px; margin-top: ${px(9)}px;`,
	});

	const pauseBtn = new St.Button({
		reactive: true,
		can_focus: true,
		x_expand: false,
		child: new St.Label({
			text: _('Start'),
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
		}),
		style: `font-size: ${px(19)}px; padding: ${px(12)}px ${px(32)}px; border-radius: ${px(12)}px; background-color: ${accentHex}; color: ${accentTextColor}; font-weight: 600;`,
	});

	const resetBtn = new St.Button({
		reactive: true,
		can_focus: true,
		x_expand: false,
		child: new St.Label({
			text: _('Reset'),
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
		}),
		style: `font-size: ${px(19)}px; padding: ${px(12)}px ${px(32)}px; border-radius: ${px(12)}px; background-color: transparent; border: 1px solid ${ghostBorderColor(theme)}; color: ${textColor}; font-weight: 600;`,
	});

	bindHoverShrink(pauseBtn);
	bindHoverShrink(resetBtn);
	// Bottom filler: mirrors the top filler, so the spare height splits
	// evenly and the content reads centered inside the card.
	buttonsBox.add_child(pauseBtn);
	buttonsBox.add_child(resetBtn);
	mainBox.add_child(buttonsBox);
	mainBox.add_child(new St.Widget({y_expand: true}));

	const updateDisplay = () => {
		const time = formatTime(centiseconds);
		setTextIfChanged(minutesLabel, time.minutes);
		setTextIfChanged(secondsLabel, time.seconds);
		setTextIfChanged(centisecondsLabel, time.centiseconds);
	};

	const startTimer = () => {
		if (isRunning) return;
		isRunning = true;
		runBaseCs = centiseconds;
		runAnchorMono = GLib.get_monotonic_time();
		timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MEDIUM_MS, () => {
			centiseconds = Math.floor(runBaseCs + (GLib.get_monotonic_time() - runAnchorMono) / 10000);
			updateDisplay();
			// Keep the wall stamp fresh (≤ ~1s stale) for surprise teardowns.
			if (++tickCount % Math.round(PERSIST_EVERY_MS / TICK_MEDIUM_MS) === 0) {
				state.persist();
			}
			return GLib.SOURCE_CONTINUE;
		});
		state.persist();
		pauseBtn.child.text = _('Pause');
		pauseBtn.style = `font-size: ${px(19)}px; padding: ${px(12)}px ${px(32)}px; border-radius: ${px(12)}px; background-color: ${accentHex}; color: ${accentTextColor}; font-weight: 600;`;
	};

	const stopTimer = () => {
		if (!isRunning) return;
		isRunning = false;
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
		state.persist();
		pauseBtn.child.text = _('Start');
		pauseBtn.style = `font-size: ${px(19)}px; padding: ${px(12)}px ${px(32)}px; border-radius: ${px(12)}px; background-color: ${accentHex}; color: ${accentTextColor}; font-weight: 600;`;
	};

	const resetTimer = () => {
		stopTimer();
		centiseconds = 0;
		updateDisplay();
		state.persist();
	};

	pauseBtn.connect('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1) {
			return Clutter.EVENT_PROPAGATE;
		}
		bounceButton(pauseBtn);
		if (isRunning) {
			stopTimer();
		} else {
			startTimer();
		}
		return Clutter.EVENT_STOP;
	});

	resetBtn.connect('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1) {
			return Clutter.EVENT_PROPAGATE;
		}
		bounceButton(resetBtn);
		resetTimer();
		return Clutter.EVENT_STOP;
	});

	body.connect('destroy', () => {
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
		// Exact snapshot for in-process rebuilds and logout marathons.
		state.flush();
	});

	updateDisplay();
}

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border};`;
}

export function render({body, theme, sizeForWidget, widget}) {
	const sizeKey = widget?.size ?? 'medium';

	if (sizeKey === 'small') {
		renderSmallTimer({body, theme, sizeForWidget, widget});
	} else {
		renderMediumTimer({body, theme, sizeForWidget, widget});
	}
}
