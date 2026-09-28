/*
 * Timer widget (Countdown Timer)
 * Countdown timer with manual time adjustment and clean running view
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { parseCssColor } from '../../utils/ported.js';

export const type = 'timer';
export const label = 'Timer';
export const defaultSize = 'medium';
export const supportedSizes = ['medium'];

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

	const container = new St.Widget({
		x_expand: true,
		y_expand: true,
		layout_manager: new Clutter.BinLayout(),
	});
	body.add_child(container);

	// Setup view (when not running)
	const setupBox = new St.BoxLayout({
		orientation: Clutter.Orientation.HORIZONTAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(24)}px; padding: ${px(16)}px;`,
	});
	container.add_child(setupBox);

	// Left: circular progress
	const leftBox = new St.Widget({
		width: px(120),
		height: px(120),
		layout_manager: new Clutter.BinLayout(),
	});
	setupBox.add_child(leftBox);

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
	setupBox.add_child(centerBox);

	// Minutes column with 4 buttons
	const minutesBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(4)}px;`,
	});

	const minutesPlus10Btn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '+10', style: `color: ${textColor};` }),
		style: `font-size: ${px(12)}px; width: ${px(50)}px; height: ${px(32)}px; background-color: rgba(255, 255, 255, 0.1); border-radius: ${px(8)}px; font-weight: 600;`,
	});
	minutesBox.add_child(minutesPlus10Btn);

	const minutesPlus1Btn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '+1', style: `color: ${textColor};` }),
		style: `font-size: ${px(11)}px; width: ${px(50)}px; height: ${px(24)}px; background-color: rgba(255, 255, 255, 0.08); border-radius: ${px(6)}px; font-weight: 600;`,
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
		child: new St.Label({ text: '-1', style: `color: ${textColor};` }),
		style: `font-size: ${px(11)}px; width: ${px(50)}px; height: ${px(24)}px; background-color: rgba(255, 255, 255, 0.08); border-radius: ${px(6)}px; font-weight: 600;`,
	});
	minutesBox.add_child(minutesMinus1Btn);

	const minutesMinus10Btn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '-10', style: `color: ${textColor};` }),
		style: `font-size: ${px(12)}px; width: ${px(50)}px; height: ${px(32)}px; background-color: rgba(255, 255, 255, 0.1); border-radius: ${px(8)}px; font-weight: 600;`,
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

	// Seconds column with 4 buttons
	const secondsBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(4)}px;`,
	});

	const secondsPlus10Btn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '+10', style: `color: ${textColor};` }),
		style: `font-size: ${px(12)}px; width: ${px(50)}px; height: ${px(32)}px; background-color: rgba(255, 255, 255, 0.1); border-radius: ${px(8)}px; font-weight: 600;`,
	});
	secondsBox.add_child(secondsPlus10Btn);

	const secondsPlus1Btn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '+1', style: `color: ${textColor};` }),
		style: `font-size: ${px(11)}px; width: ${px(50)}px; height: ${px(24)}px; background-color: rgba(255, 255, 255, 0.08); border-radius: ${px(6)}px; font-weight: 600;`,
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
		child: new St.Label({ text: '-1', style: `color: ${textColor};` }),
		style: `font-size: ${px(11)}px; width: ${px(50)}px; height: ${px(24)}px; background-color: rgba(255, 255, 255, 0.08); border-radius: ${px(6)}px; font-weight: 600;`,
	});
	secondsBox.add_child(secondsMinus1Btn);

	const secondsMinus10Btn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({ text: '-10', style: `color: ${textColor};` }),
		style: `font-size: ${px(12)}px; width: ${px(50)}px; height: ${px(32)}px; background-color: rgba(255, 255, 255, 0.1); border-radius: ${px(8)}px; font-weight: 600;`,
	});
	secondsBox.add_child(secondsMinus10Btn);

	centerBox.add_child(secondsBox);

	// Right: Play button (in setup view)
	const setupRightBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.END,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(12)}px;`,
	});

	const startBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'media-playback-start-symbolic',
			icon_size: px(28),
			style: `color: ${accentTextColor};`,
		}),
		style: `padding: ${px(18)}px; border-radius: 999px; background-color: ${accentHex};`,
	});
	setupRightBox.add_child(startBtn);

	setupBox.add_child(setupRightBox);

	// Running view (when timer is running)
	const runningBox = new St.BoxLayout({
		orientation: Clutter.Orientation.HORIZONTAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(32)}px;`,
		visible: false,
	});
	container.add_child(runningBox);

	// Big time display
	const runningTimeLabel = new St.Label({
		text: '00:00',
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(96)}px; font-weight: 700; line-height: 0.9;`,
	});
	runningBox.add_child(runningTimeLabel);

	// Right: Pause and Stop buttons
	const runningRightBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.END,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(12)}px;`,
	});

	const pauseBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'media-playback-pause-symbolic',
			icon_size: px(28),
			style: `color: ${accentTextColor};`,
		}),
		style: `padding: ${px(18)}px; border-radius: 999px; background-color: ${accentHex};`,
	});
	runningRightBox.add_child(pauseBtn);

	const stopBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'media-playback-stop-symbolic',
			icon_size: px(24),
			style: `color: ${textColor};`,
		}),
		style: `padding: ${px(16)}px; border-radius: 999px; background-color: rgba(255, 255, 255, 0.15); border: ${px(2)}px solid rgba(255, 255, 255, 0.3);`,
	});
	runningRightBox.add_child(stopBtn);

	runningBox.add_child(runningRightBox);

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
		runningTimeLabel.set_text(`${time.minutes}:${time.seconds}`);
		
		if (totalSeconds > 0) {
			progress = Math.max(0, Math.min(1, remainingSeconds / totalSeconds));
		} else {
			progress = 0;
		}
		
		circleCanvas.queue_repaint();

		// Show/hide views based on running state
		if (isRunning) {
			setupBox.visible = false;
			runningBox.visible = true;
		} else {
			setupBox.visible = true;
			runningBox.visible = false;
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
		totalSeconds = remainingSeconds; // Lock in the total time
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

	startBtn.connect('clicked', () => {
		if (remainingSeconds > 0) {
			startTimer();
		}
	});

	pauseBtn.connect('clicked', () => pauseTimer());
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
	renderMediumTimer({body, theme, sizeForWidget, widget});
}
