// Actor-destruction tracking for GNOME Shell (45-50), which lacks an
// is_destroyed API. Flags actors via their 'destroy' signal instead.

const DESTROYED_ACTORS = new WeakSet();
const WATCHED_ACTORS = new WeakSet();

/** Marks an actor so isActorDestroyed() can detect its destruction. */
export function watchActorLifecycle(actor) {
    if (!actor || WATCHED_ACTORS.has(actor))
        return actor;

    WATCHED_ACTORS.add(actor);
    actor.connect('destroy', () => DESTROYED_ACTORS.add(actor));
    return actor;
}

/** Returns true when the actor is gone (or already flagged destroyed). */
export function isActorDestroyed(actor) {
    if (!actor || DESTROYED_ACTORS.has(actor))
        return true;

    const flag = actor.is_destroyed;
    return typeof flag === 'function' ? !!flag.call(actor) : Boolean(flag);
}
