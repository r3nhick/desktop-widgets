import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import { warn } from '../../logger.js';
import { assetPath } from '../../paths.js';
import { lang } from '../../locale.js';

export const type = 'music';
export const label = 'Music';
export const stylesheet = 'widgets/music/stylesheet.css';
export const defaultSize = 'medium';
export const supportedSizes = ['mini', 'medium'];
export const appIds = ['org.gnome.Music', 'io.bassi.Amberol', 'org.videolan.VLC'];

function localize(uk, ru, en) {
	const current = lang();

	if (current === 'uk') {
		return uk;
	};

	if (current === 'ru') {
		return ru;
	};

	return en;
};

const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PLAYER_PATH = '/org/mpris/MediaPlayer2';
const DBUS_IFACE = 'org.freedesktop.DBus.Properties';
const TICK_MS = 500;
const LOOP_CYCLE = ['None', 'Track', 'Playlist'];
const GIF_CANDIDATES = ['pushy.gif', 'pushy2.gif', 'pushy3.gif', 'pushy4.gif', 'pushy5.gif'];
const gifFramesCache = new Map();
const CHROMIUM_MARKERS = ['chromium', 'chrome', 'brave', 'vivaldi', 'opera', 'edge', 'yandex', 'thorium', 'helium', 'firefox'];

function isChromiumName(name) {
	const lower = String(name ?? '').toLowerCase();

	return CHROMIUM_MARKERS.some(marker => lower.includes(marker));
};

let emptyGifPathCached = undefined;

function findGif(names) {
	for (const name of names) {
		const bundled = assetPath(name);
		const local = GLib.build_filenamev([GLib.get_home_dir(), 'Pictures', 'Other', name]);

		for (const path of [bundled, local]) {
			if (path && Gio.File.new_for_path(path).query_exists(null)) {
				return path;
			};
		};
	};

	return null;
};

function emptyGifPath(preferred = null) {
	if (preferred) {
		return findGif([preferred, ...GIF_CANDIDATES.filter(name => name !== preferred)]);
	};

	if (emptyGifPathCached !== undefined) {
		return emptyGifPathCached;
	};

	emptyGifPathCached = findGif(GIF_CANDIDATES);

	return emptyGifPathCached;
};

function pixbufToBytesIcon(pixbuf) {
	const [ok, data] = pixbuf.save_to_bufferv('png', [], null);

	if (!ok || !data) {
		return null;
	};

	return new Gio.BytesIcon({bytes: new GLib.Bytes(data)});
};

function arraysEqual(a, b) {
	if (a.length !== b.length) {
		return false;
	};

	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) {
			return false;
		};
	};

	return true;
};

function pixbufFrames(path) {
	const frames = [];
	let firstPixels = null;

	try {
		const animation = GdkPixbuf.PixbufAnimation.new_from_file(path);
		const iter = animation.get_iter(null);
		let guard = 0;

		while (guard++ < 240) {
			const pixbuf = iter.get_pixbuf();
			const pixels = pixbuf.get_pixels();

			if (firstPixels && arraysEqual(pixels, firstPixels)) {
				break;
			};

			const icon = pixbufToBytesIcon(pixbuf);

			if (!icon) {
				break;
			};

			if (!firstPixels) {
				firstPixels = pixels;
			};

			frames.push({icon, delay: Math.max(40, iter.get_delay_time())});

			if (!iter.advance(null)) {
				break;
			};
		};
	} catch (error) {
		warn('music: failed to decode gif frames', error);
	};

	return frames;
};

function removeGifTempDir(baseDir) {
	try {
		Gio.File.new_for_path(baseDir).delete(null);
	} catch (cleanupError) {
		// Ignore cleanup failures.
	};
};

function ffmpegFrames(path, frameDelay, onDone) {
	const ffmpeg = GLib.find_program_in_path('ffmpeg');

	if (!ffmpeg) {
		onDone(null);
		return;
	};

	const baseDir = GLib.build_filenamev([GLib.get_tmp_dir(), `widgets-music-${GLib.get_monotonic_time()}`]);
	const pattern = GLib.build_filenamev([baseDir, 'frame_%03d.png']);

	GLib.mkdir_with_parents(baseDir, 0o700);

	if (!Gio.File.new_for_path(baseDir).query_exists(null)) {
		onDone(null);
		return;
	};

	try {
		const process = Gio.Subprocess.new(
			[ffmpeg, '-y', '-v', 'error', '-i', path, pattern],
			Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);

		process.wait_check_async(null, (_source, result) => {
			let success = false;

			try {
				success = _source.wait_check_finish(result);
			} catch (error) {
				success = false;
			};

			if (!success) {
				removeGifTempDir(baseDir);
				onDone(null);
				return;
			};

			const frames = [];

			for (let index = 1; index <= 240; index++) {
				const framePath = GLib.build_filenamev([baseDir, `frame_${String(index).padStart(3, '0')}.png`]);
				const file = Gio.File.new_for_path(framePath);

				if (!file.query_exists(null)) {
					break;
				};

				try {
					const icon = pixbufToBytesIcon(GdkPixbuf.Pixbuf.new_from_file(framePath));

					if (icon) {
						frames.push({icon, delay: frameDelay});
					};
				} catch (error) {
					warn('music: failed to load extracted gif frame', error);
				};

				file.delete(null);
			};

			removeGifTempDir(baseDir);
			onDone(frames.length > 1 ? frames : null);
		});
	} catch (error) {
		warn('music: failed to spawn ffmpeg', error);
		removeGifTempDir(baseDir);
		onDone(null);
	};
};

function decodeGifFrames(path, onDone) {
	const cached = gifFramesCache.get(path);

	if (cached) {
		onDone(cached);
		return;
	};

	const finish = decoded => {
		if (decoded && decoded.length > 1) {
			gifFramesCache.set(path, decoded);
		};

		onDone(decoded ?? null);
	};

	// GdkPixbuf iterates seamless loops as repeated identical bitmaps, which can
	// collapse to a single frame. Extract with ffmpeg first, then fall back to
	// the GdkPixbuf loop when ffmpeg is unavailable.
	const ffmpeg = GLib.find_program_in_path('ffmpeg');

	if (ffmpeg) {
		ffmpegFrames(path, gifFrameDelay(path), frames => {
			if (frames && frames.length >= 2) {
				finish(frames);
				return;
			};

			const pixbufDecoded = pixbufFrames(path);
			finish(pixbufDecoded.length > 1 ? pixbufDecoded : null);
		});
		return;
	};

	const pixbufDecoded = pixbufFrames(path);
	finish(pixbufDecoded.length > 1 ? pixbufDecoded : null);
};

function gifFrameDelay(path) {
	try {
		const animation = GdkPixbuf.PixbufAnimation.new_from_file(path);
		const iter = animation.get_iter(null);

		return Math.max(40, iter.get_delay_time());
	} catch (error) {
		return 150;
	};
};

function startEmptyGif(card, path) {
	stopEmptyGif(card);

	const token = (card._gifToken ?? 0) + 1;
	card._gifToken = token;

	decodeGifFrames(path, frames => {
		if (!card.cover || card._gifToken !== token) {
			return;
		};

		if (!frames) {
			card.cover.gicon = null;
			card.cover.icon_name = 'audio-x-generic-symbolic';
			card.cover.style = `icon-size: ${Math.round(card._coverSize * 0.45)}px;`;
			return;
		};

		card.gifFrames = frames;
		card.gifIndex = 0;
		card.cover.style = `icon-size: ${card._coverSize}px;`;
		card.cover.gicon = frames[0].icon;
		card.cover.icon_name = '';

		const schedule = () => {
			card.gifTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, frames[card.gifIndex % frames.length].delay, () => {
				if (!card.gifFrames) {
					return GLib.SOURCE_REMOVE;
				};

				card.gifIndex = (card.gifIndex + 1) % frames.length;
				card.cover.gicon = frames[card.gifIndex].icon;
				schedule();

				return GLib.SOURCE_REMOVE;
			});
		};

		schedule();
	});
};

function stopEmptyGif(card) {
	card._gifToken = (card._gifToken ?? 0) + 1;

	if (card.gifTimer) {
		GLib.source_remove(card.gifTimer);
		card.gifTimer = 0;
	};

	card.gifFrames = null;
	card.gifIndex = 0;
};

function variantValue(value) {
	return value && typeof value.deep_unpack === 'function' ? value.deep_unpack() : value;
};

function parseMetadata(metadata) {
	const md = variantValue(metadata) ?? {};
	let artist = variantValue(md['xesam:artist']);

	if (Array.isArray(artist)) {
		artist = artist.join(' / ');
	} else if (artist && typeof artist === 'object') {
		artist = String(artist);
	};

	return {
		title: variantValue(md['xesam:title']) ?? null,
		artist: typeof artist === 'string' && artist.length > 0 ? artist : null,
		artUrl: variantValue(md['mpris:artUrl']) ?? null,
		length: Math.max(0, Number(variantValue(md['mpris:length']) ?? 0)),
		trackId: variantValue(md['mpris:trackid']) ?? null,
	};
};

function formatUs(us) {
	const ms = Math.max(0, Math.round((Number(us) || 0) / 1000));
	const minutes = Math.floor(ms / 60000);
	const seconds = Math.floor((ms % 60000) / 1000);

	return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

function trackColor(theme) {
	return theme.dark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(0, 0, 0, 0.12)';
};

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text}; padding: 12px 16px;`;
};

function createControlButton(theme, iconName, iconSize = 18, padding = 4, radius = 9) {
	const icon = new St.Icon({icon_name: iconName, style: `icon-size: ${iconSize}px; color: ${theme.text};`});
	const button = new St.Button({
		style_class: 'widget-music-button',
		can_focus: false,
		reactive: true,
		style: `border-radius: ${radius}px; padding: ${padding}px;`,
	});

	button._iconSize = iconSize;
	button.set_child(icon);
	button.set_width(27);
	button.set_height(27);

	return {button, icon};
};

function recolorIcon(target, color, alpha = 1) {
	target.icon.style = `icon-size: ${target.button._iconSize ?? 18}px; color: ${color};${alpha < 1 ? ` opacity: ${alpha};` : ''}`;
};

function createCard(theme, createLabel, widgetWidth, widgetHeight) {
	const pad = 16;
	const gap = 14;
	const cover = Math.max(48, Math.min(200, Math.round(Math.min(widgetHeight, widgetWidth) * 0.8)));
	const usableWidth = Math.max(10, widgetWidth - pad * 2 - cover - gap);
	const contentWidth = Math.min(usableWidth, widgetHeight * 2);
	const titleFont = Math.max(18, Math.min(19, Math.round(contentWidth * 0.092)));
	const artistFont = Math.max(14, Math.min(14, Math.round(titleFont * 0.78)));
	const timeFont = Math.max(14, Math.min(14, Math.round(titleFont * 0.78)));
	const barHeight = 6;
	const thumbSize = Math.max(8, Math.min(14, barHeight + 5));
	const trackColorValue = trackColor(theme);
	const card = {};

	card.gifFrames = null;
	card.gifIndex = 0;
	card.gifTimer = 0;
	card._gifPath = null;
	card._coverSize = cover;

	card.container = new St.BoxLayout({
		x_expand: true,
		y_expand: true,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${gap}px;`,
	});

	const coverRadius = Math.round(cover * 0.1);

	card.coverBox = new St.Widget({
		layout_manager: new Clutter.BinLayout(),
		style: `width: ${cover}px; height: ${cover}px; border-radius: ${coverRadius}px; background-size: cover; background-position: center;`,
	});
	card.coverBox.set_size(cover, cover);
	card.coverBox.x_expand = false;
	card.coverBox.y_expand = false;

	card.cover = new St.Icon({
		style_class: 'widget-music-cover',
		icon_name: 'audio-x-generic-symbolic',
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `icon-size: ${Math.round(cover * 0.45)}px;`,
	});
	card.cover.set_size(cover, cover);
	card.coverBox.add_child(card.cover);

	card.showArt = function (artUrl) {
		if (artUrl && (artUrl.startsWith('http://') || artUrl.startsWith('https://') || artUrl.startsWith('file://'))) {
			card.coverBox.set_style(`width: ${cover}px; height: ${cover}px; border-radius: ${coverRadius}px; background-image: url("${artUrl}"); background-size: cover; background-position: center;`);
			card.cover.hide();
		} else {
			card.coverBox.set_style(`width: ${cover}px; height: ${cover}px; border-radius: ${coverRadius}px; background-image: none;`);
			card.cover.gicon = null;
			card.cover.icon_name = 'audio-x-generic-symbolic';
			card.cover.show();
		};
	};

	card.column = new St.BoxLayout({
		vertical: true,
		x_expand: true,
		style: 'spacing: 4px;',
	});

	card.title = createLabel('', 'widget-music-title', `font-size: ${titleFont}px; font-weight: 800; color: ${theme.text};`);
	card.title.clutter_text.single_line_mode = true;

	card.artist = createLabel('', 'widget-music-artist', `font-size: ${artistFont}px; color: ${theme.muted};`);
	card.artist.clutter_text.single_line_mode = true;

	card.times = new St.BoxLayout({
		x_expand: true,
		style: 'spacing: 10px;',
	});

	card.timeElapsed = createLabel('0:00', 'widget-music-time', `font-size: ${timeFont}px; color: ${theme.muted};`);
	card.timeElapsed.x_align = Clutter.ActorAlign.START;
	card.timeTotal = createLabel('0:00', 'widget-music-time', `font-size: ${timeFont}px; color: ${theme.muted};`);
	card.timeTotal.x_align = Clutter.ActorAlign.END;

	card._barHeight = barHeight;
	card._thumbSize = thumbSize;
	card._contentWidth = contentWidth;
	card._lastLength = 0;

	card.slider = new St.Button({
		style_class: 'widget-music-slider',
		can_focus: false,
		reactive: true,
		x_expand: true,
		track_hover: true,
		style: 'padding: 4px 0; border: 0;',
	});
	card.slider.set_size(-1, barHeight + 8);

	card.track = new St.Widget({
		style_class: 'widget-music-track',
		x_expand: true,
		style: `background-color: ${trackColorValue}; border-radius: ${barHeight / 2}px; min-height: ${barHeight}px; height: ${barHeight}px;`,
	});
	card.fill = new St.Widget({
		style_class: 'widget-music-fill',
		style: `background-color: ${theme.accent}; border-radius: ${barHeight / 2}px;`,
	});
	card.fill.set_size(0, barHeight);
	card.thumb = new St.Widget({
		style: `width: ${thumbSize}px; height: ${thumbSize}px; border-radius: ${Math.round(thumbSize / 2)}px; background-color: ${theme.accent};`,
	});
	card.thumb.set_position(0, Math.round((barHeight - thumbSize) / 2));
	card.track.add_child(card.fill);
	card.track.add_child(card.thumb);
	card.slider.set_child(card.track);

	card.fractionForEvent = function (event) {
		const [stageX] = event.get_coords();
		const [trackX] = card.track.get_transformed_position();
		const [trackWidth] = card.track.get_transformed_size();

		if (trackWidth <= 0) {
			const fallbackWidth = card._contentWidth || card.slider.get_width() || 300;
			const fallbackTrackX = card.slider.get_transformed_position()[0] + 8;
			const fraction = (stageX - fallbackTrackX) / fallbackWidth;
			if (fraction < 0 || fraction > 1) return null;
			return fraction;
		};

		const fraction = (stageX - trackX) / trackWidth;

		if (fraction < 0 || fraction > 1) {
			return null;
		};

		return fraction;
	};

	card.preview = function (fraction) {
		const f = Math.max(0, Math.min(1, fraction ?? 0));
		const length = card._lastLength || 0;
		const trackWidth = card.track.get_width() > 0 ? card.track.get_width() : card._contentWidth;
		const maxFillWidth = trackWidth;
		const minFillWidth = 0;
		const fillWidth = Math.max(minFillWidth, Math.min(maxFillWidth, Math.round(trackWidth * f)));

		card.timeElapsed.text = formatUs(Math.round(length * f));
		card.fill.set_size(fillWidth, barHeight);

		const maxThumbX = trackWidth - thumbSize / 2;
		const minThumbX = thumbSize / 2;
		const thumbX = Math.max(minThumbX, Math.min(maxThumbX, fillWidth));
		card.thumb.set_position(Math.round(thumbX - thumbSize / 2), Math.round((barHeight - thumbSize) / 2));
	};

	card.controls = new St.BoxLayout({
		x_expand: true,
		style: 'spacing: 2px;',
	});

	card.btnLoop = createControlButton(theme, 'media-playlist-repeat-symbolic');
	card.btnPrev = createControlButton(theme, 'media-skip-backward-symbolic');
	card.btnPlay = createControlButton(theme, 'media-playback-start-symbolic', 22, 2, 11);
	card.btnNext = createControlButton(theme, 'media-skip-forward-symbolic', 22, 2, 11);

	const controlsSpacer = new St.Widget({x_expand: true, style: 'min-width: 4px;'});

	card.controls.add_child(card.btnLoop.button);
	card.controls.add_child(card.btnPrev.button);
	card.controls.add_child(card.btnPlay.button);
	card.controls.add_child(card.btnNext.button);
	card.controls.add_child(controlsSpacer);

	card.times.add_child(card.timeElapsed);
	card.times.add_child(card.timeTotal);
	card.column.add_child(card.title);
	card.column.add_child(card.artist);
	card.column.add_child(card.slider);
	card.column.add_child(card.times);
	card.column.add_child(card.controls);
	card.container.add_child(card.coverBox);
	card.container.add_child(card.column);

	const isMini = widgetHeight <= 140;
	if (isMini) {
		card.slider.hide();
		card.times.hide();
	};

	card.update = function ({title, artist, artUrl, playing, position, length, canControl, canPrev, canNext, canPlay, canPause, loop = 'None', canSeek = false, seekPreview = false, loopSupported = true, forcePrev = false, forceNext = false}) {
		const hasTrack = Boolean(title && title.length > 0);
		const control = canControl !== false || canPlay || canPause || canPrev || canNext || canSeek;
		const gifPath = !hasTrack
			? emptyGifPath(this._settings?.get_string('music-empty-gif'))
			: null;

		if (hasTrack) {
			card.title.text = title;
			card.artist.text = artist || localize('Невідомий виконавець', 'Неизвестный исполнитель', 'Unknown artist');

			stopEmptyGif(card);
			card._gifPath = null;

			card.showArt(artUrl);
		} else {
			card.title.text = localize("Я чекаю 🐾", "Я жду 🐾", "I'm waiting 🐾");
			card.artist.text = localize('Увімкни щось', 'Включи что-нибудь', 'Play something to get going');

			if (gifPath) {
				if (card._gifPath !== gifPath) {
					card.showArt(null);
					card._gifPath = gifPath;
					startEmptyGif(card, gifPath);
				};
			} else {
				stopEmptyGif(card);
				card._gifPath = null;
				card.showArt(null);
			};

			// Reset time displays and slider when no track
			card.timeElapsed.text = '0:00';
			card.timeTotal.text = length > 0 ? formatUs(length) : '0:00';
			card.fill.set_size(0, barHeight);
			card.thumb.set_position(0, Math.round((barHeight - thumbSize) / 2));
			card.thumb.opacity = 0;
		};

		const displayLength = hasTrack ? length : 0;
		card._lastLength = displayLength;
		card.timeTotal.text = displayLength > 0 ? formatUs(displayLength) : '0:00';

		if (!seekPreview) {
			card.timeElapsed.text = hasTrack ? formatUs(position) : '0:00';

			const fraction = displayLength > 0 ? Math.max(0, Math.min(1, position / displayLength)) : 0;
			const trackWidth = card.track.get_width() > 0 ? card.track.get_width() : contentWidth;
			const maxFillWidth = trackWidth;
			const fillWidth = Math.max(0, Math.min(maxFillWidth, Math.round(trackWidth * fraction)));

			card.fill.set_size(fillWidth, barHeight);

			const maxThumbX = trackWidth - thumbSize / 2;
			const minThumbX = thumbSize / 2;
			const thumbX = Math.max(minThumbX, Math.min(maxThumbX, fillWidth));
			card.thumb.set_position(Math.round(thumbX - thumbSize / 2), Math.round((barHeight - thumbSize) / 2));
			card.thumb.opacity = hasTrack && displayLength > 0 ? 255 : 0;
		};

		const loopOk = loopSupported !== false;

		card.btnLoop.button.reactive = control && loopOk;
		card.btnLoop.button.opacity = loopOk ? (control ? 255 : 100) : 30;
		card.btnPrev.button.reactive = control && (!!canPrev || forcePrev);
		card.btnPrev.button.opacity = control && (canPrev || forcePrev) ? 255 : 100;
		card.btnPlay.button.reactive = control && (playing ? !!canPause : !!canPlay);
		card.btnPlay.button.opacity = control && (playing ? canPause : canPlay) ? 255 : 100;
		card.btnNext.button.reactive = control && (!!canNext || forceNext);
		card.btnNext.button.opacity = control && (canNext || forceNext) ? 255 : 100;

		const seekable = control && (length > 0 || playing) && (canSeek || canPlay || canPause);
		card.slider.reactive = seekable;
		card.slider.opacity = seekable ? 255 : 90;

		card.btnPlay.icon.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';

		recolorIcon(card.btnPlay, theme.text);
		recolorIcon(card.btnLoop, control ? theme.text : theme.muted, control ? 1 : 0.4);
		recolorIcon(card.btnPrev, theme.text);
		recolorIcon(card.btnNext, theme.text);

		if (loop === 'Track') {
			card.btnLoop.icon.icon_name = 'media-playlist-repeat-song-symbolic';
			recolorIcon(card.btnLoop, theme.accent);
		} else if (loop === 'Playlist') {
			card.btnLoop.icon.icon_name = 'media-playlist-repeat-symbolic';
			recolorIcon(card.btnLoop, theme.accent);
		} else {
			card.btnLoop.icon.icon_name = 'media-playlist-repeat-symbolic';
			recolorIcon(card.btnLoop, control ? theme.text : theme.muted, control ? 1 : 0.4);
		};
	};

	card.update({title: null, artist: null, artUrl: null, playing: false, position: 0, length: 0,
		canControl: false, canPrev: false, canNext: false, canPlay: false, canPause: false, loop: 'None', canSeek: false});

	return card;
};

let Controller = class Controller {
	constructor(card, bus, settings) {
		this._card = card;
		this._bus = bus;
		this._settings = settings;
		this._name = null;
		this._subIds = [];
		this._watchId = 0;
		this._timerId = 0;
		this._retryTimer = 0;
		this._status = 'Stopped';
		this._position = 0;
		this._posAt = 0;
		this._length = 0;
		this._playing = false;
		this._canControl = false;
		this._canPrev = false;
		this._canNext = false;
		this._canPlay = false;
		this._canPause = false;
		this._canSeek = false;
		this._loop = 'None';
		this._rate = 1;
		this._trackId = null;
		this._seekActive = false;
		this._seekFrac = null;
		this._positionBeforeSeek = 0;
		this._seekLockUntil = 0;
		this._lastPosSync = 0;
		this._lastPlayerScan = 0;
		this._seekCapture = false;
		this._meta = {title: null, artist: null, artUrl: null};
		this._relisten = false;
		this._bound = false;
		this._lastPlayingAt = {};
		this._chromium = false;
		this._lockedTrackId = null;
		this._acceptUntil = 0;
		this._loopSupport = null;
		this._controlSignals = [];
		this._bindControls();

		this._settingsId = 0;
		if (this._settings) {
			this._settingsId = this._settings.connect(
				'changed::music-empty-gif', () => this._onEmptyGifSettingChanged()
			);
		};
	};

	_onEmptyGifSettingChanged() {
		if (!this._card?._gifPath) {
			return;
		};

		const gifPath = emptyGifPath(this._settings?.get_string('music-empty-gif'));

		if (gifPath && gifPath !== this._card._gifPath) {
			stopEmptyGif(this._card);
			this._card._gifPath = gifPath;
			startEmptyGif(this._card, gifPath);
		};
	};

	async start() {
		const bus = this._bus;

		if (!bus) {
			this._card.update({title: null, artist: null, artUrl: null, playing: false, position: 0, length: 0,
				canControl: false, canPrev: false, canNext: false, canPlay: false, canPause: false});
			return;
		};

		this._relisten = true;

		const bestRow = await this._pickActive();

		if (bestRow && typeof bestRow.name === 'string' && bestRow.name) {
			this._name = bestRow.name;
			this._wire(bestRow.name);
			this._applyProps(bestRow.props);
			this._startTimer();
			return;
		};

		if (this._relisten === false) {
			return;
		};

		this._card.update({title: null, artist: null, artUrl: null, playing: false, position: 0, length: 0,
			canControl: false, canPrev: false, canNext: false, canPlay: false, canPause: false});
		this._startTimer();
		this._scheduleRelisten();
	};

	async _callRemote(busName, path, iface, method, params, type) {
		return new Promise(resolve => {
			this._bus.call(busName, path, iface, method, params, type,
				Gio.DBusCallFlags.NONE, -1, null,
				(connection, result) => {
					try {
						resolve(connection.call_finish(result));
					} catch (error) {
						resolve(null);
					};
				});
		});
	};

	async listCandidates() {
		const result = await this._callRemote('org.freedesktop.DBus', '/org/freedesktop/DBus',
			'org.freedesktop.DBus', 'ListNames', null, GLib.VariantType.new('(as)'));
		const names = result?.deep_unpack()?.[0] ?? [];

		return names.filter(name => name.startsWith('org.mpris.MediaPlayer2.'));
	};

	async _pickActive() {
		const rows = [];

		for (const candidate of await this.listCandidates()) {
			const props = await this._readProps(candidate);

			if (!props) {
				continue;
			};

			const status = variantValue(props.PlaybackStatus);
			const meta = parseMetadata(variantValue(props.Metadata));
			const hasTitle = Boolean(meta.title && meta.title.length);
			const isChromium = isChromiumName(candidate);
			const ignoreBrowsers = this._settings?.get_boolean('music-ignore-browsers') ?? true;
			
			if (ignoreBrowsers && isChromium) {
				continue;
			};

			const isProxy = candidate.toLowerCase().includes('playerctld');
			let value = 0;

			if (status === 'Playing' && hasTitle) {
				value = 500;

				if (!isChromium) {
					this._lastPlayingAt[candidate] = Date.now();
				};
			} else if (status === 'Paused' && hasTitle) {
				value = 100;
			} else if (hasTitle) {
				value = 50;
			};

			rows.push({name: candidate, props, status, hasTitle, value,
				recency: this._lastPlayingAt[candidate] ?? 0, isChromium, isProxy});
		};

		let bestNonChrome = null;
		let bestChrome = null;

		for (const row of rows) {
			if (row.value <= 0) {
				continue;
			};

			const slot = row.isChromium ? () => bestChrome : () => bestNonChrome;
			const current = row.isChromium ? bestChrome : bestNonChrome;

			if (!current || row.value > current.value ||
				(row.value === current.value && row.recency > current.recency)) {
				if (row.isChromium) {
					bestChrome = row;
				} else {
					bestNonChrome = row;
				};
			};
		};

		if (bestNonChrome && !(bestNonChrome.isProxy && bestChrome && bestNonChrome.value <= bestChrome.value)) {
			return bestNonChrome;
		};

		return bestChrome;
	};

	async _readProps(name) {
		const result = await this._callRemote(name, PLAYER_PATH, DBUS_IFACE, 'GetAll',
			GLib.Variant.new('(s)', [PLAYER_IFACE]), GLib.VariantType.new('(a{sv})'));
		const props = result?.deep_unpack()?.[0] ?? null;

		return props && typeof props === 'object' ? props : null;
	};

	_wire(name) {
		if (typeof name !== 'string' || !name) {
			return;
		};

		for (const id of this._subIds) {
			this._bus?.signal_unsubscribe(id);
		};

		this._subIds = [];

		this._chromium = isChromiumName(name);
		this._lockedTrackId = null;
		this._acceptUntil = 0;
		this._loopSupport = null;

		this._subIds.push(this._bus.signal_subscribe(name, DBUS_IFACE, 'PropertiesChanged', PLAYER_PATH, null,
			Gio.DBusSignalFlags.NONE,
			(_connection, _sender, _objectPath, _iface, _signal, parameters) => {
				const [changedInterface, changed, _invalidated] = parameters?.deep_unpack() ?? [];

				if (changedInterface !== PLAYER_IFACE) {
					return;
				};

				const statusChanged = changed?.PlaybackStatus !== undefined;

				if (statusChanged) {
					this._applyStatus(variantValue(changed.PlaybackStatus));

					if (this._playing) {
						this._syncPosition();
					};
				};

				if (changed?.Position !== undefined) {
					this._position = Math.max(0, Number(variantValue(changed.Position) ?? 0));
					this._posAt = Date.now();
					this._lastPosSync = Date.now();
				};

				if (changed?.CanControl !== undefined) {
					this._canControl = Boolean(variantValue(changed.CanControl));
				};

				if (changed?.CanGoPrevious !== undefined) {
					this._canPrev = Boolean(variantValue(changed.CanGoPrevious));
				};

				if (changed?.CanGoNext !== undefined) {
					this._canNext = Boolean(variantValue(changed.CanGoNext));
				};

				if (changed?.CanPlay !== undefined) {
					this._canPlay = Boolean(variantValue(changed.CanPlay));
				};

				if (changed?.CanPause !== undefined) {
					this._canPause = Boolean(variantValue(changed.CanPause));
				};

				if (changed?.CanSeek !== undefined) {
					this._canSeek = Boolean(variantValue(changed.CanSeek));
				};

				if (changed?.LoopStatus !== undefined) {
					this._loop = variantValue(changed.LoopStatus);

					if (this._loopSupport === false) {
						this._loopSupport = null;
					};
				};

				if (changed?.Rate !== undefined) {
					this._rate = Number(variantValue(changed.Rate)) || 1;
				};

				if (changed?.Metadata !== undefined) {
					this._handleMetaChange(parseMetadata(changed.Metadata), statusChanged);
				};

				this._render();
			}));

		this._subIds.push(this._bus.signal_subscribe(name, PLAYER_IFACE, 'Seeked', PLAYER_PATH, null,
			Gio.DBusSignalFlags.NONE,
			(_connection, _sender, _objectPath, _iface, _signal, parameters) => {
				const [position] = parameters?.deep_unpack() ?? [];

				if (typeof position === 'number' && position >= 0) {
					this._position = position;
					this._posAt = Date.now();
					this._lastPosSync = Date.now();
					this._seekLockUntil = 0;

					if (this._chromium && this._playing && position < 500000) {
						this._acceptUntil = Date.now() + 1500;
						this._render();
					} else {
						this._render();
					};
				};
			}));

		if (this._watchId) {
			this._bus.unwatch_name(this._watchId);
			this._watchId = 0;
		};

		this._watchId = this._bus.watch_name(name, Gio.BusNameWatcherFlags.NONE,
			() => {},
			() => {
				if (this._relisten === false) {
					return;
				};

				this._position = 0;
				this._posAt = 0;
				this._meta = {title: null, artist: null, artUrl: null};
				this._playing = false;
				this._canControl = false;
				this._canPrev = false;
				this._canNext = false;
				this._canPlay = false;
				this._canPause = false;
				this._canSeek = false;
				this._loop = 'None';
				this._rate = 1;
				this._trackId = null;
				this._lockedTrackId = null;
				this._acceptUntil = 0;
				this._loopSupport = null;
				this._chromium = false;

				this._card.update({title: null, artist: null, artUrl: null, playing: false, position: 0, length: 0,
					canControl: false, canPrev: false, canNext: false, canPlay: false, canPause: false, canSeek: false});
				this._scheduleRelisten();
			});
	};

	_applyStatus(status) {
		this._status = status;
		this._playing = status === 'Playing';

		if (status === 'Playing') {
			this._acceptUntil = Date.now() + 1500;

			if (this._chromium) {
				this._refreshMeta();
			};
		};

		if (status === 'Stopped') {
			this._meta = {title: null, artist: null, artUrl: null};
			this._length = 0;
			this._position = 0;
			this._posAt = Date.now();
			this._seekLockUntil = 0;
			this._seekActive = false;
			this._seekFrac = null;
			this._lockedTrackId = null;
		};
	};

	_refreshMeta() {
		if (!this._name || !this._bus) {
			return;
		};

		try {
			this._bus.call(this._name, PLAYER_PATH, DBUS_IFACE, 'Get',
				GLib.Variant.new('(ss)', [PLAYER_IFACE, 'Metadata']), null,
				Gio.DBusCallFlags.NONE, -1, null,
				(_connection, result) => {
					try {
						const reply = _connection.call_finish(result);
						this._handleMetaChange(parseMetadata(reply?.deep_unpack()?.[0]), true);
					} catch (error) {
						// Ignore stale metadata reads.
					};
				});
		} catch (error) {
			// Ignore invalid bus states.
		};
	};

	_handleMetaChange(meta, statusConfirmed = false) {
		if (this._status === 'Stopped') {
			return;
		};

		const displayed = this._meta;
		const sameTrack = meta.title === displayed.title && meta.artist === displayed.artist;

		if (this._chromium) {
			const pinned = Boolean(this._lockedTrackId) && meta.trackId === this._lockedTrackId;
			const acceptNew = Date.now() < this._acceptUntil;

			if (!(pinned && sameTrack) && !acceptNew) {
				return;
			};

			if (!(pinned && sameTrack) && acceptNew) {
				this._acceptUntil = 0;
			};
		};

		if (sameTrack) {
			if (meta.artUrl !== displayed.artUrl) {
				displayed.artUrl = meta.artUrl;
			};

			if (meta.length > 0) {
				this._length = meta.length;
			};

			if (meta.trackId && !this._trackId) {
				this._trackId = meta.trackId;
			};

			if (this._chromium && !this._lockedTrackId && meta.trackId) {
				this._lockedTrackId = meta.trackId;
			};

			return;
		};

		this._meta = {title: meta.title, artist: meta.artist, artUrl: meta.artUrl};

		if (this._chromium) {
			this._lockedTrackId = meta.trackId ?? null;
		};

		if (meta.length > 0) {
			this._length = meta.length;
		};

		if (meta.trackId && meta.trackId !== this._trackId) {
			this._trackId = meta.trackId;
			this._position = 0;
			this._posAt = Date.now();
			this._syncPosition();
		} else if (meta.trackId && !this._trackId) {
			this._trackId = meta.trackId;
		};
	};

	_applyProps(props) {
		const status = variantValue(props.PlaybackStatus) ?? 'Stopped';
		const meta = parseMetadata(variantValue(props.Metadata));
		const position = Number(variantValue(props.Position) ?? 0);
		const trackChanged = meta.trackId && meta.trackId !== this._trackId;

		this._applyStatus(status);

		if (this._status === 'Stopped') {
			this._meta = {title: null, artist: null, artUrl: null};
			this._length = 0;
			this._lockedTrackId = null;
		} else {
			this._meta = {title: meta.title, artist: meta.artist, artUrl: meta.artUrl};
			this._lockedTrackId = meta.trackId ?? null;

			if (meta.length > 0) {
				this._length = meta.length;
			};
		};

		this._canControl = Boolean(variantValue(props.CanControl) ?? false);
		this._canPrev = Boolean(variantValue(props.CanGoPrevious) ?? false);
		this._canNext = Boolean(variantValue(props.CanGoNext) ?? false);
		this._canPlay = Boolean(variantValue(props.CanPlay) ?? false);
		this._canPause = Boolean(variantValue(props.CanPause) ?? false);
		this._canSeek = Boolean(variantValue(props.CanSeek) ?? false);
		this._loop = variantValue(props.LoopStatus) ?? 'None';
		this._loopSupport = props.LoopStatus !== undefined ? null : false;
		this._rate = Number(variantValue(props.Rate) ?? 1) || 1;

		if (trackChanged) {
			this._trackId = meta.trackId;
			this._position = 0;
			this._posAt = Date.now();
		} else if (this._status !== 'Stopped') {
			if (meta.trackId && !this._trackId) {
				this._trackId = meta.trackId;
			};

			if (position > 0) {
				this._position = position;
			};
		};

		this._posAt = Date.now();
		this._lastPosSync = Date.now();
		this._render();

		if (trackChanged || this._playing) {
			this._syncPosition();
		};
	};

	_startTimer() {
		if (this._timerId) {
			return;
		};

		this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
			const now = Date.now();

			if (this._playing) {
				if (now >= this._seekLockUntil && !this._seekActive) {
					this._position = Math.max(0, this._position + (Math.max(0, this._rate) || 1) * (now - this._posAt));
					this._posAt = now;
				};

				if (now - this._lastPosSync > 5000) {
					this._lastPosSync = now;
					this._syncPosition();
				};
			};

			if (now - this._lastPlayerScan > 3000) {
				this._lastPlayerScan = now;
				this._reconsider();
			};

			this._render();
			return GLib.SOURCE_CONTINUE;
		});
	};

	_reconsider() {
		if (this._relisten === false || !this._bus) {
			return;
		};

		let best;

		try {
			best = this._pickActive();
		} catch (error) {
			warn('music: failed to scan MPRIS players', error);
			return;
		};

		if (!best || typeof best.name !== 'string' || !best.name || best.name === this._name) {
			return;
		};

		this._name = best.name;
		this._wire(best.name);
		this._applyProps(best.props);
	};

	_render() {
		if (!this._card) {
			return;
		};

		const now = Date.now();
		const settle = this._seekActive || now < this._seekLockUntil;
		let position = this._position;

		if (this._playing && !settle) {
			position = this._position + (Math.max(0, this._rate) || 1) * (now - this._posAt);
		};

		this._card.update({
			title: this._meta.title,
			artist: this._meta.artist,
			artUrl: this._meta.artUrl,
			playing: this._playing,
			position,
			length: this._length,
			canControl: this._canControl,
			canPrev: this._canPrev,
			canNext: this._canNext,
			canPlay: this._canPlay,
			canPause: this._canPause,
			loop: this._loop,
			canSeek: this._canSeek,
			seekPreview: this._seekActive,
			loopSupported: this._loopSupport,
			forcePrev: this._chromium && this._playing,
			forceNext: this._chromium && this._playing,
		});
	};

	_bindControls() {
		if (this._bound) {
			return;
		};

		this._bound = true;

		const c = this._card;
		const callMethod = method => () => this._callMethod(method);
		const connect = (target, signal, handler) => {
			this._controlSignals.push([target, target.connect(signal, handler)]);
		};

		connect(c.btnLoop.button, 'clicked', () => this._cycleLoop());
		connect(c.btnPrev.button, 'clicked', callMethod('Previous'));
		connect(c.btnPlay.button, 'clicked', callMethod('PlayPause'));
		connect(c.btnNext.button, 'clicked', callMethod('Next'));
		connect(c.slider, 'button-press-event', (_source, event) => this._onSliderPress(event));
		connect(c.slider, 'touch-event', (_source, event) => this._onSliderTouch(event));
	};

	_onSliderTouch(event) {
		const type = event.type();

		if (type !== Clutter.EventType.TOUCH_BEGIN && type !== Clutter.EventType.TOUCH_UPDATE && type !== Clutter.EventType.TOUCH_END) {
			return Clutter.EVENT_PROPAGATE;
		};

		if (this._settings?.get_boolean('edit-mode')) {
			return Clutter.EVENT_PROPAGATE;
		};

		if (!this._card?.slider?.reactive || !this._name) {
			return Clutter.EVENT_PROPAGATE;
		};

		if (type === Clutter.EventType.TOUCH_BEGIN) {
			this._beginSeek(event);
			this._attachSeekCapture();
		} else if (type === Clutter.EventType.TOUCH_UPDATE) {
			this._updateSeek(event);
		} else if (type === Clutter.EventType.TOUCH_END) {
			if (this._seekActive) {
				this._endSeek(event);
				this._detachSeekCapture();
			};
		};

		return Clutter.EVENT_STOP;
	};

	_onSliderPress(event) {
		if (event.get_button() !== 1) {
			return Clutter.EVENT_PROPAGATE;
		};

		if (this._settings?.get_boolean('edit-mode')) {
			return Clutter.EVENT_PROPAGATE;
		};

		if (!this._card?.slider?.reactive || !this._name) {
			return Clutter.EVENT_PROPAGATE;
		};

		this._beginSeek(event);
		this._attachSeekCapture();

		return Clutter.EVENT_STOP;
	};

	_beginSeek(event) {
		const fraction = this._card.fractionForEvent(event);

		if (fraction === null) {
			return;
		};

		this._seekActive = true;
		this._seekFrac = fraction;
		this._positionBeforeSeek = this._position;
		this._card.preview(fraction);
	};

	_updateSeek(event) {
		const fraction = this._card.fractionForEvent(event);

		if (fraction !== null) {
			this._seekFrac = fraction;
			this._card.preview(fraction);
		};
	};

	_endSeek(event) {
		this._seekActive = false;
		this._card.slider?.remove_style_pseudo_class('active');

		const fraction = this._seekFrac !== null ? this._seekFrac : this._card.fractionForEvent(event);

		this._seekFrac = null;

		if (fraction !== null) {
			this._commitSeek(fraction);
		};
	};

	async _readTrackId() {
		if (!this._name) {
			return null;
		};

		const reply = await this._callRemote(this._name, PLAYER_PATH, DBUS_IFACE, 'Get',
			GLib.Variant.new('(ss)', [PLAYER_IFACE, 'Metadata']), null);
		const meta = parseMetadata(reply?.deep_unpack()?.[0]);

		return meta.trackId || null;
	};

	async _commitSeek(fraction) {
		if (!this._name || !this._length) {
			return;
		};

		const target = Math.max(0, Math.min(this._length, Math.floor(this._length * fraction)));
		const trackId = (await this._readTrackId()) || this._trackId || '/org/mpris/MediaPlayer2/TrackList/NoTrack';

		this._position = target;
		this._posAt = Date.now();
		this._lastPosSync = Date.now();
		this._seekLockUntil = Date.now() + 2000;
		this._render();

		const reply = await this._callRemote(this._name, PLAYER_PATH, PLAYER_IFACE, 'SetPosition',
			GLib.Variant.new('(ox)', [trackId, target]), null);

		if (reply === null) {
			const offset = target - this._positionBeforeSeek;
			const seekReply = await this._callRemote(this._name, PLAYER_PATH, PLAYER_IFACE, 'Seek',
				GLib.Variant.new('(x)', [offset]), null);

			if (seekReply === null) {
				warn('music-seek-failed', 'SetPosition and Seek both failed');
			};
		};
	};

	_attachSeekCapture() {
		if (this._seekCapture) {
			return;
		};

		this._seekCapture = true;

		global.stage.connectObject('captured-event', (_stage, event) => {
			const eventType = event.type();
			const isMotion = eventType === Clutter.EventType.MOTION ||
				eventType === Clutter.EventType.MOTION_NOTIFY ||
				eventType === Clutter.EventType.TOUCH_BEGIN ||
				eventType === Clutter.EventType.TOUCH_UPDATE;
			const isRelease = eventType === Clutter.EventType.BUTTON_RELEASE || eventType === Clutter.EventType.TOUCH_END;

			if (isMotion && this._seekActive) {
				this._updateSeek(event);
				return Clutter.EVENT_STOP;
			};

			if (isRelease && this._seekActive) {
				this._endSeek(event);
				this._detachSeekCapture();
				return Clutter.EVENT_STOP;
			};

			return Clutter.EVENT_PROPAGATE;
		}, this);
	};

	_detachSeekCapture() {
		if (!this._seekCapture) {
			return;
		};

		this._seekCapture = false;
		global.stage.disconnectObject(this);
	};

	_syncPosition() {
		if (!this._name || !this._bus) {
			return;
		};

		try {
			this._bus.call(this._name, PLAYER_PATH, DBUS_IFACE, 'Get',
				GLib.Variant.new('(ss)', [PLAYER_IFACE, 'Position']), null,
				Gio.DBusCallFlags.NONE, -1, null,
				(_connection, result) => {
					try {
						const reply = _connection.call_finish(result);
						const value = variantValue(reply?.deep_unpack()?.[0]);

						this._position = Math.max(0, Number(value ?? this._position));
						this._posAt = Date.now();
						this._render();
					} catch (error) {
						// Ignore stale position reads.
					};
				});
		} catch (error) {
			// Ignore invalid bus states.
		};
	};

	_cycleLoop() {
		if (this._loopSupport === false) {
			return;
		};

		const next = LOOP_CYCLE[(LOOP_CYCLE.indexOf(this._loop) + 1) % LOOP_CYCLE.length];

		this._setLoop(next);
	};

	async _setLoop(next) {
		if (!this._name || this._loopSupport === false) {
			return;
		};

		const reply = await this._callRemote(this._name, PLAYER_PATH, DBUS_IFACE, 'Set',
			GLib.Variant.new('(ssv)', [PLAYER_IFACE, 'LoopStatus', new GLib.Variant('s', next)]), null);

		if (reply !== null) {
			this._loop = next;
			this._loopSupport = true;
		} else if (this._loopSupport !== false) {
			this._loopSupport = false;
			warn('music-loop-unsupported', 'the player does not support setting LoopStatus');
		};

		this._render();
	};

	async _callMethod(method) {
		if (!this._name) {
			return;
		};

		const call = (m) => this._callRemote(this._name, PLAYER_PATH, PLAYER_IFACE, m, null, null);

		if (method === 'PlayPause') {
			const reply = await call('PlayPause');

			if (reply === null) {
				if (this._playing) {
					await call('Pause');
				} else {
					await call('Play');
				};
			};

			return;
		};

		await call(method);
	};

	_scheduleRelisten() {
		if (this._relisten === false || this._retryTimer) {
			return;
		};

		this._retryTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
			this._retryTimer = 0;

			if (this._relisten) {
				this._name = null;
				this.start();
			};

			return GLib.SOURCE_REMOVE;
		});
	};

	destroy() {
		this._relisten = false;

		if (this._timerId) {
			GLib.source_remove(this._timerId);
			this._timerId = 0;
		};

		if (this._retryTimer) {
			GLib.source_remove(this._retryTimer);
			this._retryTimer = 0;
		};

		this._detachSeekCapture();

		for (const id of this._subIds) {
			this._bus?.signal_unsubscribe(id);
		};

		this._subIds = [];

		if (this._watchId) {
			this._bus?.unwatch_name(this._watchId);
			this._watchId = 0;
		};

		if (this._card) {
			stopEmptyGif(this._card);
		};

		if (this._settingsId && this._settings) {
			this._settings.disconnect(this._settingsId);
			this._settingsId = 0;
		};

		for (const [target, id] of this._controlSignals) {
			try {
				target.disconnect(id);
			} catch (error) {
				// Ignore disconnect failures.
			};
		};

		this._controlSignals = [];

		this._card = null;
	};
};

let cachedBus = null;

function sessionBus() {
	if (cachedBus === null) {
		try {
			cachedBus = Gio.DBus.session;
		} catch (error) {
			warn('music: no session bus', error);
			cachedBus = undefined;
		};
	};

	return cachedBus;
};

export function render({body, createLabel, theme, sizeForWidget, widget, settings}) {
	const [widgetWidth, widgetHeight] = sizeForWidget ? sizeForWidget(widget) : [454, 220];
	const card = createCard(theme, createLabel, widgetWidth, widgetHeight);
	card._settings = settings;
	const controller = new Controller(card, sessionBus(), settings);

	body.add_child(card.container);
	body.connect('destroy', () => controller.destroy());
	controller.start();
};