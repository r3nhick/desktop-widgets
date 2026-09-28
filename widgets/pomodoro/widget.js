import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { parseCssColor } from '../../utils/ported.js';

export const type = 'pomodoro';
export const label = 'Pomodoro';
export const defaultSize = 'small';
export const supportedSizes = ['small', 'medium'];

const POMODORO_DEFAULTS = Object.freeze({
	WORK_MINUTES: 25,
	SHORT_BREAK_MINUTES: 5,
	LONG_BREAK_MINUTES: 15,
	SESSIONS_BEFORE_LONG_BREAK: 4,
});

const POMODORO_TICK_INTERVAL_MS = 1000;
const SECONDS_PER_MINUTE = 60;

const PHASE_WORK = 'work';
const PHASE_SHORT_BREAK = 'short_break';
const PHASE_LONG_BREAK = 'long_break';

const PHASE_CONFIG = Object.freeze({
	[PHASE_WORK]: {
		labelKey: 'focus',
		minutesField: 'pomodoro-work-minutes',
		defaultMinutes: POMODORO_DEFAULTS.WORK_MINUTES,
	},
	[PHASE_SHORT_BREAK]: {
		labelKey: 'break',
		minutesField: 'pomodoro-short-break-minutes',
		defaultMinutes: POMODORO_DEFAULTS.SHORT_BREAK_MINUTES,
	},
	[PHASE_LONG_BREAK]: {
		labelKey: 'long_break',
		minutesField: 'pomodoro-long-break-minutes',
		defaultMinutes: POMODORO_DEFAULTS.LONG_BREAK_MINUTES,
	},
});

function getPhaseLabel(phase) {
	const labels = {
		focus: _('Focus'),
		break: _('Break'),
		long_break: _('Long Break'),
	};
	return labels[PHASE_CONFIG[phase].labelKey] || phase;
}

function getPhaseDurationSeconds(settings, phase) {
	const phaseEntry = PHASE_CONFIG[phase];
	const minutes = settings?.get_int(phaseEntry.minutesField) ?? phaseEntry.defaultMinutes;

	return Math.max(1, Math.round(minutes * SECONDS_PER_MINUTE));
};

function getSessionsBeforeLongBreak(settings) {
	const value = settings?.get_int('pomodoro-sessions-before-long-break') ?? POMODORO_DEFAULTS.SESSIONS_BEFORE_LONG_BREAK;

	return Math.max(1, Math.round(value));
};

function formatSeconds(totalSeconds) {
	const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
	const seconds = totalSeconds % SECONDS_PER_MINUTE;

	return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

function createPomodoroTimer(settings, onChange) {
	const state = {
		phase: PHASE_WORK,
		secondsRemaining: getPhaseDurationSeconds(settings, PHASE_WORK),
		isRunning: false,
		completedSessions: 0,
		timerId: null,
	};

	const stopTimer = () => {
		if (state.timerId) {
			GLib.Source.remove(state.timerId);
			state.timerId = null;
		};
		state.isRunning = false;
	};

	const advanceToNextPhase = () => {
		if (state.phase === PHASE_WORK) {
			state.completedSessions++;
			if (state.completedSessions >= getSessionsBeforeLongBreak(settings)) {
				state.phase = PHASE_LONG_BREAK;
				state.completedSessions = 0;
			} else {
				state.phase = PHASE_SHORT_BREAK;
			};
		} else {
			state.phase = PHASE_WORK;
		};
		state.secondsRemaining = getPhaseDurationSeconds(settings, state.phase);
		onChange();
	};

	const startTimer = () => {
		if (state.isRunning || state.secondsRemaining <= 0) {
			return;
		};
		state.isRunning = true;
		state.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POMODORO_TICK_INTERVAL_MS, () => {
			state.secondsRemaining--;
			if (state.secondsRemaining <= 0) {
				stopTimer();
				advanceToNextPhase();
				return GLib.SOURCE_REMOVE;
			};
			onChange();
			return GLib.SOURCE_CONTINUE;
		});
	};

	const resetCurrentPhase = () => {
		stopTimer();
		state.secondsRemaining = getPhaseDurationSeconds(settings, state.phase);
		onChange();
	};

	const switchToPhase = (phase) => {
		stopTimer();
		state.phase = phase;
		state.secondsRemaining = getPhaseDurationSeconds(settings, state.phase);
		onChange();
	};

	return {state, startTimer, stopTimer, resetCurrentPhase, advanceToNextPhase, switchToPhase};
};

// Accent can arrive as hex (#f5c211) or as a css rgb() string, depending on
// whether it comes from the GNOME interface schema or from the widget's own
// "custom accent color" setting. parseCssColor understands both.
function accentColor(theme) {
	const accent = String(theme?.accent ?? '').trim();

	return accent || '#3584e4';
}

// Draws the progress ring: a faint full-circle track plus the accent arc on
// top of it, so the widget reads as a gauge even at progress 0. The ring is
// inset from the cell so it never touches the widget frame.
// Only shows the ring when the timer is running.
function drawCircularArc(ctx, width, height, progress, accent, track, isRunning) {
	ctx.setOperator(0);
	ctx.paint();
	ctx.setOperator(2);

	if (!isRunning) {
		return;
	};

	const centerX = width / 2;
	const centerY = height / 2;
	const radius = Math.min(width, height) / 2;
	// Збільшено товщину лінії кола до 0.10 (ще ширше)
	const lineWidth = Math.max(2, Math.round(radius * 0.10));
	const startAngle = -Math.PI / 2;
	const endAngle = startAngle + Math.min(Math.max(progress, 0), 1) * Math.PI * 2;

	ctx.setLineWidth(lineWidth);
	ctx.setLineCap(1);

	const trackColor = parseCssColor(track || '#c0bfbc');

	ctx.setSourceRGBA(trackColor.r, trackColor.g, trackColor.b, 0.25);
	ctx.arc(centerX, centerY, radius - lineWidth / 2, 0, Math.PI * 2);
	ctx.stroke();

	if (progress <= 0) {
		return;
	};

	const { r, g, b } = parseCssColor(accent);

	ctx.setSourceRGBA(r, g, b, 1.0);
	ctx.arc(centerX, centerY, radius - lineWidth / 2, startAngle, endAngle);
	ctx.stroke();
};

function textOnAccentColor(accent) {
	const { r, g, b } = parseCssColor(accent);
	const lum = 0.299 * r + 0.587 * g + 0.114 * b;

	return lum > 0.55 ? 'rgba(30,30,30,0.92)' : 'rgba(255,255,255,0.92)';
};

function renderSmallTimer({body, theme, sizeForWidget, widget, settings}) {
	const textColor = theme.text;
	const mutedColor = theme.muted;
	const accentHex = accentColor(theme);
	const [totalWidth, totalHeight] = sizeForWidget(widget);
	const width = totalWidth - 34;
	const height = totalHeight - 34;
	const scale = Math.min(width, height) / 180;

	const phaseFontSize = Math.max(12, Math.round(14 * scale));
	const timerFontSize = Math.max(21, Math.round(33 * scale));
	const dotSize = Math.max(6, Math.round(8 * scale));
	const playIconSize = Math.max(24, Math.round(32 * scale));
	const secIconSize = Math.max(22, Math.round(28 * scale));

	const timer = createPomodoroTimer(settings, () => updateDisplay());
	const {state} = timer;

	// Both layers live in a BinLayout and both must expand: BinLayout gives a
	// non-expanding child only its *current* width (0 before the first
	// allocation), which renders as a blank widget. The ring is the first
	// child so the label stack paints on top of it.
	const container = new St.Widget({
		layout_manager: new Clutter.BinLayout(),
		x_expand: true,
		y_expand: true,
	});

	body.add_child(container);

	const canvasActor = new St.DrawingArea({
		x_expand: true,
		y_expand: true,
	});

	canvasActor.connect('repaint', (area) => {
		const ctx = area.get_context();
		const [canvasWidth, canvasHeight] = area.get_surface_size();
		const phaseDurationSeconds = getPhaseDurationSeconds(settings, state.phase);
		const progress = phaseDurationSeconds > 0 ? (1 - (state.secondsRemaining / phaseDurationSeconds)) : 0;

		drawCircularArc(ctx, canvasWidth, canvasHeight, progress, accentHex, mutedColor, state.isRunning);
		ctx.$dispose();
	});

	container.add_child(canvasActor);

	// Vertical stack with an expanding spacer above and below, so the timer
	// reads as one centered block without relying on the box's own height.
	const stack = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
	});

	stack.add_child(new St.Widget({y_expand: true}));

	const phaseLabel = new St.Label({
		text: getPhaseLabel(PHASE_WORK),
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${phaseFontSize}px; font-weight: 800;`,
	});

	const timerLabel = new St.Label({
		text: formatSeconds(getPhaseDurationSeconds(settings, PHASE_WORK)),
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${timerFontSize}px; font-weight: 800; margin-top: ${Math.round(2 * scale)}px;`,
	});

	const sessionDotsBox = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		style: `margin-top: ${Math.round(8 * scale)}px; spacing: ${Math.round(4 * scale)}px;`,
	});

	for (let i = 0; i < getSessionsBeforeLongBreak(settings); i++) {
		const dot = new St.Widget({
			style: `background-color: ${mutedColor}; width: ${dotSize}px; height: ${dotSize}px; border-radius: ${Math.round(dotSize / 2)}px;`,
		});

		sessionDotsBox.add_child(dot);
	};

	const controlsRow = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		style: `margin-top: ${Math.round(10 * scale)}px; spacing: ${Math.round(6 * scale)}px;`,
	});

	const playPauseBtn = new St.Button({reactive: true, can_focus: true, style: 'padding: 6px;'});
	const playPauseIcon = new St.Icon({icon_name: 'media-playback-start-symbolic', icon_size: playIconSize, style: `color: ${textColor};`});

	playPauseBtn.set_child(playPauseIcon);

	const resetBtn = new St.Button({reactive: true, can_focus: true, style: 'padding: 6px;'});
	const resetIcon = new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: secIconSize, style: `color: ${mutedColor};`});

	resetBtn.set_child(resetIcon);

	const skipBtn = new St.Button({reactive: true, can_focus: true, style: 'padding: 6px;'});
	const skipIcon = new St.Icon({icon_name: 'media-skip-forward-symbolic', icon_size: secIconSize, style: `color: ${mutedColor};`});

	skipBtn.set_child(skipIcon);

	controlsRow.add_child(resetBtn);
	controlsRow.add_child(playPauseBtn);
	controlsRow.add_child(skipBtn);

	stack.add_child(phaseLabel);
	stack.add_child(timerLabel);
	stack.add_child(sessionDotsBox);
	stack.add_child(controlsRow);
	stack.add_child(new St.Widget({y_expand: true}));
	container.add_child(stack);

	const updateSessionDots = () => {
		let dotIndex = 0;
		let child = sessionDotsBox.get_first_child();

		while (child) {
			const isCompleted = dotIndex < state.completedSessions;
			const color = isCompleted ? accentHex : mutedColor;

			child.style = `background-color: ${color}; width: ${dotSize}px; height: ${dotSize}px; border-radius: ${Math.round(dotSize / 2)}px;`;
			child = child.get_next_sibling();
			dotIndex++;
		};
	};

	const updateDisplay = () => {
		const activeConfig = PHASE_CONFIG[state.phase];

		timerLabel.set_text(formatSeconds(state.secondsRemaining));
		phaseLabel.set_text(getPhaseLabel(state.phase));
		canvasActor.queue_repaint();
		updateSessionDots();
	};

	const syncPlayPauseIcon = () => {
		playPauseIcon.set_icon_name(timer.state.isRunning
			? 'media-playback-pause-symbolic'
			: 'media-playback-start-symbolic');
	};

	playPauseBtn.connect('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1) {
			return Clutter.EVENT_PROPAGATE;
		};
		if (state.isRunning) {
			timer.stopTimer();
		} else {
			timer.startTimer();
		};
		syncPlayPauseIcon();
		return Clutter.EVENT_STOP;
	});

	resetBtn.connect('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1) {
			return Clutter.EVENT_PROPAGATE;
		};
		timer.resetCurrentPhase();
		syncPlayPauseIcon();
		return Clutter.EVENT_STOP;
	});

	skipBtn.connect('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1) {
			return Clutter.EVENT_PROPAGATE;
		};
		timer.advanceToNextPhase();
		syncPlayPauseIcon();
		return Clutter.EVENT_STOP;
	});

	body.connect('destroy', () => {
		if (state.timerId) {
			GLib.Source.remove(state.timerId);
			state.timerId = null;
		};
	});

	updateDisplay();
};

function renderMediumFocus({body, theme, sizeForWidget, widget, settings}) {
	const textColor = theme.text;
	const mutedColor = theme.muted;
	const accentHex = accentColor(theme);
	const accentTextColor = textOnAccentColor(accentHex);
	const [width, height] = sizeForWidget(widget);
	const contentW = width - 34;
	const contentH = height - 34;
	const scale = Math.min(contentW / 360, contentH / 146);
	const px = (v) => Math.max(1, Math.round(v * scale));

	const timer = createPomodoroTimer(settings, () => {
		updateDisplay();
		refreshControlStyles();
	});
	const state = timer.state;

	const mainBox = new St.BoxLayout({
		orientation: Clutter.Orientation.HORIZONTAL,
		x_expand: true,
		y_expand: true,
		style: `spacing: ${px(16)}px;`,
	});

	body.add_child(mainBox);

	const gaugeWrap = new St.Widget({
		layout_manager: new Clutter.BinLayout(),
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
	});

	const gaugeSize = Math.min(contentH, px(130));

	gaugeWrap.set_size(gaugeSize, gaugeSize);

	const canvasActor = new St.DrawingArea();

	canvasActor.set_size(gaugeSize, gaugeSize);
	canvasActor.connect('repaint', (area) => {
		const ctx = area.get_context();
		const [canvasWidth] = area.get_surface_size();
		const phaseDurationSeconds = getPhaseDurationSeconds(settings, state.phase);
		const progress = phaseDurationSeconds > 0 ? (1 - (state.secondsRemaining / phaseDurationSeconds)) : 0;

		drawCircularArc(ctx, canvasWidth, canvasWidth, progress, accentHex, mutedColor, state.isRunning);
		ctx.$dispose();
	});

	const gaugeOverlay = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
	});

	const timerLabel = new St.Label({
		text: formatSeconds(state.secondsRemaining),
	});

	const phaseCaption = new St.Label({
		text: getPhaseLabel(state.phase),
	});

	// Поміняли місцями: спочатку фаза (Focus), потім час
	gaugeOverlay.add_child(phaseCaption);
	gaugeOverlay.add_child(timerLabel);
	gaugeWrap.add_child(canvasActor);
	gaugeWrap.add_child(gaugeOverlay);
	mainBox.add_child(gaugeWrap);

	const controlsColumn = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
	});

	mainBox.add_child(controlsColumn);

	const modeSelector = new St.BoxLayout({
		x_align: Clutter.ActorAlign.FILL,
	});

	const buildModeButton = (phase) => {
		const button = new St.Button({
			reactive: true,
			can_focus: true,
			x_expand: true,
			child: new St.Label({
				text: getPhaseLabel(phase),
				x_align: Clutter.ActorAlign.CENTER,
				y_align: Clutter.ActorAlign.CENTER,
			}),
		});

		button.connect('button-press-event', (_actor, event) => {
			if (event.get_button() !== 1) {
				return Clutter.EVENT_PROPAGATE;
			};
			timer.switchToPhase(phase);
			return Clutter.EVENT_STOP;
		});

		modeSelector.add_child(button);
		return button;
	};

	const workBtn = buildModeButton(PHASE_WORK);
	const breakBtn = buildModeButton(PHASE_SHORT_BREAK);

	controlsColumn.add_child(modeSelector);

	const counterRow = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		style: `margin-top: ${px(10)}px;`,
	});

	const counterPrefixLabel = new St.Label({text: _('Completed:')});
	const counterValueLabel = new St.Label({text: '0'});
	const counterTotalLabel = new St.Label({text: `/ ${getSessionsBeforeLongBreak(settings)}`});

	counterRow.add_child(counterPrefixLabel);
	counterRow.add_child(counterValueLabel);
	counterRow.add_child(counterTotalLabel);
	controlsColumn.add_child(counterRow);

	const counterSpacer = new St.Widget({x_expand: true, y_expand: true});

	controlsColumn.add_child(counterSpacer);

	const actionButtons = new St.BoxLayout({
		x_align: Clutter.ActorAlign.FILL,
		style: `spacing: ${px(8)}px;`,
	});

	const startBtn = new St.Button({
		reactive: true,
		can_focus: true,
		x_expand: true,
		child: new St.Label({
			text: _('Start'),
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
		}),
	});

	const resetBtn = new St.Button({
		reactive: true,
		can_focus: true,
		x_expand: true,
		child: new St.Label({
			text: _('Reset'),
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
		}),
	});

	actionButtons.add_child(startBtn);
	actionButtons.add_child(resetBtn);
	controlsColumn.add_child(actionButtons);

	const updateDisplay = () => {
		timerLabel.set_text(formatSeconds(state.secondsRemaining));
		phaseCaption.set_text(getPhaseLabel(state.phase));
		counterValueLabel.set_text(String(state.completedSessions));
		counterTotalLabel.set_text(`/ ${getSessionsBeforeLongBreak(settings)}`);
		canvasActor.queue_repaint();
	};

	const refreshControlStyles = () => {
		const isWork = state.phase === PHASE_WORK;

		modeSelector.style = `background-color: rgba(255, 255, 255, 0.06); padding: ${px(3)}px; border-radius: ${px(10)}px;`;

		const modeButtonStyle = (isActive) => {
			const bg = isActive ? `background-color: rgba(255, 255, 255, 0.12);` : '';
			const color = isActive ? textColor : mutedColor;

			return `${bg} font-size: ${px(12)}px; padding: ${px(6)}px 0; border-radius: ${px(7)}px; color: ${color}; font-weight: 600;`;
		};

		workBtn.style = modeButtonStyle(isWork);
		breakBtn.style = modeButtonStyle(!isWork);

		counterPrefixLabel.style = `font-size: ${px(12)}px; color: ${mutedColor}; margin-right: ${px(4)}px; font-weight: 600;`;
		counterValueLabel.style = `font-size: ${px(12)}px; color: ${textColor}; margin-right: ${px(2)}px; font-weight: 600;`;
		counterTotalLabel.style = `font-size: ${px(12)}px; color: ${mutedColor}; font-weight: 600;`;

		startBtn.style = `font-size: ${px(13)}px; padding: ${px(10)}px 0; border-radius: ${px(10)}px; background-color: ${accentHex}; color: ${accentTextColor}; font-weight: 600;`;
		resetBtn.style = `font-size: ${px(13)}px; padding: ${px(10)}px 0; border-radius: ${px(10)}px; background-color: transparent; border: 1px solid rgba(255, 255, 255, 0.2); color: ${textColor}; font-weight: 600;`;

		timerLabel.style = `font-size: ${px(29)}px; font-weight: 600; color: ${textColor};`;
		phaseCaption.style = `font-size: ${px(11)}px; color: ${mutedColor}; font-weight: 600; margin-top: ${px(2)}px;`;

		startBtn.child.text = state.isRunning ? _('Pause') : _('Start');
	};

	startBtn.connect('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1) {
			return Clutter.EVENT_PROPAGATE;
		};
		if (state.isRunning) {
			timer.stopTimer();
		} else {
			timer.startTimer();
		};
		updateDisplay();
		refreshControlStyles();
		return Clutter.EVENT_STOP;
	});

	resetBtn.connect('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1) {
			return Clutter.EVENT_PROPAGATE;
		};
		timer.resetCurrentPhase();
		updateDisplay();
		refreshControlStyles();
		return Clutter.EVENT_STOP;
	});

	body.connect('destroy', () => {
		if (state.timerId) {
			GLib.Source.remove(state.timerId);
			state.timerId = null;
		};
	});

	updateDisplay();
	refreshControlStyles();
};

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border};`;
};

export function render({body, theme, sizeForWidget, widget, settings}) {
	const sizeKey = widget?.size ?? 'small';

	if (sizeKey === 'medium') {
		renderMediumFocus({body, theme, sizeForWidget, widget, settings});
	} else {
		renderSmallTimer({body, theme, sizeForWidget, widget, settings});
	};
};
