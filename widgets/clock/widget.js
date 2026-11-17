import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { parseCssColor } from '../../utils/ported.js';

export const type = 'clock';
export const label = 'Clock';
export const stylesheet = 'widgets/clock/stylesheet.css';
export const appIds = ['org.gnome.clocks'];
export const defaultSize = 'small';
export const supportedSizes = ['small', 'large', 'minismall', 'minilarge'];

const CLOCK_RADIUS = 16;
const TICK_INSET = 16;
const DEFAULT_ACCENT = '#db1a1f';

function roundedRectangle(cr, x, y, width, height, radius) {
	const r = Math.min(radius, width / 2, height / 2);

	cr.moveTo(x + r, y);
	cr.lineTo(x + width - r, y);
	cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
	cr.lineTo(x + width, y + height - r);
	cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
	cr.lineTo(x + r, y + height);
	cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
	cr.lineTo(x, y + r);
	cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
	cr.closePath();
};

const AnalogClockFace = GObject.registerClass(
	class AnalogClockFace extends St.DrawingArea {
		_init(theme, smooth = false) {
			super._init({
				x_expand: true,
				y_expand: true,
				x_align: Clutter.ActorAlign.FILL,
				y_align: Clutter.ActorAlign.FILL,
			});

			this._dark = theme?.dark ?? false;
			// Smooth mode (reference clock-analog): the second hand sweeps
			// continuously and repaints every frame; the default approved
			// look keeps the 1s step timer below.
			this._smooth = smooth;
			const accent = parseCssColor(theme?.accent || DEFAULT_ACCENT);
			this._accent = [accent.r, accent.g, accent.b];

			if (this._smooth) {
				this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
				this._timeline.connect('new-frame', () => this.queue_repaint());
				this._repaintTimeoutId = 0;
				// Clutter's map/unmap are vfuncs, not signals — mirror the
				// digital clock ring's notify::mapped handling.
				this.connect('notify::mapped', () => {
					if (!this._timeline)
						return;
					if (this.mapped)
						this._timeline.start();
					else
						this._timeline.stop();
				});
			} else {
				this._timeline = null;
				this._repaintTimeoutId = 0;
				// Tick on the second boundary (a free-running 1000 ms timer
				// lagged the real second by up to ~1 s and drifted) and only
				// while the face is on screen.
				this.connect('notify::mapped', () => this._syncStepTicker());
			}

			this.connect('destroy', this._onDestroy.bind(this));
		};

		_syncStepTicker() {
			if (this._repaintTimeoutId) {
				GLib.Source.remove(this._repaintTimeoutId);
				this._repaintTimeoutId = 0;
			};
			if (!this.mapped)
				return;
			this.queue_repaint();
			this._repaintTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000 - (Date.now() % 1000) + 1, () => {
				this._repaintTimeoutId = 0;
				this._syncStepTicker();
				return GLib.SOURCE_REMOVE;
			});
			GLib.Source.set_name_by_id(this._repaintTimeoutId, '[desktop-widgets] analog clock tick');
		};

		_onDestroy() {
			if (this._repaintTimeoutId) {
				GLib.Source.remove(this._repaintTimeoutId);
				this._repaintTimeoutId = 0;
			};

			if (this._timeline) {
				this._timeline.stop();
				this._timeline = null;
			};
		};

		vfunc_repaint() {
			const cr = this.get_context();
			const [width, height] = this.get_surface_size();

			if (width <= 0 || height <= 0) {
				cr.$dispose();
				return;
			};

			const now = new Date();
			const size = Math.min(width, height);
			const centerX = width / 2;
			const centerY = height / 2;
			const halfEdge = Math.max(1, size / 2 - TICK_INSET);
			const hour = now.getHours() % 12;
			// Smooth mode adds the millisecond fraction like the reference
			// clockAnalog (sec + ms/1000), letting the minute hand follow it.
			const second = now.getSeconds() + (this._smooth ? now.getMilliseconds() / 1000 : 0);
			const minute = now.getMinutes() + second / 60;
			const marks = this._dark ? [0.96, 0.96, 0.96] : [0.14, 0.12, 0.18];
			const hands = this._dark ? [1, 1, 1] : [0.12, 0.11, 0.16];
			const centerDot = this._dark ? [0, 0, 0, 0.95] : [1, 1, 1, 0.95];

			roundedRectangle(cr, 0, 0, width, height, CLOCK_RADIUS);
			cr.clip();
			cr.setLineCap(1);

			// Two strokes (minor, then major marks) instead of 60.
			for (const major of [false, true]) {
				const tickLength = major ? 16 : 8;
				const lineWidth = major ? 2.2 : 1.0;
				for (let tick = major ? 0 : 1; tick < 60; tick += major ? 5 : 1) {
					if (!major && tick % 5 === 0)
						continue;
					const angle = tick / 60 * Math.PI * 2 - Math.PI / 2;
					const dx = Math.cos(angle);
					const dy = Math.sin(angle);
					const edgeDistance = halfEdge / Math.max(Math.abs(dx), Math.abs(dy));
					const outer = edgeDistance + lineWidth;
					const inner = outer - tickLength;

					cr.moveTo(centerX + dx * inner, centerY + dy * inner);
					cr.lineTo(centerX + dx * outer, centerY + dy * outer);
				};
				cr.setLineWidth(lineWidth);
				cr.setSourceRGBA(...marks, major ? 0.54 : 0.26);
				cr.stroke();
			};

			const drawHand = (angle, length, width, red, green, blue, alpha = 1) => {
				cr.moveTo(centerX, centerY);
				cr.lineTo(centerX + Math.cos(angle) * length, centerY + Math.sin(angle) * length);
				cr.setLineWidth(width);
				cr.setSourceRGBA(red, green, blue, alpha);
				cr.stroke();
			};

			const hourAngle = ((hour + minute / 60) / 12) * Math.PI * 2 - Math.PI / 2;
			const minuteAngle = (minute / 60) * Math.PI * 2 - Math.PI / 2;
			const secondAngle = (second / 60) * Math.PI * 2 - Math.PI / 2;

			drawHand(hourAngle, halfEdge * 0.48, 6.2, ...hands);
			drawHand(minuteAngle, halfEdge * 0.70, 4.0, ...hands);
			drawHand(secondAngle, halfEdge * 0.74, 1.8, ...this._accent, 0.92);

			cr.arc(centerX, centerY, 5.2, 0, Math.PI * 2);
			cr.setSourceRGBA(...this._accent, 1);
			cr.fill();
			cr.arc(centerX, centerY, 2.2, 0, Math.PI * 2);
			cr.setSourceRGBA(...centerDot);
			cr.fill();
			cr.$dispose();
		};
	}
);

export function style(theme) {
  return `background-color: ${theme.background}; border-color: ${theme.border}; border-radius: ${CLOCK_RADIUS}px; padding: 0px;`;
};

export function render({body, theme, settings}) {
	const clock = new AnalogClockFace(
		theme,
		settings?.get_boolean('clock-smooth-seconds') === true,
	);

	clock.set_x_expand(true);
	clock.set_y_expand(true);
	body.add_child(clock);
};
