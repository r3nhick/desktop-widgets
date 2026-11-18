// Widget-in-widget: extra pages stacked above / below a primary widget.
//
// The primary widget is the home page. Pages added "above" sit over it,
// pages added "below" under it — the same top-to-bottom order as the edit
// panel's column (above pages in stack order, the primary, below pages).
//
// Paging is the Apple-style follow pager of the 1x1 calendar, turned
// vertical: hold the RIGHT mouse button and drag up/down anywhere on the
// widget — the current page follows the pointer and the neighbouring page
// rides right beside it, both in the same frame. Releasing past 30px (or a
// quick flick) settles on the neighbour, otherwise the strip springs back.
// The gesture is read in the CAPTURE phase and only claimed when the drag
// is mostly vertical, so the widgets' own horizontal right-button pagers
// (weather/calendar/system monitor) keep working inside a stack.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import { boxLayoutProps } from '../utils/gnomeCompat.js';
import { MAX_STACK_PAGES } from '../lib/widgetTypes.js';
import { LiquidGlass, RoundedClipEffect } from '../lib/glass.js';
import { createHoldWatch, BUTTON3_MASK, PAGER_THRESHOLD } from '../lib/pager.js';

const CLAIM_PX = 8;            // vertical travel before the stack claims a drag
const FLICK_VELOCITY = 0.5;    // px/ms
const MIN_SETTLE_MS = 200;
const MAX_SETTLE_MS = 380;
const RUBBER = 0.3;            // resistance past the first/last page

function newPageKey() {
	return Math.random().toString(36).slice(2, 9);
};

// A page's own state files (pomodoro, timer…) key on widget.id; a random
// key at add-time keeps a stacked widget's save file stable even when an
// earlier sibling is deleted and the indices shift.
export function makeStackEntry(type, size = null) {
	return {type, key: newPageKey(), data: {}, size: size ?? null};
};

export function attachWidgetStack({
	paneRoot,
	baseActor,
	baseGlass = null,
	widget,
	theme,
	styleForEntry = null,
	wantsGlassEntry = null,
	glassParams = null,
	startPage = 0,
	renderPage,
	pageSizeFor = null,
	isEditMode = () => false,
	onStateSaved = () => {},
	onPageChange = () => {},
}) {
	const all = Array.isArray(widget.stack)
		? widget.stack.filter(entry => entry && entry.type).slice(0, MAX_STACK_PAGES)
		: [];
	// pages[] index order (kept for callers: 0 = primary, then the above
	// pages, then the below pages — _getActiveStackEntry maps it back).
	const above = all.filter(e => e.side === 'above');
	const below = all.filter(e => e.side !== 'above');
	const entries = [...above, ...below];

	const empty = {dispose() {}, refresh() {}, restyle() {}, updateGlassGeometry() {}, refill() {}, getActivePage: () => 0};
	if (entries.length === 0)
		return empty;

	const pageW = Math.max(1, Math.floor(baseActor.get_width()) || 200);
	const pageH = Math.max(1, Math.floor(baseActor.get_height()) || 200);
	const distance = () => pageH + Math.max(6, Math.round(pageH / 24)); // page + gap

	let disposed = false;
	let settling = false;
	let active = Math.max(0, startPage);

	// Keep page flights inside the widget's own bounds.
	paneRoot.clip_to_allocation = true;

	const pages = [{actor: baseActor, extra: baseGlass ? [baseGlass] : [], entry: null, body: null}];

	// Strip position (top → bottom): above pages, the primary, below pages.
	const A = above.length;
	const stripPos = i => (i === 0 ? A : (i <= A ? i - 1 : i));
	const pageAtStrip = pos => {
		for (let i = 0; i < pages.length; i++) {
			if (stripPos(i) === pos)
				return i;
		}
		return -1;
	};

	// ── Glass per added page ─────────────────────────────────────────────
	const alive = a => a && !a.is_finalized?.();
	const updatePageGlassGeometry = (page) => {
		const glass = page.glass;
		const card = page.cardActor;
		if (!alive(glass) || !alive(card))
			return;
		const [x, y] = card.get_transformed_position();
		const [w, h] = card.get_size();
		if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0)
			return;
		glass.setGeometry(x, y, w, h);
	};

	const attachPageGlass = (page) => {
		const want = wantsGlassEntry ? wantsGlassEntry(page.entry) : false;
		if (want && !page.glass) {
			const glass = new LiquidGlass();
			const [w, h] = page.cardActor.get_size();
			glass.set_size(w, h);
			glass.set_position(page.cardActor.x, page.cardActor.y);
			page.actor.insert_child_at_index(glass, 0);
			page.glass = glass;
			if (glassParams)
				glass.setParams(glassParams());
		} else if (!want && page.glass) {
			const glass = page.glass;
			page.glass = null;
			if (alive(glass))
				glass.destroy();
		}
		if (page.glass)
			updatePageGlassGeometry(page);
	};

	const updateGlassGeometry = () => {
		for (let i = 1; i < pages.length; i++)
			updatePageGlassGeometry(pages[i]);
	};

	const restyle = () => {
		for (let i = 1; i < pages.length; i++) {
			const page = pages[i];
			if (!alive(page.actor))
				continue;
			if (styleForEntry) {
				const style = styleForEntry(page.entry);
				if (style)
					page.cardActor.set_style(style);
			}
			attachPageGlass(page);
			if (page.glass && glassParams)
				page.glass.setParams(glassParams());
		}
		updateGlassGeometry();
	};

	const buildPage = (entry) => {
		// A page may be smaller than the host's slot (a 1x1 page on a 2x2
		// host): its card floats centered on a transparent page container.
		const [cardW, cardH] = (pageSizeFor?.(entry.size || widget.size)) ?? [pageW, pageH];

		const pageActor = new St.Widget({
			layout_manager: new Clutter.FixedLayout(),
			reactive: true,
			width: pageW,
			height: pageH,
		});

		const cardSize = entry.size || widget.size || 'default';
		const cardActor = new St.BoxLayout(boxLayoutProps({
			vertical: true,
			style_class: `widget widget-${entry.type} widget-${entry.type}-${cardSize}`,
			style: styleForEntry
				? (styleForEntry(entry) ?? '')
				: `background-color: ${theme.background}; border-style: solid;`
					+ ` border-width: ${theme.borderWidth}px; border-color: ${theme.border};`
					+ ` border-radius: ${theme.radius}px;`,
			reactive: true,
			can_focus: true,
			track_hover: true,
		}));
		cardActor.set_size(cardW, cardH);
		cardActor.set_position(Math.round((pageW - cardW) / 2), Math.round((pageH - cardH) / 2));
		pageActor.add_child(cardActor);

		const record = {
			id: `${widget.id}-s-${entry.key}`,
			type: entry.type,
			size: entry.size || widget.size,
			data: entry.data && typeof entry.data === 'object' ? entry.data : (entry.data = {}),
			pinned: true,
		};

		const page = {actor: pageActor, extra: [], cardActor, record, entry, glass: null, body: null};
		attachPageGlass(page);
		pageActor.connectObject('notify::allocation', () => updatePageGlassGeometry(page), pageActor);

		const body = new St.BoxLayout(boxLayoutProps({
			vertical: true,
			style_class: 'widget-body',
			x_expand: true,
			y_expand: true,
			clip_to_allocation: true,
		}));
		cardActor.add_child(body);
		page.body = body;

		try {
			renderPage(record, body, cardActor);
		} catch (error) {
			console.error(`[desktop-widgets] stacked ${entry.type} page failed to render: ${error}`);
		}

		paneRoot.add_child(pageActor);
		pageActor.set_position(0, 0);
		return page;
	};

	for (const entry of entries)
		pages.push(buildPage(entry));

	// ── Placement ────────────────────────────────────────────────────────
	// Translations are whole pixels: the glass shader maps its texture by
	// the actor's stage position, and a fractional offset smears its edges.
	const setY = (page, y) => {
		y = Math.round(y);
		page.actor.translation_y = y;
		for (const a of page.extra)
			if (alive(a))
				a.translation_y = y;
	};
	const setVisible = (page, v) => {
		page.actor.visible = v;
		for (const a of page.extra)
			if (alive(a))
				a.visible = v;
	};

	// Glass samples the wallpaper under its stage rect, so a moving page
	// must tell its glass where it is now — otherwise the wallpaper rides
	// along with the card and the edges tear.
	const syncPageGlass = (page) => {
		if (page === pages[0]) {
			if (!alive(baseGlass) || !alive(paneRoot))
				return;
			const [x, y] = paneRoot.get_transformed_position();
			const [w, h] = paneRoot.get_size();
			if (Number.isFinite(x) && Number.isFinite(y) && w > 0 && h > 0)
				baseGlass.setGeometry(x, y + (page.actor.translation_y || 0), w, h);
			return;
		}
		updatePageGlassGeometry(page);
	};

	const placeIdle = () => {
		active = Math.min(Math.max(0, active), pages.length - 1);
		const d = distance();
		pages.forEach((page, i) => {
			if (!alive(page.actor))
				return;
			page.actor.remove_all_transitions();
			setY(page, (stripPos(i) - stripPos(active)) * d);
			setVisible(page, i === active);
		});
		updateGlassGeometry();
	};
	placeIdle();

	// ── Flight look ──────────────────────────────────────────────────────
	// While pages fly, the widget is a rounded window onto them: the
	// wrapper's rectangular clip gets a rounded mask, and its solid-mode
	// background (it fills the rounded corners at rest) goes transparent so
	// the gap between two cards shows the desktop, not a dark band.
	let clipEffect = null;
	let savedStyle = null;
	let flying = false;

	const beginFlight = () => {
		if (flying || disposed)
			return;
		flying = true;
		const style = paneRoot.get_style?.() ?? null;
		if (style && /background-color\s*:/.test(style)) {
			savedStyle = style;
			paneRoot.set_style(style.replace(/background-color\s*:[^;]*;?/g, 'background-color: rgba(0,0,0,0);'));
		}
		if (RoundedClipEffect) {
			try {
				clipEffect = new RoundedClipEffect();
				const [x, y] = paneRoot.get_transformed_position();
				const [w, h] = paneRoot.get_size();
				clipEffect.setRect(x, y, w, h, theme?.radius ?? 16);
				paneRoot.add_effect_with_name('desktop-widgets-stack-clip', clipEffect);
			} catch (error) {
				console.warn(`[desktop-widgets] stack rounded clip failed: ${error}`);
				clipEffect = null;
			}
		}
	};

	const endFlight = () => {
		if (!flying)
			return;
		flying = false;
		if (clipEffect) {
			try {
				if (alive(paneRoot))
					paneRoot.remove_effect(clipEffect);
			} catch (_e) {}
			clipEffect = null;
		}
		if (savedStyle !== null) {
			if (alive(paneRoot))
				paneRoot.set_style(savedStyle);
			savedStyle = null;
		}
	};

	// ── Follow pager (vertical, right button, capture phase) ─────────────
	let drag = null;
	let timeline = null;
	let timelineIds = [];

	const endGrab = () => {
		if (drag?.grab) {
			try {
				drag.grab.dismiss();
			} catch (_e) {}
			drag.grab = null;
		}
	};

	const neighbour = (dir) => {
		const target = pageAtStrip(stripPos(active) + dir);
		return target >= 0 ? target : -1;
	};

	// Both pages in one frame: the current one at `dy`, the neighbour one
	// page (plus gap) beside it.
	const applyOffset = (dy, target, dir) => {
		const leaving = pages[active];
		setY(leaving, dy);
		syncPageGlass(leaving);
		if (target >= 0) {
			const entering = pages[target];
			setY(entering, dy + dir * distance());
			syncPageGlass(entering);
		}
	};

	const parkPage = (index) => {
		if (index < 0 || index >= pages.length || index === active)
			return;
		setVisible(pages[index], false);
		setY(pages[index], (stripPos(index) - stripPos(active)) * distance());
	};

	const stopTimeline = () => {
		if (!timeline)
			return;
		const t = timeline;
		timeline = null;
		for (const id of timelineIds) {
			try {
				t.disconnect(id);
			} catch (_e) {}
		}
		timelineIds = [];
		try {
			t.stop();
		} catch (_e) {}
	};

	// A settle that is still running when a new press arrives (or on
	// dispose) jumps to its end state right away.
	let finishSettle = null;

	const settle = (allowCommit) => {
		if (!drag)
			return;
		const {dy, velocity, target, dir, claimed} = drag;
		endGrab();
		drag = null;
		if (disposed || !claimed)
			return;

		const d = distance();
		const flick = Math.abs(velocity) > FLICK_VELOCITY && Math.sign(velocity) === Math.sign(dy);
		const commit = allowCommit && target >= 0 && (Math.abs(dy) > PAGER_THRESHOLD || flick);
		const to = commit ? -dir * d : 0;
		const remaining = Math.abs(to - dy);
		const duration = Math.round(Math.min(MAX_SETTLE_MS, Math.max(MIN_SETTLE_MS, remaining * 1.1)));
		const from = dy;

		settling = true;
		finishSettle = () => {
			finishSettle = null;
			stopTimeline();
			settling = false;
			if (disposed)
				return;
			const leavingIndex = active;
			if (commit) {
				active = target;
				setY(pages[active], 0);
				syncPageGlass(pages[active]);
				parkPage(leavingIndex);
			} else {
				setY(pages[active], 0);
				syncPageGlass(pages[active]);
				parkPage(target);
			}
			endFlight();
			updateGlassGeometry();
			if (commit)
				onPageChange(active);
		};

		if (remaining < 1) {
			finishSettle();
			return;
		}

		const mode = Clutter.AnimationMode.EASE_OUT_CUBIC;
		try {
			timeline = new Clutter.Timeline({actor: paneRoot, duration, progress_mode: mode});
		} catch (_e) {
			timeline = null;
		}
		if (!timeline) {
			finishSettle();
			return;
		}
		timelineIds.push(timeline.connect('new-frame', () => {
			if (disposed || !timeline)
				return;
			const p = timeline.get_progress();
			applyOffset(from + (to - from) * p, target, dir);
		}));
		timelineIds.push(timeline.connect('completed', () => finishSettle?.()));
		timeline.start();
	};

	const onCaptured = (_actor, event) => {
		if (disposed)
			return Clutter.EVENT_PROPAGATE;
		const type = event.type();

		if (type === Clutter.EventType.BUTTON_PRESS) {
			if (drag)
				settle(false); // its release was lost: close it first
			finishSettle?.(); // a running settle jumps to its end
			if (event.get_button() !== 3 || isEditMode() || settling)
				return Clutter.EVENT_PROPAGATE;
			const [x, y] = event.get_coords();
			drag = {
				startX: x, startY: y, lastY: y,
				lastTime: GLib.get_monotonic_time() / 1000,
				velocity: 0, dy: 0, claimed: false,
				target: -1, dir: 0, grab: null,
				hold: createHoldWatch(BUTTON3_MASK),
			};
			return Clutter.EVENT_PROPAGATE; // not claimed yet
		}

		if (!drag)
			return Clutter.EVENT_PROPAGATE;

		if (type === Clutter.EventType.MOTION) {
			if (!drag.hold.held(event)) {
				const claimed = drag.claimed;
				settle(false);
				return claimed ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
			}
			const [x, y] = event.get_coords();
			const dx = x - drag.startX;
			const dyRaw = y - drag.startY;

			if (!drag.claimed) {
				if (Math.abs(dyRaw) < CLAIM_PX && Math.abs(dx) < CLAIM_PX)
					return Clutter.EVENT_PROPAGATE;
				if (Math.abs(dyRaw) <= Math.abs(dx)) {
					drag = null; // horizontal: the page's own pager owns it
					return Clutter.EVENT_PROPAGATE;
				}
				drag.claimed = true;
				drag.startY = y; // start following from here (no jump)
				try {
					drag.grab = global.stage.grab(paneRoot);
				} catch (_e) {}
				beginFlight();
			}

			const now = GLib.get_monotonic_time() / 1000;
			drag.velocity = (y - drag.lastY) / Math.max(1, now - drag.lastTime);
			drag.lastY = y;
			drag.lastTime = now;
			let dy = y - drag.startY;

			// Drag UP (dy < 0) brings the page BELOW; drag DOWN the one above.
			const dir = dy < 0 ? 1 : -1;
			if (dir !== drag.dir) {
				// Direction changed: park the previous neighbour.
				parkPage(drag.target);
				drag.dir = dir;
				drag.target = neighbour(dir);
				if (drag.target >= 0)
					setVisible(pages[drag.target], true);
			}

			const d = distance();
			if (drag.target < 0)
				dy *= RUBBER; // nothing that way: resist
			dy = Math.max(-d, Math.min(d, dy));
			drag.dy = dy;
			applyOffset(dy, drag.target, dir);
			return Clutter.EVENT_STOP;
		}

		if (type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === 3) {
			const claimed = drag.claimed;
			if (claimed)
				settle(true);
			else
				drag = null;
			return claimed ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
		}

		if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape && drag.claimed) {
			settle(false);
			return Clutter.EVENT_STOP;
		}
		return Clutter.EVENT_PROPAGATE;
	};
	const capturedId = paneRoot.connect('captured-event', onCaptured);
	const mappedId = paneRoot.connect('notify::mapped', () => {
		if (paneRoot.mapped)
			return;
		if (drag)
			settle(false);
		finishSettle?.(); // an unmapped actor gets no frames to finish on
	});

	return {
		// Full teardown: added pages die; the primary is put back in its
		// slot (visible, untranslated) whatever page was showing.
		dispose() {
			if (disposed)
				return;
			endGrab();
			drag = null;
			finishSettle?.();
			stopTimeline();
			endFlight();
			disposed = true;
			try {
				paneRoot.disconnect(capturedId);
				paneRoot.disconnect(mappedId);
			} catch (_e) {}
			for (let i = 1; i < pages.length; i++) {
				const {actor} = pages[i];
				if (alive(actor)) {
					actor.remove_all_transitions();
					actor.destroy();
				}
			}
			const primary = pages[0];
			for (const a of [primary.actor, ...primary.extra]) {
				if (alive(a)) {
					a.remove_all_transitions();
					a.translation_y = 0;
					a.visible = true;
				}
			}
			pages.length = 1;
		},

		// Edit mode toggles: nothing to re-arm (the gesture reads the mode
		// live); kept for the caller's API.
		refresh() {},

		restyle,

		// The visible page index (0 = primary).
		getActivePage() {
			return active;
		},

		// Jump straight to a page (the edit panel's rows), no flight.
		showPage(index) {
			if (disposed || index < 0 || index >= pages.length || index === active)
				return;
			if (drag)
				settle(false);
			finishSettle?.();
			active = index;
			placeIdle();
			syncPageGlass(pages[active]);
			onPageChange(active);
		},

		// Strip position of the visible page (0 = top of the column).
		getStripPosition() {
			return stripPos(active);
		},

		updateGlassGeometry,

		// Re-render added pages whose type passes `predicate` (data
		// refreshes: weather, calendar, system…), in place.
		refill(predicate = () => true) {
			for (let i = 1; i < pages.length; i++) {
				const page = pages[i];
				if (!alive(page.body) || !predicate(page.entry.type))
					continue;
				try {
					renderPage(page.record, page.body, page.cardActor);
				} catch (error) {
					console.error(`[desktop-widgets] stacked ${page.entry.type} refresh failed: ${error}`);
				}
			}
		},
	};
};
