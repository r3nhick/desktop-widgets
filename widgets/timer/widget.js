/*
 * Timer widget (Countdown Timer)
 * Clean countdown timer with preset buttons, custom input, and minimal running view
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

// Small timer (1x1)
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

	const container = new St.Widget({
		x_expand: true,
		y_expand: true,
		layout_manager: new Clutter.BinLayout(),
	});
	body.add_child(container);

	// Setup view (presets + custom input)
	const setupBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(8)}px;`,
	});
	container.add_child(setupBox);

	// Quick presets
	const presetsBox = new St.BoxLayout({
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
		presetsBox.add_child(btn);
	}
	setupBox.add_child(presetsBox);

	// Custom input (minutes only for small)
	const customBox = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(6)}px;`,
	});

	const minutesEntry = new St.Entry({
		hint_text: '0',
		can_focus: true,
		style: `width: ${px(40)}px; font-size: ${px(12)}px; text-align: center;`,
	});
	minutesEntry.clutter_text.set_max_length(3);
	customBox.add_child(minutesEntry);

	const minLabel = new St.Label({
		text: 'min',
		y_align: Clutter.ActorAlign.CENTER,
		style: `color: ${mutedColor}; font-size: ${px(11)}px;`,
	});
	customBox.add_child(minLabel);

	const startCustomBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'media-playback-start-symbolic',
			icon_size: px(14),
			style: `color: ${accentTextColor};`,
		}),
		style: `padding: ${px(6)}px; border-radius: 999px; background-color: ${accentHex};`,
	});
	customBox.add_child(startCustomBtn);

	setupBox.add_child(customBox);

	// Running view (only time + stop button)
	const runningBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(12)}px;`,
		visible: false,
	});
	container.add_child(runningBox);

	const timeLabel = new St.Label({
		text: '00:00',
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(56)}px; font-weight: 700; line-height: 0.9;`,
	});
	runningBox.add_child(timeLabel);

	const stopBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({
			text: _('Stop'),
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
		}),
		style: `font-size: ${px(12)}px; padding: ${px(8)}px ${px(20)}px; border-radius: ${px(12)}px; background-color: rgba(255, 255, 255, 0.15); color: ${textColor}; font-weight: 500;`,
	});
	runningBox.add_child(stopBtn);

	const updateDisplay = () => {
		const time = formatTime(remainingSeconds);
		timeLabel.set_text(`${time.minutes}:${time.seconds}`);
	};

	const switchToRunning = () => {
		setupBox.visible = false;
		runningBox.visible = true;
	};

	const switchToSetup = () => {
		setupBox.visible = true;
		runningBox.visible = false;
	};

	const setTimer = (seconds) => {
		stopTimer();
		totalSeconds = seconds;
		remainingSeconds = seconds;
		updateDisplay();
		switchToRunning();
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

	const stopTimer = () => {
		if (isRunning) {
			isRunning = false;
			if (timerId) {
				GLib.Source.remove(timerId);
				timerId = null;
			}
		}
		remainingSeconds = 0;
		totalSeconds = 0;
		switchToSetup();
		updateDisplay();
	};

	startCustomBtn.connect('clicked', () => {
		const minsText = minutesEntry.get_text().trim();
		const mins = parseInt(minsText) || 0;
		if (mins > 0) {
			setTimer(mins * 60);
		}
	});

	minutesEntry.clutter_text.connect('activate', () => {
		startCustomBtn.emit('clicked');
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

// Medium timer (2x1)
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

	// Setup view
	const setupBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(20)}px;`,
	});
	container.add_child(setupBox);

	// Presets
	const presetsBox = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(10)}px;`,
	});

	const presets = [5, 10, 15, 20, 30];
	for (const mins of presets) {
		const btn = new St.Button({
			reactive: true,
			can_focus: true,
			child: new St.Label({ text: String(mins) }),
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
	}
	setupBox.add_child(presetsBox);

	// Custom input (minutes:seconds)
	const customBox = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(8)}px;`,
	});

	const customLabel = new St.Label({
		text: _('Custom:'),
		y_align: Clutter.ActorAlign.CENTER,
		style: `color: ${mutedColor}; font-size: ${px(14)}px; font-weight: 600;`,
	});
	customBox.add_child(customLabel);

	const minutesEntry = new St.Entry({
		hint_text: '0',
		can_focus: true,
		style: `width: ${px(50)}px; font-size: ${px(14)}px; text-align: center;`,
	});
	minutesEntry.clutter_text.set_max_length(3);
	customBox.add_child(minutesEntry);

	const colonLabel = new St.Label({
		text: ':',
		y_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(14)}px; font-weight: 600;`,
	});
	customBox.add_child(colonLabel);

	const secondsEntry = new St.Entry({
		hint_text: '00',
		can_focus: true,
		style: `width: ${px(50)}px; font-size: ${px(14)}px; text-align: center;`,
	});
	secondsEntry.clutter_text.set_max_length(2);
	customBox.add_child(secondsEntry);

	const startCustomBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'media-playback-start-symbolic',
			icon_size: px(20),
			style: `color: ${accentTextColor};`,
		}),
		style: `padding: ${px(10)}px; border-radius: 999px; background-color: ${accentHex};`,
	});
	customBox.add_child(startCustomBtn);

	setupBox.add_child(customBox);

	// Running view (only time + stop button)
	const runningBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(20)}px;`,
		visible: false,
	});
	container.add_child(runningBox);

	const timeLabel = new St.Label({
		text: '00:00',
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(88)}px; font-weight: 700; line-height: 0.85;`,
	});
	runningBox.add_child(timeLabel);

	// Thin progress bar
	const progressBarWidth = px(220);
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
	runningBox.add_child(progressBar);

	const stopBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Label({
			text: _('Stop'),
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
		}),
		style: `font-size: ${px(16)}px; padding: ${px(12)}px ${px(40)}px; border-radius: ${px(12)}px; background-color: rgba(255, 255, 255, 0.15); color: ${textColor}; font-weight: 500;`,
	});
	runningBox.add_child(stopBtn);

	const updateDisplay = () => {
		const time = formatTime(remainingSeconds);
		timeLabel.set_text(`${time.minutes}:${time.seconds}`);
		
		// Update progress bar
		let progress = 0;
		if (totalSeconds > 0) {
			progress = Math.max(0, Math.min(1, remainingSeconds / totalSeconds));
		}
		progressFill.set_width(Math.round(progressBarWidth * progress));
	};

	const switchToRunning = () => {
		setupBox.visible = false;
		runningBox.visible = true;
	};

	const switchToSetup = () => {
		setupBox.visible = true;
		runningBox.visible = false;
	};

	const setTimer = (seconds) => {
		stopTimer();
		totalSeconds = seconds;
		remainingSeconds = seconds;
		updateDisplay();
		switchToRunning();
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

	const stopTimer = () => {
		if (isRunning) {
			isRunning = false;
			if (timerId) {
				GLib.Source.remove(timerId);
				timerId = null;
			}
		}
		remainingSeconds = 0;
		totalSeconds = 0;
		switchToSetup();
		updateDisplay();
	};

	startCustomBtn.connect('clicked', () => {
		const minsText = minutesEntry.get_text().trim();
		const secsText = secondsEntry.get_text().trim();
		const mins = parseInt(minsText) || 0;
		const secs = parseInt(secsText) || 0;
		const totalSecs = mins * 60 + secs;
		if (totalSecs > 0) {
			setTimer(totalSecs);
		}
	});

	minutesEntry.clutter_text.connect('activate', () => {
		startCustomBtn.emit('clicked');
	});

	secondsEntry.clutter_text.connect('activate', () => {
		startCustomBtn.emit('clicked');
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
