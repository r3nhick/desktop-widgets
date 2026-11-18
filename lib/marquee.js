// Apple Music–style marquee for a single-line St.Label.
//
// When the text does not fit, it rests for a moment, then glides left; a
// copy of the text follows after a gap, so the loop is seamless (the copy
// arrives exactly where the text started). Then it rests again. Text that
// fits stays still. Animation runs only while the label is on screen.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

/**
 * Wraps `label` into a clipping marquee. Insert the returned `actor` where
 * the label used to go; keep setting `label.text` as before.
 * @param {St.Label} label
 * @param {object} [opts]
 * @param {number} [opts.gap=36]     px between the text and its copy
 * @param {number} [opts.speed=32]   px per second
 * @param {number} [opts.pause=2200] ms of rest before each pass
 * @param {boolean} [opts.expand=true] take all free width (false: natural
 *        width, so something placed after the text stays right after it)
 */
export function createMarquee(label, {gap = 36, speed = 32, pause = 2200, expand = true} = {}) {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    label.x_expand = false;

    const copy = new St.Label({
        text: label.text,
        style_class: label.style_class ?? '',
        style: label.get_style() ?? '',
        visible: false,
    });
    copy.clutter_text.single_line_mode = true;
    copy.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

    const track = new St.BoxLayout({style: `spacing: ${gap}px;`});
    track.add_child(label);
    track.add_child(copy);

    // Fixed layout: the track keeps its natural width (wider than the clip
    // when the text overflows); min width 0 lets the row squeeze the clip.
    const actor = new St.Widget({clip_to_allocation: true, x_expand: expand});
    actor.min_width = 0;
    actor.add_child(track);

    let timerId = 0;
    let running = false;
    let alive = true;

    const textWidth = () => label.get_preferred_width(-1)[1];
    const overflows = () => actor.has_allocation() && textWidth() > actor.width + 0.5;

    const stop = () => {
        running = false; // first: a removed ease must not schedule a pass
        if (timerId) {
            GLib.source_remove(timerId);
            timerId = 0;
        }
        track.remove_all_transitions();
        track.translation_x = 0;
    };

    const pass = () => {
        timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, pause, () => {
            timerId = 0;
            if (!alive || !actor.mapped || !overflows()) {
                stop();
                return GLib.SOURCE_REMOVE;
            }
            const distance = textWidth() + gap;
            track.ease({
                translation_x: -distance,
                duration: Math.round(distance / speed * 1000),
                mode: Clutter.AnimationMode.LINEAR,
                onComplete: () => {
                    if (!alive || !running)
                        return;
                    // The copy now sits where the text began: jump back
                    // invisibly and rest before the next pass.
                    track.translation_x = 0;
                    pass();
                },
            });
            return GLib.SOURCE_REMOVE;
        });
    };

    const sync = () => {
        if (!alive)
            return;
        const scroll = overflows();
        copy.visible = scroll;
        if (!scroll || !actor.mapped) {
            if (running)
                stop();
            return;
        }
        if (!running) {
            running = true;
            pass();
        }
    };

    label.connect('notify::text', () => {
        copy.text = label.text;
        stop(); // new text starts from rest
        sync();
    });
    label.connect('notify::style', () => copy.set_style(label.get_style()));
    actor.connect('notify::allocation', () => sync());
    actor.connect('notify::mapped', () => sync());
    actor.connect('destroy', () => {
        alive = false;
        stop();
    });

    return {actor, sync, stop};
}
