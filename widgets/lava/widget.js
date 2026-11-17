import GLib from 'gi://GLib';
import St from 'gi://St';
import { parseCssColor } from '../../utils/ported.js';

export const type = 'lava';
export const label = 'Lava Lamp';
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium', 'large'];

const DEFAULT_ACCENT = '#3584e4';
const DEFAULT_GRAY = '#b0b0b0';

// Metaball look (unchanged from the original renderer).
const THRESHOLD = 1.8;
const GRID_STEP = 3;
const POINT_RADIUS = GRID_STEP * 0.8;

// ~30 fps is plenty for slowly drifting blobs. Movement is time-based, so
// the drift speed is exactly what the old per-size timers produced
// (small 0.6px/30ms, medium 0.8px/25ms, large 1.0px/20ms).
const FRAME_MS = 33;

const SIZE_CONFIG = {
	small: { ballCount: 5, minRadius: 18, maxRadius: 28, pxPerMs: 0.6 / 30 },
	medium: { ballCount: 7, minRadius: 25, maxRadius: 38, pxPerMs: 0.8 / 25 },
	large: { ballCount: 10, minRadius: 30, maxRadius: 45, pxPerMs: 1.0 / 20 },
};

// Fullscreen pause (driven by extension.js through setAnimationsPaused).
let animationsPaused = false;
const instances = new Set();

export function setAnimationsPaused(paused) {
	animationsPaused = !!paused;
	for (const instance of instances)
		instance.sync();
}

class Ball {
	constructor(width, height, minRadius, maxRadius, pxPerMs) {
		this.r = Math.random() * (maxRadius - minRadius) + minRadius;
		this.r2 = this.r * this.r;
		this.width = width;
		this.height = height;
		this.x = Math.random() * Math.max(0, width - this.r * 2) + this.r;
		this.y = Math.random() * Math.max(0, height - this.r * 2) + this.r;
		// Velocity in px per ms.
		this.vx = (Math.random() - 0.5) * pxPerMs;
		this.vy = (Math.random() - 0.5) * pxPerMs;
	}

	update(dtMs) {
		this.x += this.vx * dtMs;
		this.y += this.vy * dtMs;

		// Clamp + reflect: flipping the sign alone let a ball that overshot
		// the edge flip back and forth every frame and stay stuck there.
		if (this.x - this.r < 0) {
			this.x = this.r;
			this.vx = Math.abs(this.vx);
		} else if (this.x + this.r > this.width) {
			this.x = this.width - this.r;
			this.vx = -Math.abs(this.vx);
		}
		if (this.y - this.r < 0) {
			this.y = this.r;
			this.vy = Math.abs(this.vy);
		} else if (this.y + this.r > this.height) {
			this.y = this.height - this.r;
			this.vy = -Math.abs(this.vy);
		}
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

function drawLavaMetaballs(area, balls, ballColor) {
	const ctx = area.get_context();
	const [width, height] = area.get_surface_size();

	ctx.setOperator(0); // CLEAR
	ctx.paint();
	ctx.setOperator(2); // OVER
	ctx.setSourceRGB(ballColor.r, ballColor.g, ballColor.b);

	const n = balls.length;
	const bx = new Float64Array(n);
	const r2 = new Float64Array(n);
	const dy2 = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		bx[i] = balls[i].x;
		r2[i] = balls[i].r2;
	}

	// All dots go into ONE path and are filled once: the old renderer issued
	// a separate fill() per dot (thousands of Cairo fills per frame).
	const TWO_PI = Math.PI * 2;
	let any = false;
	for (let y = 0; y < height; y += GRID_STEP) {
		for (let i = 0; i < n; i++) {
			const d = y - balls[i].y;
			dy2[i] = d * d;
		}
		for (let x = 0; x < width; x += GRID_STEP) {
			let sum = 0;
			for (let i = 0; i < n; i++) {
				const dx = x - bx[i];
				const distSq = dx * dx + dy2[i];
				if (distSq > 0)
					sum += r2[i] / distSq;
			}
			if (sum >= THRESHOLD) {
				ctx.newSubPath();
				ctx.arc(x, y, POINT_RADIUS, 0, TWO_PI);
				any = true;
			}
		}
	}
	if (any)
		ctx.fill();

	ctx.$dispose();
}

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border};`;
}

export function render({body, theme, sizeForWidget, widget, settings}) {
	const sizeKey = widget?.size ?? 'medium';
	const config = SIZE_CONFIG[sizeKey] ?? SIZE_CONFIG.medium;

	const [totalWidth, totalHeight] = sizeForWidget(widget);
	const contentW = totalWidth - 34;
	const contentH = totalHeight - 34;

	const balls = [];
	for (let i = 0; i < config.ballCount; i++)
		balls.push(new Ball(contentW, contentH, config.minRadius, config.maxRadius, config.pxPerMs));

	let ballColor = getBallColor(theme, settings);

	const canvasActor = new St.DrawingArea({
		x_expand: true,
		y_expand: true,
	});
	canvasActor.connect('repaint', area => drawLavaMetaballs(area, balls, ballColor));
	body.add_child(canvasActor);

	let animationId = 0;
	let lastFrameMono = 0;

	const animate = () => {
		const now = GLib.get_monotonic_time();
		// Cap the step so a long stall (suspend, busy shell) does not
		// teleport the blobs across the lamp.
		const dt = Math.min(100, (now - lastFrameMono) / 1000);
		lastFrameMono = now;
		for (const ball of balls)
			ball.update(dt);
		canvasActor.queue_repaint();
		return GLib.SOURCE_CONTINUE;
	};

	const stop = () => {
		if (animationId) {
			GLib.Source.remove(animationId);
			animationId = 0;
		}
	};

	// Animate only while the lamp is actually on screen: hidden workspaces,
	// stack pages and fullscreen windows no longer burn CPU on it.
	const instance = {
		sync() {
			const shouldRun = canvasActor.mapped && !animationsPaused;
			if (shouldRun && !animationId) {
				lastFrameMono = GLib.get_monotonic_time();
				animationId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, animate);
				GLib.Source.set_name_by_id(animationId, '[desktop-widgets] lava animation');
			} else if (!shouldRun) {
				stop();
			}
		},
	};
	instances.add(instance);
	canvasActor.connect('notify::mapped', () => instance.sync());
	instance.sync();

	let settingsSignalId = 0;
	if (settings) {
		settingsSignalId = settings.connect('changed::lava-use-accent-color', () => {
			ballColor = getBallColor(theme, settings);
			canvasActor.queue_repaint();
		});
	}

	// The body survives in-place refills (theme/style changes destroy only
	// its children), so tear down on the canvas' death as well.
	const teardown = () => {
		instances.delete(instance);
		stop();
		if (settingsSignalId && settings) {
			settings.disconnect(settingsSignalId);
			settingsSignalId = 0;
		}
	};
	canvasActor.connect('destroy', teardown);
	body.connect('destroy', teardown);
}
