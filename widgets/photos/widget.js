import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { warn } from '../../logger.js';
import { settingsIconPath } from '../../paths.js';
import { boxLayoutProps } from '../../utils/gnomeCompat.js';
import { bindHoverShrink } from '../../lib/buttonBounce.js';

export const type = 'photos';
export const label = 'Photos';
export const stylesheet = 'widgets/photos/stylesheet.css';
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'portrait', 'medium', 'large', 'tall', 'wide', 'huge'];

const SIZE_STYLES = {
	cover: 'cover',
	contain: 'contain',
	fill: '100% 100%',
	small: '58% auto',
};

const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const FILECHOOSER_IFACE = 'org.freedesktop.portal.FileChooser';

function imageIsPortrait(path) {
	if (!path) {
		return false;
	};

	try {
		// GJS returns [format, width, height]: destructuring the first two
		// compared the PixbufFormat object with the width, so every photo
		// was treated as landscape.
		const [format, width, height] = GdkPixbuf.Pixbuf.get_file_info(path) ?? [null, 0, 0];

		return !!format && height > width;
	} catch (error) {
		warn('photos-orientation', `Could not read photo orientation: ${error.message}`);
		return false;
	};
};

// ── Downscaled display copies ────────────────────────────────────────────
// St uploads a background-image at its full resolution: a 24 MP photo in a
// 395×190 frame cost ~96 MB of texture memory per widget. Frames now show a
// copy scaled to what the frame can actually display (cached on disk).
const THUMB_SLACK = 1.25;
const THUMB_MAX_AGE_DAYS = 60;
const pendingThumbs = new Map();
let thumbDirPruned = false;

function thumbCacheDir() {
	const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'desktop-widgets', 'photos']);
	GLib.mkdir_with_parents(dir, 0o755);
	if (!thumbDirPruned) {
		thumbDirPruned = true;
		pruneThumbCache(dir);
	}
	return dir;
};

function pruneThumbCache(dir) {
	const cutoff = Date.now() / 1000 - THUMB_MAX_AGE_DAYS * 86400;
	const dirFile = Gio.File.new_for_path(dir);
	dirFile.enumerate_children_async('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE,
		GLib.PRIORITY_LOW, null, (d, res) => {
			try {
				const en = d.enumerate_children_finish(res);
				let info;
				while ((info = en.next_file(null)) !== null) {
					if (info.get_attribute_uint64('time::modified') < cutoff)
						en.get_child(info).delete_async(GLib.PRIORITY_LOW, null, (f, r) => {
							try { f.delete_finish(r); } catch (_e) {}
						});
				}
				en.close(null);
			} catch (_e) {}
		});
};

function finishThumb(thumbPath, file) {
	const callbacks = pendingThumbs.get(thumbPath) ?? [];
	pendingThumbs.delete(thumbPath);
	for (const cb of callbacks)
		cb(file);
};

function buildThumbAsync(source, thumbPath, width, height, jpeg) {
	const fail = () => finishThumb(thumbPath, source);

	source.read_async(GLib.PRIORITY_LOW, null, (f, res) => {
		let stream;
		try {
			stream = f.read_finish(res);
		} catch (_e) {
			fail();
			return;
		}
		GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, width, height, true, null, (_s, res2) => {
			let pixbuf;
			try {
				pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(res2);
				stream.close(null);
			} catch (_e) {
				fail();
				return;
			}
			pixbuf = pixbuf.apply_embedded_orientation() ?? pixbuf;
			const out = Gio.File.new_for_path(thumbPath);
			out.replace_async(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, GLib.PRIORITY_LOW, null, (o, res3) => {
				let os;
				try {
					os = o.replace_finish(res3);
				} catch (_e) {
					fail();
					return;
				}
				const asJpeg = jpeg && !pixbuf.get_has_alpha();
				pixbuf.save_to_streamv_async(os, asJpeg ? 'jpeg' : 'png',
					asJpeg ? ['quality'] : [], asJpeg ? ['92'] : [], null, (_p, res4) => {
						try {
							GdkPixbuf.Pixbuf.save_to_stream_finish(res4);
							os.close(null);
							finishThumb(thumbPath, out);
						} catch (_e) {
							try { os.close(null); } catch (_e2) {}
							fail();
						}
					});
			});
		});
	});
};

// Calls back with the file to display: the original when it is already
// small enough (or cannot be scaled), otherwise a cached scaled copy.
// Returns the file synchronously when no async work is needed.
function resolveDisplayFile(path, boxPx, callback) {
	const source = Gio.File.new_for_path(path);
	try {
		if (/\.(svgz?|gif)$/i.test(path))
			return source; // vector / animation: keep as is

		const [format, width, height] = GdkPixbuf.Pixbuf.get_file_info(path) ?? [null, 0, 0];
		const shortSide = Math.min(width, height);
		if (!format || shortSide <= 0 || shortSide <= boxPx * THUMB_SLACK)
			return source;

		// Scale so the SHORT side still covers the frame's long side:
		// enough pixels for every fit mode (cover crops, contain letterboxes).
		const factor = boxPx / shortSide;
		const tw = Math.max(1, Math.round(width * factor));
		const th = Math.max(1, Math.round(height * factor));

		const info = source.query_info('time::modified,standard::size', Gio.FileQueryInfoFlags.NONE, null);
		const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1,
			`${path}|${info.get_attribute_uint64('time::modified')}|${info.get_size()}|${tw}x${th}`, -1);
		const jpeg = format.get_name() === 'jpeg';
		const thumbPath = GLib.build_filenamev([thumbCacheDir(), `${key}.${jpeg ? 'jpg' : 'png'}`]);
		const thumb = Gio.File.new_for_path(thumbPath);
		if (thumb.query_exists(null))
			return thumb;

		if (pendingThumbs.has(thumbPath)) {
			pendingThumbs.get(thumbPath).push(callback);
		} else {
			pendingThumbs.set(thumbPath, [callback]);
			buildThumbAsync(source, thumbPath, tw, th, jpeg);
		}
		return null;
	} catch (error) {
		warn('photos-thumb', `Could not prepare a scaled photo: ${error.message}`);
		return source;
	};
};

export function preferredSize(settings, widget) {
	const photo = widget?.data?.photo;

	if (photo && Gio.File.new_for_path(photo).query_exists(null)) {
		return imageIsPortrait(photo) ? 'portrait' : 'medium';
	};

	return 'medium';
};

function openFileChooser(widget, onPhotoChange) {
	if (openFileChooser._busy) {
		return;
	};

	openFileChooser._busy = true;

	const resetBusy = () => {
		openFileChooser._busy = false;
	};

	const options = {};

	const filters = GLib.Variant.new('a(sa(us))', [
		['Images', [
			[1, 'image/png'],
			[1, 'image/jpeg'],
			[1, 'image/gif'],
			[1, 'image/webp'],
			[1, 'image/svg+xml'],
		]],
	]);

	options.filters = filters;

	const currentPhoto = widget?.data?.photo;

	if (currentPhoto && Gio.File.new_for_path(currentPhoto).query_exists(null)) {
		const parent = Gio.File.new_for_path(currentPhoto).get_parent();

		if (parent) {
			options.current_folder = GLib.Variant.new_string(parent.get_uri());
		};
	};

	const params = new GLib.Variant('(ssa{sv})', ['', _('Select a photo'), options]);

	Gio.DBus.session.call(
		PORTAL_NAME,
		PORTAL_PATH,
		FILECHOOSER_IFACE,
		'OpenFile',
		params,
		null,
		Gio.DBusCallFlags.NONE,
		-1,
		null,
		(_bus, result) => {
			let handle = null;

			try {
				[handle] = Gio.DBus.session.call_finish(result).deep_unpack();
			} catch (_error) {
				resetBusy();
				return;
			};

			const subscriptionId = Gio.DBus.session.signal_subscribe(
				PORTAL_NAME,
				'org.freedesktop.portal.Request',
				'Response',
				handle,
				null,
				Gio.DBusSignalFlags.NONE,
				(_signalBus, _sender, _objectPath, _iface, _signal, parameters) => {
					Gio.DBus.session.signal_unsubscribe(subscriptionId);
					resetBusy();

					const [response, results] = parameters.deep_unpack();

					if (response !== 0) {
						return;
					};

					const uris = results['uris'] ? results['uris'].deep_unpack() : [];

					if (uris.length > 0) {
						const file = Gio.File.new_for_uri(uris[0]);
						const path = file.get_path();

						if (path && onPhotoChange) {
							onPhotoChange(path);
						};
					};
				});
		});
};

export function openPhotoChooser(widget, onPhotoChange) {
	openFileChooser(widget, onPhotoChange);
};

// Whether the widget currently displays a real photo (vs. the empty
// "Select photo" placeholder). The extension uses this to decide whether
// the glass backdrop applies (placeholder) or not (photo paints itself).
export function hasPhoto(widget) {
	const photo = widget?.data?.photo;

	return Boolean(photo && Gio.File.new_for_path(photo).query_exists(null));
};

function buildEmptyState(createLabel, onPick, theme, radius = 16) {
	const container = new St.BoxLayout(boxLayoutProps({
		style_class: 'widget-photo-empty',
		vertical: true,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: 'spacing: 12px;',
	}));

	// Same icon as in the settings: dw-image-light / dw-image-dark.
	// It has no -symbolic suffix, so GTK does not fill it with a solid
	// color and the line strokes stay visible.
	const iconName = theme?.dark ? 'dw-image-dark' : 'dw-image-light';
	const iconFile = settingsIconPath(iconName);

	let icon;
	if (iconFile && Gio.File.new_for_path(iconFile).query_exists(null)) {
		icon = new St.Icon({
			style_class: 'widget-photo-icon',
			icon_size: 88,
			gicon: Gio.FileIcon.new(Gio.File.new_for_path(iconFile)),
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
		});
	} else {
		// Fallback when the icon file is missing: the symbolic one is tinted
		// with the theme color, so it reads on any background.
		icon = new St.Icon({
			style_class: 'widget-photo-icon',
			icon_name: 'image-x-generic-symbolic',
			icon_size: 88,
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
			style: `color: ${theme?.muted ?? '#5e5c64'};`,
		});
	};

	container.add_child(icon);

	const label = createLabel(
		_('Select photo'),
		'widget-photo-select',
		`color: ${theme?.text ?? '#ffffff'}; font-size: 24px; font-weight: 600; text-align: center;`);

	label.x_expand = false;
	label.x_align = Clutter.ActorAlign.CENTER;
	container.add_child(label);

	const button = new St.Button({
		style_class: 'widget-photo-empty-button',
		x_expand: true,
		y_expand: true,
		reactive: true,
		can_focus: true,
		track_hover: true,
		style: `background-color: transparent; border: none; padding: 0px; border-radius: ${radius}px;`,
	});

	button.set_child(container);
	bindHoverShrink(button);
	button.connect('clicked', onPick);
	return button;
};

const PhotoFrame = GObject.registerClass(
	class PhotoFrame extends St.Widget {
		_init(file, sizeKey = 'cover', radius = 16) {
			super._init({
				style_class: 'widget-photo',
				x_expand: true,
				y_expand: true,
				x_align: Clutter.ActorAlign.FILL,
				y_align: Clutter.ActorAlign.FILL,
				reactive: true,
				track_hover: false,
			});

			this._file = file;
			this._sizeKey = SIZE_STYLES[sizeKey] ? sizeKey : 'cover';
			this._radius = radius;
			this._updateStyle();

			this.connect('destroy', () => {
				this.set_style(null);
			});
		};

		setFile(file) {
			this._file = file;
			this._updateStyle();
		};

		_updateStyle() {
			const uri = this._file?.get_uri() ?? null;
			const size = SIZE_STYLES[this._sizeKey] ?? SIZE_STYLES.cover;

			this.set_style(uri
				? `background-image: url(${JSON.stringify(uri)}); background-size: ${size}; border-radius: ${this._radius}px;`
				: `background-size: ${size}; border-radius: ${this._radius}px;`);
		};
	}
);

export function style(theme) {
	// Take the background from the theme: a hardcoded #242424 kept the widget
	// dark in the light theme, and theme.text went dark too — invisible.
	return `background-color: ${theme?.background ?? '#242424'}; border-color: ${theme.border}; border-radius: ${theme?.radius ?? 16}px; padding: 0px;`;
};

export function render({body, widget, settings, createLabel, onPhotoChange, theme, sizeForWidget}) {
	const photoShown = hasPhoto(widget);
	const sizeKey = String(settings?.get_string('photo-size') ?? 'cover');
	const radius = theme?.radius ?? 16;

	if (photoShown) {
		// The frame sits inside the card's border, so its corners must be
		// the border's INNER radius; with the outer one the card background
		// peeked through in every corner.
		const frameRadius = Math.max(0, radius - Math.max(0, theme?.borderWidth ?? 1));
		const path = widget?.data?.photo;
		let boxPx = 0;
		try {
			const [w, h] = sizeForWidget?.(widget) ?? [0, 0];
			const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
			boxPx = Math.ceil(Math.max(w, h) * scale);
		} catch (_e) {}

		const frame = new PhotoFrame(null, sizeKey, frameRadius);
		let frameAlive = true;
		frame.connect('destroy', () => { frameAlive = false; });
		body.add_child(frame);

		if (boxPx <= 0) {
			frame.setFile(Gio.File.new_for_path(path));
			return;
		}
		const ready = resolveDisplayFile(path, boxPx, file => {
			if (!frameAlive)
				return; // re-rendered or removed meanwhile
			frame.setFile(file);
		});
		if (ready)
			frame.setFile(ready);
		return;
	};

	body.add_child(buildEmptyState(createLabel, () => openFileChooser(widget, onPhotoChange), theme, radius));
};

export function cleanup() {
	// No-op: per-widget photo storage has no global state to clean up.
};