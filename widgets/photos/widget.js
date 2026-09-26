import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { warn } from '../../logger.js';
import { iconPath } from '../../paths.js';

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
		const [width, height] = GdkPixbuf.Pixbuf.get_file_info(path) ?? [0, 0];

		return height > width;
	} catch (error) {
		warn('photos-orientation', `Could not read photo orientation: ${error.message}`);
		return false;
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

function buildEmptyState(createLabel, onPick, theme, radius = 16) {
	const container = new St.BoxLayout({
		style_class: 'widget-photo-empty',
		vertical: true,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: 'spacing: 12px;',
	});

	// Та сама іконка, що й у налаштуваннях: dw-image-light / dw-image-dark.
	// Вона не має суфікса -symbolic, тому GTK не заливає її суцільним
	// кольором і лінійні штрихи лишаються видимими.
	const iconName = theme?.dark ? 'dw-image-dark' : 'dw-image-light';
	const iconFile = iconPath(iconName);

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
		// Фолбек, якщо іконки немає на диску: символьна перемальовується
		// кольором теми, тож читається на будь-якому тлі.
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
	// Фон беремо з теми: жорсткий #242424 лишав віджет темним у світлій
	// темі, а колір тексту theme.text тоді ще й ставав темним — невидимим.
	return `background-color: ${theme?.background ?? '#242424'}; border-color: ${theme.border}; border-radius: ${theme?.radius ?? 16}px; padding: 0px;`;
};

export function render({body, widget, settings, createLabel, onPhotoChange, theme}) {
	const photo = widget?.data?.photo;
	const hasPhoto = photo && Gio.File.new_for_path(photo).query_exists(null);
	const sizeKey = String(settings?.get_string('photo-size') ?? 'cover');
	const radius = theme?.radius ?? 16;

	if (hasPhoto) {
		const file = Gio.File.new_for_path(photo);
		const frame = new PhotoFrame(file, sizeKey, radius);

		body.add_child(frame);
		return;
	};

	body.add_child(buildEmptyState(createLabel, () => openFileChooser(widget, onPhotoChange), theme, radius));
};

export function cleanup() {
	// No-op: per-widget photo storage has no global state to clean up.
};