/*
 * Timer widget (Countdown Timer)
 * Visual countdown timer with preset buttons and circular progress
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
export const supportedSizes = ['medium', 'large'];

const TICK_INTERVAL_MS = 100; // Update every 100ms for smooth progress

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

	const mainBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(16)}px;`,
	});

	body.add_child(mainBox);

	// Preset buttons
	const presetsBox = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(8)}px;`,
	});

	const presets = [
		{ label: _('5 mins'), seconds: 5 * 60 },
		{ label: _('10 mins'), seconds: 10 * 60 },
		{ label: _('20 mins'), seconds: 20 * 60 },
	];

	const presetButtons = [];

	for (const preset of presets) {
		const btn = new St.Button({
			reactive: true,
			can_focus: true,
			child: new St.Label({
				text: preset.label,
				x_align: Clutter.ActorAlign.CENTER,
				y_align: Clutter.ActorAlign.CENTER,
			}),
			style: `font-size: ${px(14)}px; padding: ${px(8)}px ${px(16)}px; border-radius: ${px(16)}px; background-color: rgba(255, 255, 255, 0.1); color: ${textColor}; font-weight: 500;`,
		});

		btn.connect('button-press-event', (_actor, event) => {
			if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
			setTimer(preset.seconds);
			return Clutter.EVENT_STOP;
		});

		presetButtons.push({ button: btn, seconds: preset.seconds });
		presetsBox.add_child(btn);
	}

	mainBox.add_child(presetsBox);

	// Timer display and controls
	const timerBox = new St.BoxLayout({
		orientation: Clutter.Orientation.HORIZONTAL,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(24)}px;`,
	});

	// Left side: Timer text and stop button
	const leftBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(16)}px;`,
	});

	const titleLabel = new St.Label({
		text: _('Timer'),
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${mutedColor}; font-size: ${px(16)}px; font-weight: 600;`,
	});
	leftBox.add_child(titleLabel);

	const timeLabel = new St.Label({
		text: '00:00',
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(64)}px; font-weight: 700;`,
	});
	leftBox.add_child(timeLabel);

	const stopBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({
			text: _('Stop'),
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
		}),
		style: `font-size: ${px(16)}px; padding: ${px(12)}px ${px(40)}px; border-radius: ${px(12)}px; background-color: rgba(255, 255, 255, 0.1); color: ${textColor}; font-weight: 500;`,
	});
	leftBox.add_child(stopBtn);

	timerBox.add_child(leftBox);

	// Right side: Circular progress with pause button
	const circleSize = px(140);
	const circleCanvas = new St.DrawingArea({
		width: circleSize,
		height: circleSize,
	});

	// Pause button in center of circle
	const pauseBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'media-playback-pause-symbolic',
			icon_size: px(32),
			style: `color: ${accentTextColor};`,
		}),
		style: `padding: ${px(16)}px; border-radius: 999px; background-color: ${accentHex}; position: absolute;`,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
	});

	const rightBox = new St.Widget({
		width: circleSize,
		height: circleSize,
		layout_manager: new Clutter.BinLayout(),
	});
	rightBox.add_child(circleCanvas);
	rightBox.add_child(pauseBtn);

	timerBox.add_child(rightBox);
	mainBox.add_child(timerBox);

	let progress = 0; // 0 to 1

	circleCanvas.connect('repaint', (canvas) => {
		const ctx = canvas.get_context();
		const [w, h] = canvas.get_surface_size();
		const centerX = w / 2;
		const centerY = h / 2;
		const radius = Math.min(w, h) / 2 - px(8);
		const lineWidth = px(10);

		// Background circle
		ctx.setSourceRGBA(0.3, 0.3, 0.3, 0.3);
		ctx.setLineWidth(lineWidth);
		ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
		ctx.stroke();

		// Progress arc
		if (progress > 0) {
			const accentRgb = parseCssColor(accentHex);
			ctx.setSourceRGBA(accentRgb.r, accentRgb.g, accentRgb.b, 1.0);
			ctx.setLineWidth(lineWidth);
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

		// Update preset buttons highlight
		for (const { button, seconds } of presetButtons) {
			const isActive = totalSeconds === seconds && remainingSeconds > 0;
			if (isActive) {
				button.style = `font-size: ${px(14)}px; padding: ${px(8)}px ${px(16)}px; border-radius: ${px(16)}px; background-color: ${accentHex}; color: ${accentTextColor}; font-weight: 600;`;
			} else {
				button.style = `font-size: ${px(14)}px; padding: ${px(8)}px ${px(16)}px; border-radius: ${px(16)}px; background-color: rgba(255, 255, 255, 0.1); color: ${textColor}; font-weight: 500;`;
			}
		}
	};

	const setTimer = (seconds) => {
		stopTimer();
		totalSeconds = seconds;
		remainingSeconds = seconds;
		updateDisplay();
		startTimer();
	};

	const startTimer = () => {
		if (isRunning || remainingSeconds <= 0) return;
		isRunning = true;
		pauseBtn.child.icon_name = 'media-playback-pause-symbolic';

		const startTime = GLib.get_monotonic_time() / 1000;
		const targetEndTime = startTime + (remainingSeconds * 1000);

		timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_INTERVAL_MS, () => {
			const now = GLib.get_monotonic_time() / 1000;
			remainingSeconds = Math.max(0, (targetEndTime - now) / 1000);
			updateDisplay();

			if (remainingSeconds <= 0) {
				stopTimer();
				onTimerComplete();
				return GLib.SOURCE_REMOVE;
			}

			return GLib.SOURCE_CONTINUE;
		});
	};

	const pauseTimer = () => {
		if (!isRunning) return;
		isRunning = false;
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
		pauseBtn.child.icon_name = 'media-playback-start-symbolic';
	};

	const stopTimer = () => {
		pauseTimer();
		totalSeconds = 0;
		remainingSeconds = 0;
		progress = 0;
		updateDisplay();
	};

	const onTimerComplete = () => {
		Main.notify(_('Timer'), _('Timer finished!'));
		// Play system sound or notification
	};

	pauseBtn.connect('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
		if (isRunning) {
			pauseTimer();
		} else if (remainingSeconds > 0) {
			startTimer();
		}
		return Clutter.EVENT_STOP;
	});

	stopBtn.connect('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
		stopTimer();
		return Clutter.EVENT_STOP;
	});

	body.connect('destroy', () => {
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
	});

	updateDisplay();
}

function renderLargeTimer({body, theme, sizeForWidget, widget}) {
	// Large version: same as medium but with bigger scale
	renderMediumTimer({body, theme, sizeForWidget, widget});
}

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border};`;
}

export function render({body, theme, sizeForWidget, widget}) {
	const sizeKey = widget?.size ?? 'medium';

	if (sizeKey === 'large') {
		renderLargeTimer({body, theme, sizeForWidget, widget});
	} else {
		renderMediumTimer({body, theme, sizeForWidget, widget});
	}
}
