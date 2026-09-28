/*
 * Timer widget (Countdown Timer)
 * Modern circular progress timer with quick add buttons and increment controls
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

// Small timer (1x1) - circular progress with quick add buttons
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

	// Time label in center (clickable to add time)
	const timeButton = new St.Button({
		reactive: true,
		can_focus: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `background-color: transparent; border: none; padding: ${px(20)}px;`,
	});
	
	const timeLabel = new St.Label({
		text: '00:00',
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(32)}px; font-weight: 700;`,
	});
	timeButton.set_child(timeLabel);
	mainBox.add_child(timeButton);

	// Quick add buttons at top (only when not running)
	const quickAddBox = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.START,
		style: `spacing: ${px(6)}px; padding-top: ${px(8)}px;`,
	});

	const quickPresets = [1, 5, 10];
	const quickButtons = [];
	for (const mins of quickPresets) {
		const btn = new St.Button({
			reactive: true,
			can_focus: true,
			child: new St.Label({ text: `+${mins}` }),
			style: `
				font-size: ${px(10)}px; 
				padding: ${px(4)}px ${px(8)}px;
				border-radius: ${px(10)}px; 
				background-color: rgba(255, 255, 255, 0.12); 
				color: ${textColor}; 
				font-weight: 600;
			`,
		});
		btn.connect('clicked', () => addTime(mins * 60));
		quickAddBox.add_child(btn);
		quickButtons.push(btn);
	}
	mainBox.add_child(quickAddBox);

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

		// Hide quick add buttons when running
		quickAddBox.visible = !isRunning;
		
		// Disable time button when running
		timeButton.reactive = !isRunning;
	};

	const addTime = (seconds) => {
		if (!isRunning) {
			const newSeconds = Math.min(5999, remainingSeconds + seconds);
			totalSeconds = newSeconds;
			remainingSeconds = newSeconds;
			updateDisplay();
		}
	};

	const setTimer = (seconds) => {
		if (!isRunning) {
			totalSeconds = Math.max(0, Math.min(5999, seconds));
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

	// Click on time to add 1 minute
	timeButton.connect('clicked', () => {
		if (!isRunning) {
			addTime(60);
		}
	});

	playBtn.connect('clicked', () => {
		if (remainingSeconds === 0) {
			// Start with 5 minutes if empty
			setTimer(5 * 60);
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

// Medium timer (2x1) - manual input with +/- controls
function renderMediumTimer({body, theme, sizeForWidget, widget}) {
	const textColor = theme.text;
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
		style: `spacing: ${px(24)}px; padding: ${px(16)}px;`,
	});
	body.add_child(mainBox);

	// Left: circular progress
	const leftBox = new St.Widget({
		width: px(120),
		height: px(120),
		layout_manager: new Clutter.BinLayout(),
	});
	mainBox.add_child(leftBox);

	const circleSize = px(120);
	const circleCanvas = new St.DrawingArea({
		width: circleSize,
		height: circleSize,
	});
	leftBox.add_child(circleCanvas);

	const circleTimeLabel = new St.Label({
		text: '00:00',
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(24)}px; font-weight: 700;`,
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

	// Minutes column with 4 buttons: +10, +1, digits, -1, -10
	const minutesBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(4)}px;`,
	});

	const minutesPlus10Btn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '+', style: `color: ${textColor};` }),
		style: `font-size: ${px(18)}px; width: ${px(50)}px; height: ${px(32)}px; background-color: rgba(255, 255, 255, 0.1); border-radius: ${px(8)}px; font-weight: 700;`,
	});
	minutesBox.add_child(minutesPlus10Btn);

	const minutesPlus1Btn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '+', style: `color: ${textColor};` }),
		style: `font-size: ${px(14)}px; width: ${px(50)}px; height: ${px(24)}px; background-color: rgba(255, 255, 255, 0.08); border-radius: ${px(6)}px; font-weight: 700;`,
	});
	minutesBox.add_child(minutesPlus1Btn);

	const minutesLabel = new St.Label({
		text: '00',
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(72)}px; font-weight: 700; line-height: 0.9; padding: ${px(8)}px 0;`,
	});
	minutesBox.add_child(minutesLabel);

	const minutesMinus1Btn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '−', style: `color: ${textColor};` }),
		style: `font-size: ${px(14)}px; width: ${px(50)}px; height: ${px(24)}px; background-color: rgba(255, 255, 255, 0.08); border-radius: ${px(6)}px; font-weight: 700;`,
	});
	minutesBox.add_child(minutesMinus1Btn);

	const minutesMinus10Btn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '−', style: `color: ${textColor};` }),
		style: `font-size: ${px(18)}px; width: ${px(50)}px; height: ${px(32)}px; background-color: rgba(255, 255, 255, 0.1); border-radius: ${px(8)}px; font-weight: 700;`,
	});
	minutesBox.add_child(minutesMinus10Btn);

	centerBox.add_child(minutesBox);

	// Colon
	const colonLabel = new St.Label({
		text: ':',
		y_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(72)}px; font-weight: 700;`,
	});
	centerBox.add_child(colonLabel);

	// Seconds column with 4 buttons: +10, +1, digits, -1, -10
	const secondsBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(4)}px;`,
	});

	const secondsPlus10Btn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '+', style: `color: ${textColor};` }),
		style: `font-size: ${px(18)}px; width: ${px(50)}px; height: ${px(32)}px; background-color: rgba(255, 255, 255, 0.1); border-radius: ${px(8)}px; font-weight: 700;`,
	});
	secondsBox.add_child(secondsPlus10Btn);

	const secondsPlus1Btn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '+', style: `color: ${textColor};` }),
		style: `font-size: ${px(14)}px; width: ${px(50)}px; height: ${px(24)}px; background-color: rgba(255, 255, 255, 0.08); border-radius: ${px(6)}px; font-weight: 700;`,
	});
	secondsBox.add_child(secondsPlus1Btn);

	const secondsLabel = new St.Label({
		text: '00',
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(72)}px; font-weight: 700; line-height: 0.9; padding: ${px(8)}px 0;`,
	});
	secondsBox.add_child(secondsLabel);

	const secondsMinus1Btn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '−', style: `color: ${textColor};` }),
		style: `font-size: ${px(14)}px; width: ${px(50)}px; height: ${px(24)}px; background-color: rgba(255, 255, 255, 0.08); border-radius: ${px(6)}px; font-weight: 700;`,
	});
	secondsBox.add_child(secondsMinus1Btn);

	const secondsMinus10Btn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '−', style: `color: ${textColor};` }),
		style: `font-size: ${px(18)}px; width: ${px(50)}px; height: ${px(32)}px; background-color: rgba(255, 255, 255, 0.1); border-radius: ${px(8)}px; font-weight: 700;`,
	});
	secondsBox.add_child(secondsMinus10Btn);

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
		const radius = Math.min(w, h) / 2 - px(8);
		const lineWidth = px(8);

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
		const buttons = [
			minutesPlus10Btn, minutesPlus1Btn, minutesMinus1Btn, minutesMinus10Btn,
			secondsPlus10Btn, secondsPlus1Btn, secondsMinus1Btn, secondsMinus10Btn
		];
		const opacity = controlsEnabled ? 1.0 : 0.3;
		for (const btn of buttons) {
			btn.reactive = controlsEnabled;
			btn.opacity = opacity * 255;
		}
	};

	const setTimer = (seconds) => {
		if (!isRunning) {
			totalSeconds = Math.max(0, Math.min(5999, seconds));
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

	// Minutes controls
	minutesPlus10Btn.connect('clicked', () => setTimer(remainingSeconds + 600));
	minutesPlus1Btn.connect('clicked', () => setTimer(remainingSeconds + 60));
	minutesMinus1Btn.connect('clicked', () => setTimer(remainingSeconds - 60));
	minutesMinus10Btn.connect('clicked', () => setTimer(remainingSeconds - 600));

	// Seconds controls
	secondsPlus10Btn.connect('clicked', () => setTimer(remainingSeconds + 10));
	secondsPlus1Btn.connect('clicked', () => setTimer(remainingSeconds + 1));
	secondsMinus1Btn.connect('clicked', () => setTimer(remainingSeconds - 1));
	secondsMinus10Btn.connect('clicked', () => setTimer(remainingSeconds - 10));

	playBtn.connect('clicked', () => {
		if (remainingSeconds === 0) {
			setTimer(5 * 60);
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
