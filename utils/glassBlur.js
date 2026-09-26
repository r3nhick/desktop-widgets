import St from 'gi://St';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';

/**
 * Glass blur manager for desktop widgets.
 * 
 * Creates a blurred background for each widget using the same approach as
 * blur-my-shell: Meta.BackgroundGroup with BackgroundManager renders the
 * wallpaper, and Shell.BlurEffect blurs it. The blurred background is
 * positioned behind the widget content.
 * 
 * The background is sized to match the widget exactly and positioned to
 * overlay the widget's region. Border radius is applied via CSS to match
 * the widget's rounded corners.
 */
export class GlassBlur {
    /**
     * @param {object} options
     * @param {() => boolean} options.isEnabled whether glass style is active
     * @param {() => number} options.blur blur radius in logical pixels
     * @param {() => number} options.cornerRadius widget corner radius
     * @param {() => number} options.scaleFactor theme scale factor
     * @param {(key: string, message: string) => void} [options.warn]
     */
    constructor({ isEnabled, blur, cornerRadius, scaleFactor, warn }) {
        this._isEnabled = isEnabled;
        this._blur = blur;
        this._cornerRadius = cornerRadius;
        this._scaleFactor = scaleFactor;
        this._warn = warn ?? (() => {});
        
        // Map: widget id -> { actor, container, background, backgroundGroup, bgManager, signalIds }
        this._records = new Map();
    }

    /**
     * Sync blur state for all given views. Views not in the list will have
     * their blur removed.
     * 
     * @param {Iterable<{id: string, actor: Clutter.Actor, widget: object}>} views
     */
    sync(views) {
        const viewsArray = Array.from(views);
        const live = new Set();

        for (const view of viewsArray) {
            if (!view?.actor || !view?.widget) {
                continue;
            }

            live.add(view.id);
            this._syncView(view);
        }

        // Remove blur from widgets that are no longer in the list
        for (const id of [...this._records.keys()]) {
            if (!live.has(id)) {
                this._detach(id);
            }
        }
    }

    destroy() {
        for (const id of [...this._records.keys()]) {
            this._detach(id);
        }
    }

    _syncView(view) {
        const radius = this._blur();

        // No blur if disabled or radius is 0
        if (!this._isEnabled() || radius <= 0) {
            this._detach(view.id);
            return;
        }

        let record = this._records.get(view.id);

        // If actor changed, detach old and create new
        if (record && record.actor !== view.actor) {
            this._detach(view.id);
            record = null;
        }

        if (!record) {
            record = this._attach(view);
            if (!record) {
                return; // Failed to attach
            }
            this._records.set(view.id, record);
        }

        // Update blur radius
        if (record.blur) {
            record.blur.radius = radius * this._scaleFactor();
        }

        // Update size and position
        this._updateSize(record);
    }

    _attach(view) {
        const { actor, widget } = view;
        const container = actor.get_parent();
        
        if (!container) {
            this._warn('glass-no-parent', `Widget ${widget.type} has no parent container`);
            return null;
        }

        // Find monitor for this widget
        const monitor = Main.layoutManager.findMonitorForActor(actor);
        if (!monitor) {
            this._warn('glass-no-monitor', `No monitor found for widget ${widget.type}`);
            return null;
        }

        // Create background group to hold the blurred wallpaper
        const backgroundGroup = new Meta.BackgroundGroup({
            name: 'widget-glass-background',
            width: 0,
            height: 0,
            clip_to_allocation: true,
        });

        // Create background widget that will contain the wallpaper
        const background = new St.Widget({
            name: 'widget-glass-blur',
            style_class: 'widget-glass-blur',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            clip_to_allocation: true,
        });

        // Create BackgroundManager to render the actual wallpaper
        const bgManager = new Background.BackgroundManager({
            container: background,
            monitorIndex: monitor.index,
            controlPosition: false,
        });

        // Add blur effect to the background
        const blur = new Shell.BlurEffect({
            name: 'glass-blur',
            mode: Shell.BlurMode.ACTOR,
            radius: this._blur() * this._scaleFactor(),
            brightness: 1.0,
        });
        background.add_effect(blur);

        // Insert background group as first child of container (behind all widgets)
        backgroundGroup.add_child(background);
        container.insert_child_at_index(backgroundGroup, 0);

        // Track signal connections for cleanup
        const signalIds = [];

        // Connect to actor size/position changes to update background
        signalIds.push(actor.connect('notify::position', () => {
            const record = this._records.get(view.id);
            if (record) this._updateSize(record);
        }));
        signalIds.push(actor.connect('notify::size', () => {
            const record = this._records.get(view.id);
            if (record) this._updateSize(record);
        }));

        // Connect to actor destruction
        signalIds.push(actor.connect('destroy', () => {
            this._detach(view.id);
        }));

        return {
            actor,
            widget,
            container,
            background,
            backgroundGroup,
            bgManager,
            blur,
            monitor,
            signalIds,
        };
    }

    _updateSize(record) {
        const { actor, background, backgroundGroup, monitor, widget } = record;

        // Get widget size and position
        const [width, height] = actor.get_size();
        const [x, y] = actor.get_position();

        if (width <= 0 || height <= 0) {
            return;
        }

        const radius = this._cornerRadius();
        // Inset blur area by a few pixels to avoid corner artifacts
        const inset = Math.max(2, Math.min(4, Math.floor(radius / 4)));

        // backgroundGroup sits at (x + inset, y + inset) with inset size
        backgroundGroup.set_position(x + inset, y + inset);
        backgroundGroup.set_size(width - inset * 2, height - inset * 2);

        // Background inside the group: fill entire monitor, but positioned relative to group origin
        // Group is at (x + inset, y + inset), monitor is at (monitor.x, monitor.y), so offset is:
        const bgX = monitor.x - (x + inset);
        const bgY = monitor.y - (y + inset);
        
        background.set_position(bgX, bgY);
        background.set_size(monitor.width, monitor.height);
        
        // Clip to widget bounds (adjusted for inset)
        const clipX = -bgX;
        const clipY = -bgY;
        background.set_clip(clipX, clipY, width - inset * 2, height - inset * 2);

        // Apply border radius to background
        background.set_style(`border-radius: ${radius}px;`);
    }

    _detach(id) {
        const record = this._records.get(id);
        if (!record) {
            return;
        }

        // Disconnect all signals
        for (const signalId of record.signalIds) {
            try {
                record.actor.disconnect(signalId);
            } catch (e) {
                // Actor might be destroyed already
            }
        }

        // Destroy background manager
        if (record.bgManager) {
            record.bgManager.destroy();
        }

        // Remove and destroy background group
        if (record.backgroundGroup) {
            record.container?.remove_child(record.backgroundGroup);
            record.backgroundGroup.destroy();
        }

        this._records.delete(id);
    }
}
