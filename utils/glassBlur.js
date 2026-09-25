import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import { isActorDestroyed } from './actorLifecycle.js';

// Rounds off whatever an actor has already painted.
//
// Shell.BlurEffect in BACKGROUND mode drops a rectangular patch of blurred
// backdrop under the actor, so a widget with rounded corners would sit on a
// square sheet of blurred wallpaper. This is the same signed-distance rounded
// box Mutter uses for its own clips, feathered over a pixel so the edge stays
// antialiased.
const CORNER_SHADER = `
uniform sampler2D tex;
uniform float radius;
uniform float width;
uniform float height;

float corner_coverage(vec2 p, float r) {
    vec2 half_size = vec2(width, height) / 2.;
    vec2 d = abs(p - half_size) - (half_size - vec2(r));
    float dist = length(max(d, vec2(0.))) + min(max(d.x, d.y), 0.) - r;

    return 1. - smoothstep(-.5, .5, dist);
}

void main(void) {
    vec2 uv = cogl_tex_coord_in[0].xy;
    // The backdrop capture reaches past the actor's own edges, so keep the
    // outermost texel from sampling whatever lies outside the widget.
    vec2 edge = vec2(1.) / vec2(width, height);
    vec4 pixel = texture2D(tex, clamp(uv, edge, vec2(1.) - edge));
    float alpha = corner_coverage(uv * vec2(width, height), radius);

    cogl_color_out = vec4(pixel.rgb * alpha, min(alpha, pixel.a));
}
`;

const RoundedCorners = GObject.registerClass(
class RoundedCorners extends Clutter.ShaderEffect {
    constructor() {
        super();

        this._width = 0;
        this._height = 0;
        this._radius = 0;

        this.set_shader_source(CORNER_SHADER);
    }

    get width() {
        return this._width;
    }

    set width(value) {
        this._width = value;
        this._apply();
    }

    get height() {
        return this._height;
    }

    set height(value) {
        this._height = value;
        this._apply();
    }

    get radius() {
        return this._radius;
    }

    set radius(value) {
        this._radius = value;
        this._apply();
    }

    _apply() {
        // An actor that has not been laid out yet has no pixels to mask, and a
        // radius wider than half the shorter side collapses the box into a pill.
        if (this._width <= 0 || this._height <= 0) {
            return;
        };

        const radius = Math.max(0, Math.min(this._radius, this._width / 2, this._height / 2));

        this.set_uniform_value('width', this._width);
        this.set_uniform_value('height', this._height);
        this.set_uniform_value('radius', radius);
    }
});

/**
 * Real backdrop blur for the glass look.
 *
 * St cannot blur what is behind an actor, but the shell can: Shell.BlurEffect
 * in BACKGROUND mode grabs the framebuffer underneath the actor, runs it
 * through Clutter's blur node and paints the result under the actor's own
 * content. Since widgets live in the layout manager's background group, the
 * only thing underneath them is the wallpaper - which is exactly what glass
 * should be showing.
 *
 * The effect re-reads the framebuffer on every frame and cannot be cached, so
 * it is only attached while the blur is actually wanted.
 */
export class GlassBlur {
    /**
     * @param {object} options
     * @param {() => boolean} options.isEnabled whether the glass look is on
     * @param {() => number} options.blur blur radius in logical pixels
     * @param {() => number} options.cornerRadius radius to round the widgets to
     * @param {() => number} options.scaleFactor theme scale factor
     * @param {(key: string, message: string) => void} [options.warn]
     */
    constructor({ isEnabled, blur, cornerRadius, scaleFactor, warn }) {
        this._isEnabled = isEnabled;
        this._blur = blur;
        this._cornerRadius = cornerRadius;
        this._scaleFactor = scaleFactor;
        this._warn = warn;
        this._records = new Map();
    }

    /**
     * Brings every given view in line with the current settings and forgets the
     * ones left out, so callers only have to hand over the eligible widgets.
     *
     * @param {Iterable<{id: string, actor: Clutter.Actor}>} views
     */
    sync(views) {
        const live = new Set();

        for (const view of views) {
            if (!view?.actor) {
                continue;
            };

            live.add(view.id);
            this._syncView(view);
        };

        for (const id of [...this._records.keys()]) {
            if (!live.has(id)) {
                this._detach(id);
            };
        };
    }

    destroy() {
        for (const id of [...this._records.keys()]) {
            this._detach(id);
        };
    }

    _syncView(view) {
        const radius = this._blur();

        // There is no blur radius of zero to fall back on: even a hairline blur
        // still costs a backdrop capture per widget per frame.
        if (!this._isEnabled() || radius <= 0) {
            this._detach(view.id);
            return;
        };

        let record = this._records.get(view.id);

        if (record && record.actor !== view.actor) {
            this._detach(view.id);
            record = null;
        };

        if (!record) {
            record = this._attach(view);
            this._records.set(view.id, record);
        };

        record.blur.radius = radius * this._scaleFactor();

        const { actor } = record;

        record.corners.width = actor.width;
        record.corners.height = actor.height;
        record.corners.radius = this._cornerRadius();
    }

    _attach(view) {
        const { actor } = view;
        const blur = new Shell.BlurEffect({
            mode: Shell.BlurMode.BACKGROUND,
            radius: this._blur() * this._scaleFactor(),
        });
        const corners = new RoundedCorners();

        // Order matters: the mask has to run over the blurred backdrop, not the
        // other way round.
        actor.add_effect(blur);
        actor.add_effect(corners);

        const record = { actor, blur, corners, sizeId: 0 };

        // The mask is drawn in the actor's own pixels, so it has to follow every
        // resize, including the ones the edit-mode size button performs.
        record.sizeId = actor.connect('notify::size', () => {
            if (isActorDestroyed(actor)) {
                return;
            };

            record.corners.width = actor.width;
            record.corners.height = actor.height;
        });

        return record;
    }

    _detach(id) {
        const record = this._records.get(id);

        if (!record) {
            return;
        };

        this._records.delete(id);

        if (isActorDestroyed(record.actor)) {
            return;
        };

        if (record.sizeId) {
            record.actor.disconnect(record.sizeId);
        };

        try {
            record.actor.remove_effect(record.blur);
            record.actor.remove_effect(record.corners);
        } catch (error) {
            this._warn?.('glass-detach-failed', `Failed to remove the glass effect: ${error.message}`);
        };
    }
}
