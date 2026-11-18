// Liquid-glass backdrop for GNOME Shell. Port of the liquidglass-widgets
// lib/glass.js + shaders/liquidglass.frag.
//
// Actor tree:
//   LiquidGlass            clip_to_allocation, LiquidGlassEffect (refraction,
//   │                      chroma, tint, specular, squircle mask)
//   └─ _blurBox            widget size + BLUR_PAD on each side, Shell.BlurEffect
//      └─ _wallpaper       offset so the monitor's wallpaper lines up with
//         └─ Meta.BackgroundActor   the screen (own BackgroundManager, so it
//                                   follows wallpaper changes by itself)
//
// _blurBox is larger than the widget so the blur has real pixels to pull in
// at the edges instead of fading to transparent; LiquidGlass clips it back
// to the widget, so the effect samples a texture that maps 1:1 to the widget.
//
// Unlike the KDE version, nothing here is polled: the widget calls
// setGeometry() whenever it moves or resizes, and Clutter's offscreen
// effects cache their result until a child actually changes.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const BLUR_PAD = 48;
// The KDE blur is a Dual Kawase pyramid whose reach roughly doubles per
// level; Shell.BlurEffect takes a Gaussian radius. This keeps the default
// (6) close to the KDE look.
export const BLUR_RADIUS_SCALE = 3;
export const MAX_BLUR_RADIUS = 200;

const UNIFORMS = [
    'size', 'radius', 'roundness', 'refractThickness', 'refractIOR',
    'refractScale', 'chromaStrength', 'tint', 'tintBottom', 'mousePos',
    'mouseFade', 'specStrength', 'frame',
];

// Where an actor sits inside its offscreen effect's texture, as normalized
// [x, y, width, height]. Mutter pads effect framebuffers (see
// clutter_actor_box_enlarge_for_effects): the size is rounded and grows by
// 3 px, with the far edge pushed out by 0.75 px and rounded up, so an
// integer-placed actor gets 2 px of padding before it and 1 px after.
// Sampling the texture as if it were exactly the actor reads that empty
// padding at the edges.
export function effectFrame(x, y, width, height) {
    const axis = (start, size) => {
        const padded = Math.round(size) + 3;
        const paddedStart = Math.ceil(start + size + 0.75) - padded;
        return [(start - paddedStart) / padded, size / padded];
    };
    const [fx, fw] = axis(x, width);
    const [fy, fh] = axis(y, height);
    return [fx, fy, fw, fh];
}

// Same math as liquidglass.frag, rewritten for a Cogl snippet: uniforms are
// prefixed lg_ to stay clear of Cogl's names, and the texture is passed in
// as a parameter because only the snippet body can name cogl_sampler0.
const DECLARATIONS = `
uniform vec2  lg_size;
uniform float lg_radius;
uniform float lg_roundness;
uniform float lg_refractThickness;
uniform float lg_refractIOR;
uniform float lg_refractScale;
uniform float lg_chromaStrength;
uniform vec4  lg_tint;
uniform vec4  lg_tintBottom;  // a > 0: vertical gradient from lg_tint to this
uniform vec2  lg_mousePos;
uniform float lg_mouseFade;
uniform float lg_specStrength;
uniform vec4  lg_frame;  // the actor's rect in the effect texture (effectFrame)

// Squircle SDF with analytic outward normal: vec3(d, nx, ny).
vec3 lg_sdfAndNormal(vec2 p) {
    vec2 b = lg_size * 0.5;
    float n = max(lg_roundness, 2.0);
    float r = clamp(lg_radius, 0.0, min(b.x, b.y));

    vec2 q = abs(p) - b + vec2(r);
    float qx = max(q.x, 0.0);
    float qy = max(q.y, 0.0);

    float d;
    vec2 nrm;

    if (qx <= 0.0 && qy <= 0.0) {
        d = max(q.x, q.y) - r;
        nrm = q.x >= q.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    } else if (qx == 0.0) {
        d = qy - r;
        nrm = vec2(0.0, 1.0);
    } else if (qy == 0.0) {
        d = qx - r;
        nrm = vec2(1.0, 0.0);
    } else {
        float arc = pow(pow(qx, n) + pow(qy, n), 1.0 / n);
        float gx = pow(qx / arc, n - 1.0);
        float gy = pow(qy / arc, n - 1.0);
        float gradLen = sqrt(gx * gx + gy * gy);
        d = (arc - r) / max(gradLen, 1e-3);
        nrm = vec2(gx, gy) / max(gradLen, 1e-3);
    }

    nrm *= sign(p + vec2(1e-20));
    return vec3(d, nrm);
}

// uv is actor-relative; stay half a texel inside the actor's own pixels.
vec3 lg_sample(sampler2D tex, vec2 uv) {
    vec2 inset = 0.5 / lg_size;
    return texture2D(tex, lg_frame.xy + clamp(uv, inset, vec2(1.0) - inset) * lg_frame.zw).rgb;
}

vec3 lg_cornerSpec(vec2 p, float depthPx) {
    if (lg_specStrength <= 0.0)
        return vec3(0.0);

    vec2 b = lg_size * 0.5;
    vec2 restLight = vec2(-b.x, b.y) * 1.2;
    bool hovering = lg_mouseFade > 0.0 && lg_mousePos.x >= 0.0 && lg_mousePos.y >= 0.0;
    vec2 cursorPx = (lg_mousePos - vec2(0.5)) * lg_size;
    vec2 lightPx = hovering ? mix(restLight, cursorPx, lg_mouseFade) : restLight;
    vec2 antiLight = -lightPx;

    float taper = max(lg_size.x, lg_size.y) * 0.7;
    float primaryAtt = exp(-distance(p, lightPx) / taper);
    float secondaryAtt = exp(-distance(p, antiLight) / taper) * 0.65;

    float tPx = max(primaryAtt, secondaryAtt) * 3.0;
    float stroke = 1.0 - smoothstep(tPx - 2.0, tPx, depthPx);
    return vec3(1.0, 0.98, 0.94) * (stroke * lg_specStrength * 0.55);
}

vec3 lg_edgeSpec(vec2 ndir, float depthPx) {
    if (lg_specStrength <= 0.0)
        return vec3(0.0);

    float lip = 1.0 - smoothstep(0.0, 3.0, max(depthPx, 0.0));
    vec2 lightDir = normalize(vec2(-0.45, 0.90));
    float facing = 0.35 + 0.65 * clamp(dot(ndir, lightDir) * 0.5 + 0.5, 0.0, 1.0);
    return vec3(1.0, 0.98, 0.94) * (lip * facing * lg_specStrength * 0.10);
}

vec4 lg_glass(sampler2D tex, vec2 uv) {
    vec2 p = (uv - vec2(0.5)) * lg_size;
    vec3 dn = lg_sdfAndNormal(p);
    float d = dn.x;
    vec2 ndir = dn.yz;

    if (d > 1.5)
        return vec4(0.0);

    float depthPx = -d;
    vec3 col;

    if (lg_refractThickness <= 0.0 || depthPx >= lg_refractThickness) {
        col = lg_sample(tex, uv);
    } else {
        // Snell on a dome across the edge band.
        float t = clamp(depthPx / lg_refractThickness, 0.0, 1.0);
        float sinThetaI = (1.0 - t) * (1.0 - t);
        float thetaI = asin(clamp(sinThetaI, 0.0, 1.0));
        float thetaT = asin(clamp(sinThetaI / lg_refractIOR, 0.0, 1.0));
        float edgeMag = tan(thetaI - thetaT);

        vec2 displaceUV = -ndir * edgeMag * lg_refractScale / lg_size;
        float chromaPx = lg_chromaStrength * lg_refractThickness * 0.35 * (1.0 - t);
        vec2 chromaUV = -ndir * chromaPx / lg_size;

        col.r = lg_sample(tex, uv + displaceUV + chromaUV).r;
        col.g = lg_sample(tex, uv + displaceUV).g;
        col.b = lg_sample(tex, uv + displaceUV - chromaUV).b;
    }

    vec3 tintColor = mix(lg_tint.rgb, lg_tintBottom.rgb, lg_tintBottom.a > 0.0 ? uv.y : 0.0);
    col = mix(col, tintColor, lg_tint.a);
    col += lg_edgeSpec(ndir, depthPx);
    col += lg_cornerSpec(p, depthPx);

    // ~1px AA feather on the silhouette; output is premultiplied.
    float mask = 1.0 - smoothstep(-0.5, 0.5, d);
    return vec4(col * mask, mask);
}
`;

// Full shader source, split into declarations and a fragment snippet below.
const SHADER_SOURCE = DECLARATIONS + `
void main() {
    cogl_color_out = lg_glass(cogl_sampler0, (cogl_tex_coord_in[0].xy - lg_frame.xy) / lg_frame.zw) *
        cogl_color_in.a;
}
`;

function splitFragmentShader(source) {
    const mainMatch = source.match(/void\s+main\s*\(\s*\)\s*\{/);
    if (!mainMatch)
        return null;

    const mainIndex = source.indexOf(mainMatch[0]);
    const declarations = source.slice(0, mainIndex).trim();
    const braceIndex = source.indexOf('{', mainIndex);
    
    let depth = 0;
    for (let i = braceIndex; i < source.length; i++) {
        if (source[i] === '{')
            depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) {
                return {
                    declarations,
                    body: source.slice(braceIndex + 1, i).trim(),
                };
            }
        }
    }
    return null;
}

function createFragmentShaderSnippet(source) {
    if (!Cogl || !source)
        return null;

    const parts = splitFragmentShader(source);
    if (!parts) {
        console.warn('[desktop-widgets glass] could not split shader source');
        return null;
    }

    try {
        const snippet = Cogl.Snippet.new(
            Cogl.SnippetHook.FRAGMENT,
            parts.declarations,
            null
        );
        snippet.set_replace(parts.body);
        return snippet;
    } catch (e) {
        console.warn(`[desktop-widgets glass] could not create shader snippet: ${e}`);
        return null;
    }
}

const USES_SHADER_SNIPPET_API =
    typeof Clutter?.ShaderEffect?.new_with_snippet === 'function';

// Primary path: EXACTLY the original registration (vfunc declared in the
// class body). It is what renders the rounded glass on GNOME builds that
// have ClutterShaderEffect::get_static_snippet.
function defineLiquidGlassEffect() {
    return GObject.registerClass(
        // Explicit GTypeName: the automatic one is derived from the module
        // path and would collide with other extensions that also ship a
        // lib/glass.js (e.g. liquidglass-widgets).
        {GTypeName: 'DesktopWidgets_LiquidGlassEffectV3'},
        class LiquidGlassEffect extends Clutter.ShaderEffect {
            _init() {
                super._init();
                if (!USES_SHADER_SNIPPET_API) {
                    try {
                        this.set_shader_source(SHADER_SOURCE);
                    } catch (e) {
                        console.warn(`[desktop-widgets glass] set_shader_source failed: ${e}`);
                    }
                }
            }

            vfunc_get_static_snippet() {
                if (!USES_SHADER_SNIPPET_API)
                    return null;
                return createFragmentShaderSnippet(SHADER_SOURCE);
            }

            setUniform(name, values) {
                const count = Array.isArray(values) ? values.length : 1;
                const arr = Array.isArray(values) ? values : [values];
                try {
                    this.set_uniform_float(`lg_${name}`, count, arr);
                } catch (e) {
                    console.warn(`[desktop-widgets glass] set_uniform_float failed for lg_${name}:`, e);
                }
            }
        }
    );
}

// Fallback ONLY for Clutter builds without the get_static_snippet vfunc
// (e.g. GNOME 50 on Ubuntu 26.04): there the primary registration throws
// "Could not find definition of virtual function get_static_snippet" and
// the whole extension failed to load. Same shader, attached without the
// vfunc; a separate GType name because the failed attempt may have
// claimed the first one.
function defineLiquidGlassEffectCompat() {
    return GObject.registerClass(
        {GTypeName: 'DesktopWidgets_LiquidGlassEffectV3Compat'},
        class LiquidGlassEffectCompat extends Clutter.ShaderEffect {
            _init() {
                super._init();
                try {
                    if (typeof this.set_shader_source === 'function') {
                        this.set_shader_source(SHADER_SOURCE);
                        return;
                    }
                    const snippet = createFragmentShaderSnippet(SHADER_SOURCE);
                    const pipeline = snippet ? this.get_pipeline?.() : null;
                    pipeline?.add_snippet(snippet);
                } catch (e) {
                    console.warn(`[desktop-widgets glass] could not attach the glass shader: ${e}`);
                }
            }

            setUniform(name, values) {
                const count = Array.isArray(values) ? values.length : 1;
                const arr = Array.isArray(values) ? values : [values];
                try {
                    this.set_uniform_float(`lg_${name}`, count, arr);
                } catch (e) {
                    console.warn(`[desktop-widgets glass] set_uniform_float failed for lg_${name}:`, e);
                }
            }
        }
    );
}

// Register the effect class only once, store in globalThis to survive reloads
// V3: a fresh key, so an enable/disable cycle cannot reuse a class cached by
// an earlier build in this shell session.
const EFFECT_CLASS_KEY = 'DesktopWidgets_LiquidGlassEffectV3';
if (!globalThis[EFFECT_CLASS_KEY]) {
    try {
        globalThis[EFFECT_CLASS_KEY] = defineLiquidGlassEffect();
    } catch (e) {
        console.warn(`[desktop-widgets glass] get_static_snippet vfunc unavailable, using fallback: ${e}`);
        globalThis[EFFECT_CLASS_KEY] = defineLiquidGlassEffectCompat();
    }
}
const LiquidGlassEffect = globalThis[EFFECT_CLASS_KEY];

// ── Rounded clip ─────────────────────────────────────────────────────────
// clip_to_allocation clips to a RECTANGLE, so anything sliding inside a
// widget (widget-in-widget page flights) showed square corners at the
// widget's edge. This effect masks the actor it is attached to with a
// rounded rect of the widget's own border-radius (1 px AA feather).
// Used only while a page flight runs, so idle rendering is untouched.
const CLIP_SHADER_SOURCE = `
uniform vec2  rc_size;
uniform float rc_radius;
uniform vec4  rc_frame;

void main() {
    vec2 uv = (cogl_tex_coord_in[0].xy - rc_frame.xy) / rc_frame.zw;
    vec2 b = rc_size * 0.5;
    vec2 p = uv * rc_size - b;
    float r = clamp(rc_radius, 0.0, min(b.x, b.y));
    vec2 q = abs(p) - b + vec2(r);
    float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
    float m = 1.0 - smoothstep(-0.5, 0.5, d);
    cogl_color_out = texture2D(cogl_sampler0, cogl_tex_coord_in[0].xy) * (m * cogl_color_in.a);
}
`;

function clipSetUniform(effect, name, values) {
    try {
        effect.set_uniform_float(`rc_${name}`, values.length, values);
    } catch (e) {
        console.warn(`[desktop-widgets glass] rounded clip uniform rc_${name} failed: ${e}`);
    }
}

function clipSetRect(effect, x, y, width, height, radius) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    clipSetUniform(effect, 'size', [w, h]);
    clipSetUniform(effect, 'radius', [Math.max(0, radius)]);
    clipSetUniform(effect, 'frame', effectFrame(x, y, w, h));
    effect.queue_repaint();
}

function defineRoundedClipEffect() {
    return GObject.registerClass(
        {GTypeName: 'DesktopWidgets_RoundedClipEffectV1'},
        class RoundedClipEffect extends Clutter.ShaderEffect {
            _init() {
                super._init();
                if (!USES_SHADER_SNIPPET_API) {
                    try {
                        this.set_shader_source(CLIP_SHADER_SOURCE);
                    } catch (e) {
                        console.warn(`[desktop-widgets glass] rounded clip shader failed: ${e}`);
                    }
                }
            }

            vfunc_get_static_snippet() {
                if (!USES_SHADER_SNIPPET_API)
                    return null;
                return createFragmentShaderSnippet(CLIP_SHADER_SOURCE);
            }

            // x, y: the actor's stage position; width/height: its size.
            setRect(x, y, width, height, radius) {
                clipSetRect(this, x, y, width, height, radius);
            }
        }
    );
}

function defineRoundedClipEffectCompat() {
    return GObject.registerClass(
        {GTypeName: 'DesktopWidgets_RoundedClipEffectV1Compat'},
        class RoundedClipEffectCompat extends Clutter.ShaderEffect {
            _init() {
                super._init();
                try {
                    if (typeof this.set_shader_source === 'function') {
                        this.set_shader_source(CLIP_SHADER_SOURCE);
                        return;
                    }
                    const snippet = createFragmentShaderSnippet(CLIP_SHADER_SOURCE);
                    const pipeline = snippet ? this.get_pipeline?.() : null;
                    pipeline?.add_snippet(snippet);
                } catch (e) {
                    console.warn(`[desktop-widgets glass] could not attach the rounded clip shader: ${e}`);
                }
            }

            setRect(x, y, width, height, radius) {
                clipSetRect(this, x, y, width, height, radius);
            }
        }
    );
}

const CLIP_CLASS_KEY = 'DesktopWidgets_RoundedClipEffectV1';
if (!globalThis[CLIP_CLASS_KEY]) {
    try {
        globalThis[CLIP_CLASS_KEY] = defineRoundedClipEffect();
    } catch (_e) {
        try {
            globalThis[CLIP_CLASS_KEY] = defineRoundedClipEffectCompat();
        } catch (e) {
            console.warn(`[desktop-widgets glass] rounded clip unavailable: ${e}`);
            globalThis[CLIP_CLASS_KEY] = null;
        }
    }
}
export const RoundedClipEffect = globalThis[CLIP_CLASS_KEY];

export function monitorIndexAt(x, y) {
    const {monitors, primaryIndex} = Main.layoutManager;
    const index = monitors.findIndex(m =>
        x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
    return index >= 0 ? index : primaryIndex;
}

// Register the LiquidGlass class only once, store in globalThis to survive reloads
const GLASS_CLASS_KEY = 'DesktopWidgets_LiquidGlassV3';
if (!globalThis[GLASS_CLASS_KEY]) {
    globalThis[GLASS_CLASS_KEY] = GObject.registerClass(
        // Same as the effect class: collision-proof GType name.
        {GTypeName: 'DesktopWidgets_LiquidGlassV3'},
        class LiquidGlass extends St.Widget {
            _init() {
                super._init({clip_to_allocation: true, style: 'background-color: transparent;'});

                this._effect = new LiquidGlassEffect();
                this.add_effect(this._effect);

                this._blurEffect = new Shell.BlurEffect({
                    mode: Shell.BlurMode.ACTOR,
                    brightness: 1.0,
                    radius: 6 * BLUR_RADIUS_SCALE,
                });
                this._blurBox = new St.Widget({clip_to_allocation: true, style: 'background-color: transparent;'});
                this._blurBox.add_effect(this._blurEffect);
                this.add_child(this._blurBox);

                this._wallpaper = new St.Widget({style: 'background-color: transparent;'});
                this._blurBox.add_child(this._wallpaper);

        this._bgManager = null;
        this._monitorIndex = -1;
        this._screenX = 0;
        this._screenY = 0;
        this._width = 1;
        this._height = 1;

        this.setPointer(-1, -1, 0);

        Main.layoutManager.connectObject('monitors-changed', () => {
            // Monitor indices may now point elsewhere; rebuild the wallpaper.
            this._monitorIndex = -1;
            this._syncWallpaper();
        }, this);

        this.connect('destroy', () => {
            this._bgManager?.destroy();
            this._bgManager = null;
        });
    }

    // Screen position and size of the widget, in stage (logical) pixels.
    setGeometry(x, y, width, height) {
        this._screenX = x;
        this._screenY = y;
        this._width = Math.max(1, width);
        this._height = Math.max(1, height);

        this.set_size(this._width, this._height);
        this._blurBox.set_position(-BLUR_PAD, -BLUR_PAD);
        this._blurBox.set_size(this._width + 2 * BLUR_PAD, this._height + 2 * BLUR_PAD);
        this._syncWallpaper();

        this._effect.setUniform('size', [this._width, this._height]);
        this._effect.setUniform('frame', effectFrame(x, y, this._width, this._height));
        this._effect.queue_repaint();
    }

    // p: {radius, roundness, refractThickness, refractIOR, refractScale,
    //     chromaStrength, tint, tintAlpha, specStrength, blurRadius,
    //     solid, solidColor, solidColorBottom (optional: gradient to it)}
    setParams(p) {
        const e = this._effect;
        e.setUniform('radius', [p.radius]);
        e.setUniform('roundness', [p.roundness]);
        e.setUniform('refractIOR', [p.refractIOR]);
        e.setUniform('specStrength', [p.specStrength]);

        // Update CSS border-radius for rounded corner clipping
        if (p.radius > 0) {
            this.set_style(`border-radius: ${p.radius}px; overflow: hidden; background-color: transparent;`);
        }

        // Solid: an opaque squircle with the same silhouette and specular,
        // no refraction and no wallpaper behind it.
        e.setUniform('refractThickness', [p.solid ? 0 : p.refractThickness]);
        e.setUniform('refractScale', [p.solid ? 0 : p.refractScale]);
        e.setUniform('chromaStrength', [p.solid ? 0 : p.chromaStrength]);
        e.setUniform('tint', p.solid
            ? [p.solidColor.r, p.solidColor.g, p.solidColor.b, 1]
            : [p.tint.r, p.tint.g, p.tint.b, p.tintAlpha]);
        const bottom = p.solid && p.solidColorBottom;
        e.setUniform('tintBottom', bottom
            ? [bottom.r, bottom.g, bottom.b, 1]
            : [0, 0, 0, 0]);

        this._blurBox.visible = !p.solid;
        this._blurEffect.enabled = p.blurRadius > 0;
        this._blurEffect.radius =
            Math.min(MAX_BLUR_RADIUS, Math.round(p.blurRadius * BLUR_RADIUS_SCALE));

        e.queue_repaint();
    }

    // u, v: pointer position in widget UV (-1 = none); fade: 0..1 hover.
    setPointer(u, v, fade) {
        this._effect.setUniform('mousePos', [u, v]);
        this._effect.setUniform('mouseFade', [fade]);
        this._effect.queue_repaint();
    }

    _syncWallpaper() {
        const index = monitorIndexAt(
            this._screenX + this._width / 2, this._screenY + this._height / 2);
        const monitor = Main.layoutManager.monitors[index];
        if (!monitor)
            return;

        if (index !== this._monitorIndex) {
            this._bgManager?.destroy();
            // controlPosition: false leaves each background actor at (0, 0)
            // of _wallpaper, including the replacements it creates when the
            // wallpaper changes, so only _wallpaper itself needs positioning.
            this._bgManager = new Background.BackgroundManager({
                container: this._wallpaper,
                monitorIndex: index,
                controlPosition: false,
                vignette: false,
            });
            this._monitorIndex = index;
        }

        this._wallpaper.set_position(
            monitor.x - this._screenX + BLUR_PAD,
            monitor.y - this._screenY + BLUR_PAD);
    }
        }
    );
}
const LiquidGlass = globalThis[GLASS_CLASS_KEY];

export { LiquidGlass };
