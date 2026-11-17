import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

// Click squash-and-spring on a plain St.Button — the music widget's bounce
// (0.8 squish in, springy overshoot out), shared by the interactive widgets
// (task, stopwatch, timer, pomodoro) so every press feels the same.
export function bounceButton(button) {
	button.set_pivot_point(0.5, 0.5);
	button.remove_transition('scale-x');
	button.remove_transition('scale-y');
	button.ease({
		scale_x: 0.8,
		scale_y: 0.8,
		duration: 90,
		mode: Clutter.AnimationMode.EASE_IN_QUAD,
		onComplete: () => button.ease({
			scale_x: 1,
			scale_y: 1,
			duration: 260,
			mode: Clutter.AnimationMode.EASE_OUT_BACK,
		}),
	});
};

// Hover feedback shared by every widget's buttons (music was first): no
// hover frame or wash — the button briefly eases down to 85% and back to
// full size on leave. Enter/leave only write scale_x/y, so they never fight
// the click bounce: whichever ease runs last owns the transitions.
//
// Hover is decided against the button's UNSCALED footprint. Shrinking the
// actor moves its hit-area edges inward (by 7.5% per side — ~30px on a full
// card such as the photo picker), so a pointer resting near the edge fell
// outside → leave → restore → inside again → enter → shrink… and the button
// pulsed forever. A leave that lands inside the unscaled footprint is now
// ignored; the pointer is polled until it really exits that footprint.
// (Polling, not stage events: over a window the shell gets no motion.)
const HOVER_SCALE = 0.85;
const HOVER_POLL_MS = 60;

export function bindHoverShrink(button) {
	button.set_pivot_point(0.5, 0.5);
	let hovering = false;
	let pollId = 0;

	const stopPoll = () => {
		if (pollId) {
			GLib.source_remove(pollId);
			pollId = 0;
		}
	};

	const easeTo = (scale, duration) => {
		button.remove_transition('scale-x');
		button.remove_transition('scale-y');
		button.ease({
			scale_x: scale,
			scale_y: scale,
			duration,
			mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
		});
	};

	// Is the pointer inside the footprint the button has at scale 1?
	const pointerInFootprint = () => {
		if (!button.mapped)
			return false;
		const [x, y] = button.get_transformed_position();
		const [w, h] = button.get_transformed_size();
		const sx = button.scale_x || 1;
		const sy = button.scale_y || 1;
		if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0)
			return false;
		const cx = x + w / 2;
		const cy = y + h / 2;
		const halfW = w / sx / 2;
		const halfH = h / sy / 2;
		const [px, py] = global.get_pointer();
		return px >= cx - halfW && px < cx + halfW && py >= cy - halfH && py < cy + halfH;
	};

	const release = () => {
		stopPoll();
		if (!hovering)
			return;
		hovering = false;
		easeTo(1, 150);
	};

	button.connect('destroy', () => stopPoll());
	button.connect('notify::mapped', () => {
		if (button.mapped)
			return;
		// Hidden mid-hover (page swipe, rebuild): never keep it shrunk.
		stopPoll();
		hovering = false;
		button.remove_transition('scale-x');
		button.remove_transition('scale-y');
		button.set_scale(1, 1);
	});

	button.connect('enter-event', () => {
		stopPoll();
		if (hovering)
			return Clutter.EVENT_PROPAGATE;
		hovering = true;
		easeTo(HOVER_SCALE, 120);
		return Clutter.EVENT_PROPAGATE;
	});

	button.connect('leave-event', (_, event) => {
		// Pointer moved onto a child actor — it never left the button.
		const related = event.get_related();
		if (related && button.contains(related))
			return Clutter.EVENT_PROPAGATE;
		if (!hovering)
			return Clutter.EVENT_PROPAGATE;

		if (!pointerInFootprint()) {
			release();
			return Clutter.EVENT_PROPAGATE;
		}

		// Only the shrunk hit-area moved away from the pointer: stay
		// shrunk until the pointer leaves the full-size footprint.
		if (!pollId) {
			pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_POLL_MS, () => {
				if (pointerInFootprint())
					return GLib.SOURCE_CONTINUE;
				pollId = 0;
				release();
				return GLib.SOURCE_REMOVE;
			});
		}
		return Clutter.EVENT_PROPAGATE;
	});
};

// Pivots the button at its center so the scale animations grow from the
// middle, hooks the hover shrink and plays the bounce on every click.
// Returns the handler id.
export function attachBounce(button) {
	button.set_pivot_point(0.5, 0.5);
	bindHoverShrink(button);
	return button.connect('clicked', () => bounceButton(button));
};
