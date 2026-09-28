/*
 * Timer widget (Countdown Timer)
 * Modern circular progress timer with increment/decrement controls
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { parseCssColor } from '../../utils/ported.js';

export const type = 'timer';
export const label = 'Timer';
export const defaultSize = 'small';
export const supportedSizes = ['small', 'medium'];

const TICK_INTERVAL_MS = 100;

function formatTime(seconds) {
	const mins = Math.floor(seconds / 60);
	const secs = Math.floor(seconds % 60);
	return {
		minutes: mins.toString().padStart(2, '0'),
		seconds: secs.toString().padStart(2, '0'),
	};
}

function accentColor(theme) {
	const accent = String(theme?.accent ?? '').trim();
	return accent || '#3584e4';
}

function textOnAccentColor(accent) {
	const { r, g, b } = parseCssColor(accent);
	const lum = 0.299 * r + 0.587 * g + 0.114 * b;
	return lum > 0.55 ? 'rgba(30,30,30,0.92)' : 'rgba(255,255,255,0.92)';
}

// Small timer (1x1) - circular progress with controls
function renderSmallTimer({body, theme, sizeForWidget, widget}) {
	const textColor = theme.text;
	const accentHex = accentColor(theme);
	const accentTextColor = textOnAccentColor(accentHex);
	const [totalWidth, totalHeight] = sizeForWidget(widget);
	const width = totalWidth - 34;
	const height = totalHeight - 34;
	const scale = Math.min(width / 180, height / 180);
	const px = (v) => Math.max(1, Math.round(v * scale));

	let totalSeconds = 0;
	let remainingSeconds = 0;
	let isRunning = false;
	let timerId = null;

	const mainBox = new St.Widget({
		x_expand: true,
		y_expand: true,
		layout_manager: new Clutter.BinLayout(),
	});
	body.add_child(mainBox);

	// Circular progress in center
	const circleSize = px(120);
	const circleCanvas = new St.DrawingArea({
		width: circleSize,
		height: circleSize,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
	});
	mainBox.add_child(circleCanvas);

	// Time label in center
	const timeLabel = new St.Label({
		text: '00:00',
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(32)}px; font-weight: 700;`,
	});
	mainBox.add_child(timeLabel);

	// Play button (bottom-left)
	const playBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'media-playback-start-symbolic',
			icon_size: px(18),
			style: `color: ${accentTextColor};`,
		}),
		style: `padding: ${px(12)}px; border-radius: 999px; background-color: ${accentHex};`,
		x_align: Clutter.ActorAlign.START,
		y_align: Clutter.ActorAlign.END,
	});
	mainBox.add_child(playBtn);

	// Stop button (bottom-right)
	const stopBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'media-playback-stop-symbolic',
			icon_size: px(16),
			style: `color: ${textColor};`,
		}),
		style: `padding: ${px(10)}px; border-radius: 999px; background-color: rgba(255, 255, 255, 0.15); border: ${px(2)}px solid rgba(255, 255, 255, 0.3);`,
		x_align: Clutter.ActorAlign.END,
		y_align: Clutter.ActorAlign.END,
	});
	mainBox.add_child(stopBtn);

	let progress = 0;

	circleCanvas.connect('repaint', (canvas) => {
		const ctx = canvas.get_context();
		const [w, h] = canvas.get_surface_size();
		const centerX = w / 2;
		const centerY = h / 2;
		const radius = Math.min(w, h) / 2 - px(8);
		const lineWidth = px(8);

		// Background circle (light)
		ctx.setSourceRGBA(0.5, 0.5, 0.5, 0.2);
		ctx.setLineWidth(lineWidth);
		ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
		ctx.stroke();

		// Progress arc
		if (progress > 0) {
			const accentRgb = parseCssColor(accentHex);
			ctx.setSourceRGBA(accentRgb.r, accentRgb.g, accentRgb.b, 1.0);
			ctx.setLineWidth(lineWidth);
			ctx.setLineCap(1); // ROUND
			const startAngle = -Math.PI / 2;
			const endAngle = startAngle + (2 * Math.PI * progress);
			ctx.arc(centerX, centerY, radius, startAngle, endAngle);
			ctx.stroke();
		}

		ctx.$dispose();
	});

	const updateDisplay = () => {
		const time = formatTime(remainingSeconds);
		timeLabel.set_text(`${time.minutes}:${time.seconds}`);
		
		if (totalSeconds > 0) {
			progress = Math.max(0, Math.min(1, remainingSeconds / totalSeconds));
		} else {
			progress = 0;
		}
		
		circleCanvas.queue_repaint();

		playBtn.child.icon_name = isRunning 
			? 'media-playback-pause-symbolic' 
			: 'media-playback-start-symbolic';
	};

	const setTimer = (seconds) => {
		stopTimer();
		totalSeconds = seconds;
		remainingSeconds = seconds;
		updateDisplay();
	};

	const startTimer = () => {
		if (isRunning || remainingSeconds <= 0) return;
		isRunning = true;
		const startTime = GLib.get_monotonic_time() / 1000;
		const targetEndTime = startTime + (remainingSeconds * 1000);
		timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_INTERVAL_MS, () => {
			const now = GLib.get_monotonic_time() / 1000;
			remainingSeconds = Math.max(0, (targetEndTime - now) / 1000);
			updateDisplay();
			if (remainingSeconds <= 0) {
				stopTimer();
				Main.notify(_('Timer'), _('Timer finished!'));
				return GLib.SOURCE_REMOVE;
			}
			return GLib.SOURCE_CONTINUE;
		});
		updateDisplay();
	};

	const pauseTimer = () => {
		if (!isRunning) return;
		isRunning = false;
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
		updateDisplay();
	};

	const stopTimer = () => {
		pauseTimer();
		remainingSeconds = 0;
		totalSeconds = 0;
		updateDisplay();
	};

	playBtn.connect('clicked', () => {
		if (remainingSeconds === 0) {
			// Start new 3 minute timer
			setTimer(3 * 60);
			startTimer();
		} else if (isRunning) {
			pauseTimer();
		} else {
			startTimer();
		}
	});

	stopBtn.connect('clicked', () => stopTimer());

	body.connect('destroy', () => {
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
	});

	updateDisplay();
}

// Medium timer (2x1) - large display with increment/decrement
function renderMediumTimer({body, theme, sizeForWidget, widget}) {
	const textColor = theme.text;
	const mutedColor = theme.muted;
	const accentHex = accentColor(theme);
	const accentTextColor = textOnAccentColor(accentHex);
	const [width, height] = sizeForWidget(widget);
	const contentW = width - 34;
	const contentH = height - 34;
	const scale = Math.min(contentW / 540, contentH / 200);
	const px = (v) => Math.max(1, Math.round(v * scale));

	let totalSeconds = 0;
	let remainingSeconds = 0;
	let isRunning = false;
	let timerId = null;

	const mainBox = new St.BoxLayout({
		orientation: Clutter.Orientation.HORIZONTAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(32)}px; padding: ${px(16)}px;`,
	});
	body.add_child(mainBox);

	// Left: circular progress
	const leftBox = new St.Widget({
		width: px(140),
		height: px(140),
		layout_manager: new Clutter.BinLayout(),
	});
	mainBox.add_child(leftBox);

	const circleSize = px(140);
	const circleCanvas = new St.DrawingArea({
		width: circleSize,
		height: circleSize,
	});
	leftBox.add_child(circleCanvas);

	const circleTimeLabel = new St.Label({
		text: '00:00',
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(28)}px; font-weight: 700;`,
	});
	leftBox.add_child(circleTimeLabel);

	// Center: big time with +/- controls
	const centerBox = new St.BoxLayout({
		orientation: Clutter.Orientation.HORIZONTAL,
		x_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(8)}px;`,
	});
	mainBox.add_child(centerBox);

	// Minutes with controls
	const minutesBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(8)}px;`,
	});

	const minutesPlusBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '+' }),
		style: `font-size: ${px(20)}px; width: ${px(40)}px; height: ${px(40)}px; color: ${textColor}; background-color: rgba(255, 255, 255, 0.1); border-radius: ${px(8)}px; font-weight: 700;`,
	});
	minutesBox.add_child(minutesPlusBtn);

	const minutesLabel = new St.Label({
		text: '00',
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(72)}px; font-weight: 700; line-height: 0.9;`,
	});
	minutesBox.add_child(minutesLabel);

	const minutesMinusBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '−' }),
		style: `font-size: ${px(20)}px; width: ${px(40)}px; height: ${px(40)}px; color: ${textColor}; background-color: rgba(255, 255, 255, 0.1); border-radius: ${px(8)}px; font-weight: 700;`,
	});
	minutesBox.add_child(minutesMinusBtn);

	centerBox.add_child(minutesBox);

	// Colon
	const colonLabel = new St.Label({
		text: ':',
		y_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(72)}px; font-weight: 700;`,
	});
	centerBox.add_child(colonLabel);

	// Seconds with controls
	const secondsBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(8)}px;`,
	});

	const secondsPlusBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '+' }),
		style: `font-size: ${px(20)}px; width: ${px(40)}px; height: ${px(40)}px; color: ${textColor}; background-color: rgba(255, 255, 255, 0.1); border-radius: ${px(8)}px; font-weight: 700;`,
	});
	secondsBox.add_child(secondsPlusBtn);

	const secondsLabel = new St.Label({
		text: '00',
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(72)}px; font-weight: 700; line-height: 0.9;`,
	});
	secondsBox.add_child(secondsLabel);

	const secondsMinusBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '−' }),
		style: `font-size: ${px(20)}px; width: ${px(40)}px; height: ${px(40)}px; color: ${textColor}; background-color: rgba(255, 255, 255, 0.1); border-radius: ${px(8)}px; font-weight: 700;`,
	});
	secondsBox.add_child(secondsMinusBtn);

	centerBox.add_child(secondsBox);

	// Right: Play and Stop buttons
	const rightBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.END,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(12)}px;`,
	});

	const playBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'media-playback-start-symbolic',
			icon_size: px(24),
			style: `color: ${accentTextColor};`,
		}),
		style: `padding: ${px(16)}px; border-radius: 999px; background-color: ${accentHex};`,
	});
	rightBox.add_child(playBtn);

	const stopBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'media-playback-stop-symbolic',
			icon_size: px(20),
			style: `color: ${textColor};`,
		}),
		style: `padding: ${px(14)}px; border-radius: 999px; background-color: rgba(255, 255, 255, 0.15); border: ${px(2)}px solid rgba(255, 255, 255, 0.3);`,
	});
	rightBox.add_child(stopBtn);

	mainBox.add_child(rightBox);

	let progress = 0;

	circleCanvas.connect('repaint', (canvas) => {
		const ctx = canvas.get_context();
		const [w, h] = canvas.get_surface_size();
		const centerX = w / 2;
		const centerY = h / 2;
		const radius = Math.min(w, h) / 2 - px(10);
		const lineWidth = px(10);

		// Background circle
		ctx.setSourceRGBA(0.5, 0.5, 0.5, 0.2);
		ctx.setLineWidth(lineWidth);
		ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
		ctx.stroke();

		// Progress arc
		if (progress > 0) {
			const accentRgb = parseCssColor(accentHex);
			ctx.setSourceRGBA(accentRgb.r, accentRgb.g, accentRgb.b, 1.0);
			ctx.setLineWidth(lineWidth);
			ctx.setLineCap(1);
			const startAngle = -Math.PI / 2;
			const endAngle = startAngle + (2 * Math.PI * progress);
			ctx.arc(centerX, centerY, radius, startAngle, endAngle);
			ctx.stroke();
		}

		ctx.$dispose();
	});

	const updateDisplay = () => {
		const time = formatTime(remainingSeconds);
		minutesLabel.set_text(time.minutes);
		secondsLabel.set_text(time.seconds);
		circleTimeLabel.set_text(`${time.minutes}:${time.seconds}`);
		
		if (totalSeconds > 0) {
			progress = Math.max(0, Math.min(1, remainingSeconds / totalSeconds));
		} else {
			progress = 0;
		}
		
		circleCanvas.queue_repaint();

		playBtn.child.icon_name = isRunning 
			? 'media-playback-pause-symbolic' 
			: 'media-playback-start-symbolic';

		// Disable +/- buttons when running
		const controlsEnabled = !isRunning;
		minutesPlusBtn.reactive = controlsEnabled;
		minutesMinusBtn.reactive = controlsEnabled;
		secondsPlusBtn.reactive = controlsEnabled;
		secondsMinusBtn.reactive = controlsEnabled;
		
		const opacity = controlsEnabled ? 1.0 : 0.4;
		minutesPlusBtn.opacity = opacity * 255;
		minutesMinusBtn.opacity = opacity * 255;
		secondsPlusBtn.opacity = opacity * 255;
		secondsMinusBtn.opacity = opacity * 255;
	};

	const setTimer = (seconds) => {
		if (!isRunning) {
			totalSeconds = Math.max(0, Math.min(5999, seconds)); // Max 99:59
			remainingSeconds = totalSeconds;
			updateDisplay();
		}
	};

	const startTimer = () => {
		if (isRunning || remainingSeconds <= 0) return;
		isRunning = true;
		const startTime = GLib.get_monotonic_time() / 1000;
		const targetEndTime = startTime + (remainingSeconds * 1000);
		timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_INTERVAL_MS, () => {
			const now = GLib.get_monotonic_time() / 1000;
			remainingSeconds = Math.max(0, (targetEndTime - now) / 1000);
			updateDisplay();
			if (remainingSeconds <= 0) {
				stopTimerInternal();
				Main.notify(_('Timer'), _('Timer finished!'));
				return GLib.SOURCE_REMOVE;
			}
			return GLib.SOURCE_CONTINUE;
		});
		updateDisplay();
	};

	const pauseTimer = () => {
		if (!isRunning) return;
		isRunning = false;
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
		updateDisplay();
	};

	const stopTimerInternal = () => {
		pauseTimer();
		remainingSeconds = 0;
		totalSeconds = 0;
		updateDisplay();
	};

	minutesPlusBtn.connect('clicked', () => {
		const newSeconds = remainingSeconds + 60;
		setTimer(newSeconds);
	});

	minutesMinusBtn.connect('clicked', () => {
		const newSeconds = remainingSeconds - 60;
		setTimer(newSeconds);
	});

	secondsPlusBtn.connect('clicked', () => {
		const newSeconds = remainingSeconds + 1;
		setTimer(newSeconds);
	});

	secondsMinusBtn.connect('clicked', () => {
		const newSeconds = remainingSeconds - 1;
		setTimer(newSeconds);
	});

	playBtn.connect('clicked', () => {
		if (remainingSeconds === 0) {
			setTimer(3 * 60);
			startTimer();
		} else if (isRunning) {
			pauseTimer();
		} else {
			startTimer();
		}
	});

	stopBtn.connect('clicked', () => stopTimerInternal());

	body.connect('destroy', () => {
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
	});

	updateDisplay();
}

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border};`;
}

export function render({body, theme, sizeForWidget, widget}) {
	const sizeKey = widget?.size ?? 'small';

	if (sizeKey === 'medium') {
		renderMediumTimer({body, theme, sizeForWidget, widget});
	} else {
		renderSmallTimer({body, theme, sizeForWidget, widget});
	}
}
