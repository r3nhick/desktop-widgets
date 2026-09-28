import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { parseCssColor } from '../../utils/ported.js';

export const type = 'lava';
export const label = 'Lava Lamp';
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium', 'large'];

const DEFAULT_ACCENT = '#3584e4';
const DEFAULT_GRAY = '#b0b0b0';

class Ball {
	constructor(width, height, minRadius, maxRadius, speed) {
		this.r = Math.random() * (maxRadius - minRadius) + minRadius;
		this.x = Math.random() * (width - this.r * 2) + this.r;
		this.y = Math.random() * (height - this.r * 2) + this.r;
		this.vx = (Math.random() - 0.5) * speed;
		this.vy = (Math.random() - 0.5) * speed;
		this.width = width;
		this.height = height;
	}

	update() {
		this.x += this.vx;
		this.y += this.vy;

		if (this.x - this.r < 0 || this.x + this.r > this.width) this.vx *= -1;
		if (this.y - this.r < 0 || this.y + this.r > this.height) this.vy *= -1;
	}
}

function getBallColor(theme, settings) {
	const useAccent = settings?.get_boolean('lava-use-accent-color') ?? false;
	if (useAccent) {
		const accent = String(theme?.accent ?? '').trim() || DEFAULT_ACCENT;
		return parseCssColor(accent);
	}
	return parseCssColor(DEFAULT_GRAY);
}

// Metaball effect: обчислюємо силу поля в точці (x, y)
function calculateFieldStrength(x, y, balls) {
	let sum = 0;
	for (let ball of balls) {
		const dx = x - ball.x;
		const dy = y - ball.y;
		const distSq = dx * dx + dy * dy;
		if (distSq > 0) {
			// Використовуємо формулу метакуль: сила = radius^2 / distance^2
			sum += (ball.r * ball.r) / distSq;
		}
	}
	return sum;
}

function drawLavaMetaballs(area, balls, ballColor) {
	const ctx = area.get_context();
	const [width, height] = area.get_surface_size();

	ctx.setOperator(0);
	ctx.paint();
	ctx.setOperator(2);

	// Поріг для метакуль (зменшено для меншого зліплення)
	const threshold = 1.8;
	const step = 3; // Крок сітки (менше = вища якість)

	// Проходимо по сітці та малюємо точки, де сила поля перевищує поріг
	ctx.setSourceRGB(ballColor.r, ballColor.g, ballColor.b);
	const pointRadius = step * 0.8;
	
	for (let y = 0; y < height; y += step) {
		for (let x = 0; x < width; x += step) {
			const strength = calculateFieldStrength(x, y, balls);
			if (strength >= threshold) {
				ctx.arc(x, y, pointRadius, 0, Math.PI * 2);
				ctx.fill();
			}
		}
	}

	ctx.$dispose();
}

function renderSmallLava({body, theme, sizeForWidget, widget, settings}) {
	const [totalWidth, totalHeight] = sizeForWidget(widget);
	const contentW = totalWidth - 34;
	const contentH = totalHeight - 34;

	const balls = [];
	const ballCount = 5;
	const minRadius = 18;
	const maxRadius = 28;
	const speed = 0.6;

	for (let i = 0; i < ballCount; i++) {
		balls.push(new Ball(contentW, contentH, minRadius, maxRadius, speed));
	}

	let ballColor = getBallColor(theme, settings);

	const canvasActor = new St.DrawingArea({
		x_expand: true,
		y_expand: true,
	});

	canvasActor.connect('repaint', (area) => {
		drawLavaMetaballs(area, balls, ballColor);
	});

	body.add_child(canvasActor);

	let animationId = null;
	const animate = () => {
		balls.forEach(ball => ball.update());
		canvasActor.queue_repaint();
		return GLib.SOURCE_CONTINUE;
	};

	animationId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, animate);

	let settingsSignalId = null;
	if (settings) {
		settingsSignalId = settings.connect('changed::lava-use-accent-color', () => {
			ballColor = getBallColor(theme, settings);
			canvasActor.queue_repaint();
		});
	}

	body.connect('destroy', () => {
		if (animationId) {
			GLib.Source.remove(animationId);
			animationId = null;
		}
		if (settingsSignalId && settings) {
			settings.disconnect(settingsSignalId);
			settingsSignalId = null;
		}
	});
}

function renderMediumLava({body, theme, sizeForWidget, widget, settings}) {
	const [totalWidth, totalHeight] = sizeForWidget(widget);
	const contentW = totalWidth - 34;
	const contentH = totalHeight - 34;

	const balls = [];
	const ballCount = 7;
	const minRadius = 25;
	const maxRadius = 38;
	const speed = 0.8;

	for (let i = 0; i < ballCount; i++) {
		balls.push(new Ball(contentW, contentH, minRadius, maxRadius, speed));
	}

	let ballColor = getBallColor(theme, settings);

	const canvasActor = new St.DrawingArea({
		x_expand: true,
		y_expand: true,
	});

	canvasActor.connect('repaint', (area) => {
		drawLavaMetaballs(area, balls, ballColor);
	});

	body.add_child(canvasActor);

	let animationId = null;
	const animate = () => {
		balls.forEach(ball => ball.update());
		canvasActor.queue_repaint();
		return GLib.SOURCE_CONTINUE;
	};

	animationId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, animate);

	let settingsSignalId = null;
	if (settings) {
		settingsSignalId = settings.connect('changed::lava-use-accent-color', () => {
			ballColor = getBallColor(theme, settings);
			canvasActor.queue_repaint();
		});
	}

	body.connect('destroy', () => {
		if (animationId) {
			GLib.Source.remove(animationId);
			animationId = null;
		}
		if (settingsSignalId && settings) {
			settings.disconnect(settingsSignalId);
			settingsSignalId = null;
		}
	});
}

function renderLargeLava({body, theme, sizeForWidget, widget, settings}) {
	const [totalWidth, totalHeight] = sizeForWidget(widget);
	const contentW = totalWidth - 34;
	const contentH = totalHeight - 34;

	const balls = [];
	const ballCount = 10;
	const minRadius = 30;
	const maxRadius = 45;
	const speed = 1.0;

	for (let i = 0; i < ballCount; i++) {
		balls.push(new Ball(contentW, contentH, minRadius, maxRadius, speed));
	}

	let ballColor = getBallColor(theme, settings);

	const canvasActor = new St.DrawingArea({
		x_expand: true,
		y_expand: true,
	});

	canvasActor.connect('repaint', (area) => {
		drawLavaMetaballs(area, balls, ballColor);
	});

	body.add_child(canvasActor);

	let animationId = null;
	const animate = () => {
		balls.forEach(ball => ball.update());
		canvasActor.queue_repaint();
		return GLib.SOURCE_CONTINUE;
	};

	animationId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, animate);

	let settingsSignalId = null;
	if (settings) {
		settingsSignalId = settings.connect('changed::lava-use-accent-color', () => {
			ballColor = getBallColor(theme, settings);
			canvasActor.queue_repaint();
		});
	}

	body.connect('destroy', () => {
		if (animationId) {
			GLib.Source.remove(animationId);
			animationId = null;
		}
		if (settingsSignalId && settings) {
			settings.disconnect(settingsSignalId);
			settingsSignalId = null;
		}
	});
}

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border};`;
}

export function render({body, theme, sizeForWidget, widget, settings}) {
	const sizeKey = widget?.size ?? 'medium';

	if (sizeKey === 'small') {
		renderSmallLava({body, theme, sizeForWidget, widget, settings});
	} else if (sizeKey === 'large') {
		renderLargeLava({body, theme, sizeForWidget, widget, settings});
	} else {
		renderMediumLava({body, theme, sizeForWidget, widget, settings});
	}
}
