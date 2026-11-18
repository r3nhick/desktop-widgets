// Apple-style follow pager shared by paged widgets (right mouse button).
//
// While the button is held the current page follows the pointer and the
// neighbouring page rides right beside it on ONE strip, so both pages are
// visible and move in the same frame. Dragging further than one page keeps
// going: the next neighbour is attached as the strip advances, so 1 → 3 is
// a single gesture. Releasing past the threshold — or a quick flick —
// settles on the page under the pointer; otherwise the strip springs back.
// The widget only says how to build the neighbour and what to do once a
// change is committed or cancelled; the gesture, pointer grab and motion
// live here.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

export const PAGER_THRESHOLD = 30;   // px of drag that commits a change

// Self-calibrating "is the button still held?" check, one per gesture.
// Some GNOME builds (seen on Wayland) report NO button bits at all during a
// pointer grab — neither in the event state nor in global.get_pointer() —
// and a plain bit test then cancelled every gesture on its first motion.
// So the first motion (the button is certainly down there) decides which
// source can be trusted; a source that did not show the bit is ignored,
// and with no trusted source the gesture is never cancelled this way.
export function createHoldWatch(mask) {
    let eventTrusted = null;
    let pointerTrusted = null;
    const read = event => {
        let ev = 0;
        let ptr = 0;
        try {
            ev = event.get_state() ?? 0;
        } catch (_e) {}
        try {
            ptr = global.get_pointer()[2] ?? 0;
        } catch (_e) {}
        return [ev, ptr];
    };
    return {
        // true while the button is (or may be) held
        held(event) {
            if (!mask)
                return true;
            const [ev, ptr] = read(event);
            if (eventTrusted === null) {
                eventTrusted = (ev & mask) !== 0;
                pointerTrusted = (ptr & mask) !== 0;
            }
            if (!eventTrusted && !pointerTrusted)
                return true;
            return (eventTrusted && (ev & mask) !== 0) || (pointerTrusted && (ptr & mask) !== 0);
        },
    };
}

// Kept for callers that only need a one-shot check (always permissive when
// the platform does not report button bits).
export function buttonHeld(event, mask) {
    return createHoldWatch(mask).held(event);
}

export const BUTTON3_MASK = Clutter.ModifierType?.BUTTON3_MASK ?? (1 << 10);
export const BUTTON1_MASK = Clutter.ModifierType?.BUTTON1_MASK ?? (1 << 8);
const FLICK_VELOCITY = 0.5;          // px/ms in the drag direction
// Travel before a gesture is claimed. Only a mostly HORIZONTAL drag is
// claimed here; a vertical one is left to the widget-in-widget stack.
export const CLAIM_PX = 8;
const MIN_SETTLE_MS = 200;
const MAX_SETTLE_MS = 380;

/**
 * @param {Clutter.Actor} target  reactive actor that receives the gesture
 * @param {object} o
 * @param {() => number} o.distance      page width + gap (px)
 * @param {(dir: number) => object|null} o.begin
 *        Build the neighbour for dir (+1 = next, the strip moves left;
 *        -1 = previous). Returns {leaving, entering, ...extra} or null.
 * @param {(pair: object) => void} o.discard        drop a built neighbour
 * @param {(pair: object) => void} o.commit         page change committed
 * @param {(pair: object) => void} o.settledCommit  drop the leaving page
 * @param {(pair: object) => void} o.settledCancel  drop the entering page
 * @param {boolean} [o.multiStep=true]  keep paging past one page width
 * @param {() => boolean} [o.isAlive]
 */
export function attachFollowPager(target, o) {
    const isAlive = o.isAlive ?? (() => true);
    const multiStep = o.multiStep ?? true;
    let drag = null;
    let settling = false;

    const endGrab = () => {
        if (drag?.grab) {
            try {
                drag.grab.dismiss();
            } catch (_e) {}
            drag.grab = null;
        }
    };

    const place = () => {
        if (!drag?.pair)
            return;
        const d = o.distance();
        drag.pair.leaving.translation_x = drag.dx;
        drag.pair.entering.translation_x = drag.dx + (drag.pair.dir > 0 ? d : -d);
    };

    // Settle the strip: commit (if allowed and past the threshold / a
    // flick) or spring back. Also the way out of a broken gesture.
    const finish = (allowCommit) => {
        if (!drag)
            return;
        const {dx, velocity, pair} = drag;
        endGrab();
        drag = null;
        if (!pair || !isAlive())
            return;

        const d = o.distance();
        const flick = Math.abs(velocity) > FLICK_VELOCITY && Math.sign(velocity) === Math.sign(dx);
        const commit = allowCommit && (Math.abs(dx) > PAGER_THRESHOLD || flick);
        const remaining = commit ? d - Math.abs(dx) : Math.abs(dx);
        const duration = Math.round(Math.min(MAX_SETTLE_MS, Math.max(MIN_SETTLE_MS, remaining * 1.1)));
        const mode = Clutter.AnimationMode.EASE_OUT_CUBIC;
        const {leaving, entering} = pair;

        settling = true;
        const done = fn => () => {
            settling = false;
            if (isAlive())
                fn(pair);
        };
        if (commit) {
            o.commit(pair);
            entering.ease({translation_x: 0, duration, mode});
            leaving.ease({translation_x: pair.dir > 0 ? -d : d, duration, mode, onStopped: done(o.settledCommit)});
        } else {
            leaving.ease({translation_x: 0, duration, mode});
            entering.ease({translation_x: pair.dir > 0 ? d : -d, duration, mode, onStopped: done(o.settledCancel)});
        }
    };

    target.reactive = true;
    target.connect('destroy', () => {
        endGrab();
        drag = null;
    });
    // Hidden mid-gesture (workspace switch, overview, rebuild): never keep
    // the pointer grabbed.
    target.connect('notify::mapped', () => {
        if (!target.mapped)
            finish(false);
    });

    target.connect('button-press-event', (_a, event) => {
        // A press while a gesture is still open means its release was lost
        // (swallowed by another grab): close it, then handle this press
        // normally — a new right press starts a fresh gesture.
        if (drag)
            finish(false);
        if (event.get_button() !== 3 || settling)
            return Clutter.EVENT_PROPAGATE;
        const [x] = event.get_coords();
        const [, y] = event.get_coords();
        // No grab yet: the gesture is claimed on the first clearly
        // horizontal motion (see motion-event).
        drag = {startX: x, startY: y, lastX: x, lastTime: GLib.get_monotonic_time() / 1000, velocity: 0, dx: 0, pair: null, grab: null, claimed: false, hold: createHoldWatch(BUTTON3_MASK)};
        return Clutter.EVENT_PROPAGATE;
    });

    target.connect('motion-event', (_a, event) => {
        if (!drag || !isAlive())
            return Clutter.EVENT_PROPAGATE;
        // The release was swallowed by another grab (an app/overview opened
        // mid-gesture): the button is up, so end instead of staying stuck.
        if (!drag.hold.held(event)) {
            finish(false);
            return Clutter.EVENT_PROPAGATE;
        }
        const [x, y] = event.get_coords();
        if (!drag.claimed) {
            const ax = Math.abs(x - drag.startX);
            const ay = Math.abs(y - drag.startY);
            if (ax < CLAIM_PX && ay < CLAIM_PX)
                return Clutter.EVENT_PROPAGATE;
            if (ay >= ax) {
                drag = null; // vertical: not ours (widget-in-widget stack)
                return Clutter.EVENT_PROPAGATE;
            }
            drag.claimed = true;
            drag.startX = x; // follow from here, no jump
            drag.lastX = x;
            try {
                drag.grab = global.stage.grab(target);
            } catch (_e) {}
        }
        const now = GLib.get_monotonic_time() / 1000;
        drag.velocity = (x - drag.lastX) / Math.max(1, now - drag.lastTime);
        drag.lastX = x;
        drag.lastTime = now;
        drag.dx = x - drag.startX;

        // Past a whole page: that page change is done; continue the strip
        // from the new page so the next neighbour gets attached.
        const d = o.distance();
        while (multiStep && drag.pair && Math.abs(drag.dx) >= d) {
            const pair = drag.pair;
            o.commit(pair);
            o.settledCommit(pair);
            pair.entering.translation_x = 0;
            drag.startX += pair.dir > 0 ? -d : d;
            drag.dx = x - drag.startX;
            drag.pair = null;
            if (Math.abs(drag.dx) > 2) {
                const dir = drag.dx < 0 ? 1 : -1;
                const next = o.begin(dir);
                drag.pair = next ? {...next, dir} : null;
            }
        }
        if (!multiStep)
            drag.dx = Math.max(-d, Math.min(d, drag.dx));

        if (Math.abs(drag.dx) > 2) {
            const dir = drag.dx < 0 ? 1 : -1;
            if (!drag.pair || drag.pair.dir !== dir) {
                if (drag.pair)
                    o.discard(drag.pair);
                const pair = o.begin(dir);
                drag.pair = pair ? {...pair, dir} : null;
            }
        }
        place();
        return Clutter.EVENT_STOP;
    });

    target.connect('button-release-event', (_a, event) => {
        if (!drag || event.get_button() !== 3)
            return Clutter.EVENT_PROPAGATE;
        finish(true);
        return Clutter.EVENT_STOP;
    });

    // Escape cancels a gesture in progress.
    target.connect('key-press-event', (_a, event) => {
        if (drag && event.get_key_symbol() === Clutter.KEY_Escape) {
            finish(false);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });
}
