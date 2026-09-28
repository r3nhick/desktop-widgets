/*
 * Timer widget (Countdown Timer)
 * Clean, minimal countdown timer with preset buttons and smooth progress indicator
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
export const supportedSizes = ['small', 'medium', 'large'];

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

// Small timer (1x1) - minimal view
function renderSmallTimer({body, theme, sizeForWidget, widget}) {
	const textColor = theme.text;
	const mutedColor = theme.muted;
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

	const mainBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(8)}px;`,
	});

	body.add_child(mainBox);

	// Time display
	const timeLabel = new St.Label({
		text: '00:00',
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(52)}px; font-weight: 700; line-height: 0.9;`,
	});
	mainBox.add_child(timeLabel);

	// Quick presets (horizontal)
	const quickBox = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(6)}px;`,
	});

	const quickPresets = [5, 10, 15];
	for (const mins of quickPresets) {
		const btn = new St.Button({
			reactive: true,
			can_focus: true,
			child: new St.Label({ text: String(mins) }),
			style: `
				font-size: ${px(11)}px; 
				width: ${px(28)}px; 
				height: ${px(28)}px;
				border-radius: ${px(14)}px; 
				background-color: rgba(255, 255, 255, 0.12); 
				color: ${textColor}; 
				font-weight: 600;
			`,
		});
		btn.connect('clicked', () => setTimer(mins * 60));
		quickBox.add_child(btn);
	}
	mainBox.add_child(quickBox);

	// Action buttons
	const actionsBox = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(6)}px;`,
	});

	const pauseBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'media-playback-start-symbolic',
			icon_size: px(16),
			style: `color: ${accentTextColor};`,
		}),
		style: `padding: ${px(8)}px; border-radius: 999px; background-color: ${accentHex};`,
	});

	const resetBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'view-refresh-symbolic',
			icon_size: px(14),
			style: `color: ${textColor};`,
		}),
		style: `padding: ${px(8)}px; border-radius: 999px; background-color: rgba(255, 255, 255, 0.12);`,
	});

	actionsBox.add_child(pauseBtn);
	actionsBox.add_child(resetBtn);
	mainBox.add_child(actionsBox);

	const updateDisplay = () => {
		const time = formatTime(remainingSeconds);
		timeLabel.set_text(`${time.minutes}:${time.seconds}`);
		pauseBtn.child.icon_name = isRunning 
			? 'media-playback-pause-symbolic' 
			: 'media-playback-start-symbolic';
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

	pauseBtn.connect('clicked', () => {
		if (remainingSeconds > 0) {
			isRunning ? pauseTimer() : startTimer();
		}
	});

	resetBtn.connect('clicked', () => stopTimer());

	body.connect('destroy', () => {
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
	});

	updateDisplay();
}

// Medium/Large timer - full featured
function renderFullTimer({body, theme, sizeForWidget, widget}) {
	const textColor = theme.text;
	const mutedColor = theme.muted;
	const accentHex = accentColor(theme);
	const accentTextColor = textOnAccentColor(accentHex);
	const [width, height] = sizeForWidget(widget);
	const contentW = width - 34;
	const contentH = height - 34;
	const sizeKey = widget?.size ?? 'medium';
	const isLarge = sizeKey === 'large';
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
		style: `spacing: ${px(isLarge ? 24 : 16)}px;`,
	});

	body.add_child(mainBox);

	// Preset buttons (show only when not running)
	const presetsBox = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(10)}px;`,
	});

	const presets = [5, 10, 15, 20, 30];
	const presetButtons = [];

	for (const mins of presets) {
		const btn = new St.Button({
			reactive: true,
			can_focus: true,
			child: new St.Label({ 
				text: String(mins),
				x_align: Clutter.ActorAlign.CENTER,
				y_align: Clutter.ActorAlign.CENTER,
			}),
			style: `
				font-size: ${px(14)}px; 
				width: ${px(40)}px; 
				height: ${px(40)}px;
				border-radius: ${px(20)}px; 
				background-color: rgba(255, 255, 255, 0.1); 
				color: ${textColor}; 
				font-weight: 600;
			`,
		});
		btn.connect('clicked', () => setTimer(mins * 60));
		presetsBox.add_child(btn);
		presetButtons.push(btn);
	}

	mainBox.add_child(presetsBox);

	// Time container with progress indicator
	const timeContainer = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		x_expand: true,
		y_expand: true,
		style: `spacing: ${px(12)}px;`,
	});

	// Large time display
	const timeLabel = new St.Label({
		text: '00:00',
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(isLarge ? 96 : 72)}px; font-weight: 700; line-height: 0.85;`,
	});
	timeContainer.add_child(timeLabel);

	// Thin progress bar
	const progressBarWidth = px(isLarge ? 280 : 220);
	const progressBarHeight = px(6);
	const progressBar = new St.Widget({
		width: progressBarWidth,
		height: progressBarHeight,
		style: `background-color: rgba(255, 255, 255, 0.15); border-radius: ${px(3)}px;`,
	});

	const progressFill = new St.Widget({
		height: progressBarHeight,
		style: `background-color: ${accentHex}; border-radius: ${px(3)}px;`,
	});
	progressBar.add_child(progressFill);
	timeContainer.add_child(progressBar);

	mainBox.add_child(timeContainer);

	// Control buttons
	const controlsBox = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(12)}px;`,
	});

	const pauseBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'media-playback-start-symbolic',
			icon_size: px(24),
			style: `color: ${accentTextColor};`,
		}),
		style: `padding: ${px(20)}px; border-radius: 999px; background-color: ${accentHex};`,
	});

	const resetBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'view-refresh-symbolic',
			icon_size: px(20),
			style: `color: ${textColor};`,
		}),
		style: `padding: ${px(18)}px; border-radius: 999px; background-color: rgba(255, 255, 255, 0.15);`,
	});

	controlsBox.add_child(pauseBtn);
	controlsBox.add_child(resetBtn);
	mainBox.add_child(controlsBox);

	const updateDisplay = () => {
		const time = formatTime(remainingSeconds);
		timeLabel.set_text(`${time.minutes}:${time.seconds}`);
		
		// Update progress bar
		let progress = 0;
		if (totalSeconds > 0) {
			progress = Math.max(0, Math.min(1, remainingSeconds / totalSeconds));
		}
		progressFill.set_width(Math.round(progressBarWidth * progress));

		// Update pause button icon
		pauseBtn.child.icon_name = isRunning 
			? 'media-playback-pause-symbolic' 
			: 'media-playback-start-symbolic';

		// Show/hide presets based on running state
		presetsBox.visible = remainingSeconds === 0;
		
		// Adjust time size when running
		if (remainingSeconds > 0) {
			timeLabel.style = `color: ${textColor}; font-size: ${px(isLarge ? 112 : 88)}px; font-weight: 700; line-height: 0.85;`;
		} else {
			timeLabel.style = `color: ${textColor}; font-size: ${px(isLarge ? 96 : 72)}px; font-weight: 700; line-height: 0.85;`;
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

	pauseBtn.connect('clicked', () => {
		if (remainingSeconds > 0) {
			isRunning ? pauseTimer() : startTimer();
		}
	});

	resetBtn.connect('clicked', () => stopTimer());

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
	const sizeKey = widget?.size ?? 'medium';

	if (sizeKey === 'small') {
		renderSmallTimer({body, theme, sizeForWidget, widget});
	} else {
		renderFullTimer({body, theme, sizeForWidget, widget});
	}
}
