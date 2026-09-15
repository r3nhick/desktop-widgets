import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

export const type = 'binaryclock';
export const label = 'Binary Clock';
export const stylesheet = 'widgets/binaryclock/stylesheet.css';
export const defaultSize = 'mini';
export const supportedSizes = ['mini', 'small', 'medium'];

const ROWS = 4;
const BIT_COUNTS = [2, 4, 3, 4, 3, 4];
const CORNER_RADIUS = 16;
const WITHIN_GAP_RATIO = 0.16;
const BETWEEN_GAP_RATIO = 0.55;
const EDGE_GAP_RATIO = 0.18;

function clockDigits() {
	const now = new Date();
	const hours = now.getHours();
	const minutes = now.getMinutes();
	const seconds = now.getSeconds();

	return [
		Math.floor(hours / 10),
		hours % 10,
		Math.floor(minutes / 10),
		minutes % 10,
		Math.floor(seconds / 10),
		seconds % 10,
	];
};

const BinaryClockFace = GObject.registerClass(
	class BinaryClockFace extends St.DrawingArea {
		_init(theme) {
			super._init({
				x_expand: true,
				y_expand: true,
				x_align: Clutter.ActorAlign.FILL,
				y_align: Clutter.ActorAlign.FILL,
			});

			this._dark = theme?.dark ?? false;
			this._active = this._dark ? [1, 1, 1, 1] : [0.14, 0.12, 0.18, 1];
			this._inactive = this._dark ? [1, 1, 1, 0.2] : [0, 0, 0, 0.1];

			this._scheduleRepaint();
			this.connect('destroy', this._onDestroy.bind(this));
			this.connect('notify::width', this._onSizeChange.bind(this));
			this.connect('notify::height', this._onSizeChange.bind(this));
		};

		_onSizeChange() {
			this.queue_repaint();
		};

		_onDestroy() {
			if (this._repaintTimeoutId) {
				GLib.Source.remove(this._repaintTimeoutId);
				this._repaintTimeoutId = 0;
			};
		};

		_scheduleRepaint() {
			const delay = 1000 - (Date.now() % 1000);

			this._repaintTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
				this._repaintTimeoutId = 0;

				if (!this.get_parent()) {
					return GLib.SOURCE_REMOVE;
				};

				this.queue_repaint();
				this._scheduleRepaint();
				return GLib.SOURCE_REMOVE;
			});

			GLib.Source.set_name_by_id(this._repaintTimeoutId, '[widgets] binary clock repaint');
		};

		vfunc_repaint() {
			const cr = this.get_context();
			const [width, height] = this.get_surface_size();

			if (width <= 0 || height <= 0) {
				cr.$dispose();
				return;
			};

			const digits = clockDigits();
			const margin = Math.min(4, Math.min(width, height) * 0.03);
			const availableWidth = Math.max(10, width - margin * 2);
			const availableHeight = Math.max(10, height - margin * 2);
			const cols = BIT_COUNTS.length;
			const pairs = Math.ceil(cols / 2);
			const colUnits = cols + (cols - pairs) * WITHIN_GAP_RATIO + (pairs - 1) * BETWEEN_GAP_RATIO + 2 * EDGE_GAP_RATIO;
			const rowUnits = ROWS + (ROWS - 1) * WITHIN_GAP_RATIO + 2 * EDGE_GAP_RATIO;
			const dotSize = Math.max(2, Math.min(
				availableWidth / colUnits,
				availableHeight / rowUnits));
			const withinGap = dotSize * WITHIN_GAP_RATIO;
			const betweenGap = dotSize * BETWEEN_GAP_RATIO;
			const edgeGap = dotSize * EDGE_GAP_RATIO;
			const colGaps = [];

			for (let column = 0; column < cols - 1; column++) {
				colGaps.push(column % 2 === 0 ? withinGap : betweenGap);
			};

			const baseGridWidth = cols * dotSize + colGaps.reduce((sum, gap) => sum + gap, 0) + edgeGap * 2;
			const colStretch = (cols + 1) > 0 ? Math.max(0, availableWidth - baseGridWidth) / (cols + 1) : 0;
			const edge = edgeGap + colStretch;
			const baseGridHeight = ROWS * dotSize + (ROWS - 1) * withinGap + edgeGap * 2;
			const rowStretch = (ROWS + 1) > 0 ? Math.max(0, availableHeight - baseGridHeight) / (ROWS + 1) : 0;
			const rowGap = withinGap + rowStretch;
			const rowEdge = edgeGap + rowStretch;
			const radius = dotSize / 2 - 0.6;
			const positions = [];
			let cursor = edge;

			for (let column = 0; column < cols; column++) {
				positions.push(cursor + dotSize / 2);

				if (column < cols - 1) {
					cursor += dotSize + colGaps[column] + colStretch;
				};
			};

			for (let column = 0; column < cols; column++) {
				const bitCount = BIT_COUNTS[column];
				const value = digits[column];
				const x = positions[column];

				for (let row = 0; row < ROWS; row++) {
					const y = rowEdge + (ROWS - 1 - row) * (dotSize + rowGap) + dotSize / 2;
					const lit = row < bitCount && ((value >> row) & 1) === 1;
					const color = lit ? this._active : this._inactive;

					cr.arc(x, y, radius, 0, Math.PI * 2);
					cr.setSourceRGBA(color[0], color[1], color[2], color[3]);
					cr.fill();
				};
			};

			cr.$dispose();
		};
	}
);

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border}; border-radius: ${CORNER_RADIUS}px; padding: 8px;`;
};

export function render({body, theme}) {
	const clock = new BinaryClockFace(theme);

	clock.set_x_expand(true);
	clock.set_y_expand(true);
	body.add_child(clock);
};