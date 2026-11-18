import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import { warn } from '../../logger.js';
import { widgetResourcePath } from '../../paths.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { boxLayoutProps } from '../../utils/gnomeCompat.js';
import { SeekBar } from '../../lib/seekBar.js';
import { createMarquee } from '../../lib/marquee.js';
import { bounceButton, bindHoverShrink } from '../../lib/buttonBounce.js';
import { getDataDir, parseCssColor } from '../../utils/ported.js';
import { isActorDestroyed } from '../../utils/actorLifecycle.js';
import { lineIndexAt, resolveLyrics } from '../../lib/lyrics.js';
export const type = 'music';
export const label = 'Music';
export const stylesheet = 'widgets/music/stylesheet.css';
export const defaultSize = 'medium';
export const supportedSizes = ['mini', 'medium'];
export const appIds = ['org.gnome.Music', 'io.bassi.Amberol', 'org.videolan.VLC'];
export const customAppKey = 'music-custom-app';


// Is a color emoji font (Noto Color Emoji, Twemoji, JoyPixels…) installed?
// Checked once: without one, emoji render as white boxes in the shell.
let colorEmojiFont = null;
function hasColorEmojiFont() {
	if (colorEmojiFont !== null)
		return colorEmojiFont;
	try {
		colorEmojiFont = PangoCairo.FontMap.get_default().list_families()
			.some(family => /emoji/i.test(family.get_name()));
	} catch (_e) {
		colorEmojiFont = false;
	}
	return colorEmojiFont;
};

const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PLAYER_PATH = '/org/mpris/MediaPlayer2';
const DBUS_IFACE = 'org.freedesktop.DBus.Properties';
const TICK_MS = 2000;
const LOOP_CYCLE = ['None', 'Track', 'Playlist'];
// The system monitor's cross constants, copied 1:1: the 250ms base beat
// and the cross sweep at exactly twice it.
const SWIPE_THRESHOLD = 30;
const ANIMATION_DURATION = 250;
const CROSS_DURATION = Math.round(ANIMATION_DURATION * 2); // 500ms
// Cover fallback: every candidate GIF is decoded once and cached, so cards
// after the first one paint instantly instead of re-reading the file.
const GIF_CANDIDATES = ['pushy.gif', 'pushy2.gif', 'pushy3.gif', 'pushy4.gif', 'pushy5.gif'];
// Each cache entry holds up to ~240 decoded frames; without a cap a session
// that sweeps through many GIFs grows the shell's memory without bound.
const GIF_CACHE_LIMIT = 4;
const gifFramesCache = new Map();
function cacheGifFrames(path, frames) {
	if (gifFramesCache.has(path)) {
		gifFramesCache.delete(path);
	};

	gifFramesCache.set(path, frames);

	if (gifFramesCache.size > GIF_CACHE_LIMIT) {
		gifFramesCache.delete(gifFramesCache.keys().next().value);
	};
}
const CHROMIUM_MARKERS = ['chromium', 'chrome', 'brave', 'vivaldi', 'opera', 'edge', 'yandex', 'thorium', 'helium', 'firefox'];

function isChromiumName(name) {
	const lower = String(name ?? '').toLowerCase();

	return CHROMIUM_MARKERS.some(marker => lower.includes(marker));
};

let emptyGifPathCached = undefined;

function findGif(names) {
	for (const name of names) {
		const bundled = widgetResourcePath('music', name);
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

// GdkPixbuf GIF decode — runs in an idle so it doesn't block the UI thread.
// The 240-frame loop + pixel comparison can take 50-200 ms on a large GIF;
// yielding to the main loop every N frames keeps compositor latency healthy.
function pixbufFramesAsync(path, onDone) {
	let frames = [];
	let firstPixels = null;
	let animation, iter, guard;

	try {
		animation = GdkPixbuf.PixbufAnimation.new_from_file(path);
		iter = animation.get_iter(null);
		guard = 0;
	} catch (error) {
		warn('music: failed to open gif animation', error);
		onDone([]);
		return;
	};

	// Process up to CHUNK frames per idle tick so the UI stays responsive.
	const CHUNK = 8;
	const idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
		let count = 0;
		while (guard++ < 240 && count++ < CHUNK) {
			let pixbuf, pixels;
			try {
				pixbuf = iter.get_pixbuf();
				pixels = pixbuf.get_pixels();
			} catch (error) {
				warn('music: failed to read gif frame', error);
				onDone(frames);
				return GLib.SOURCE_REMOVE;
			};

			if (firstPixels && arraysEqual(pixels, firstPixels)) {
				onDone(frames);
				return GLib.SOURCE_REMOVE;
			};

			const icon = pixbufToBytesIcon(pixbuf);
			if (!icon) {
				onDone(frames);
				return GLib.SOURCE_REMOVE;
			};

			if (!firstPixels) {
				firstPixels = pixels;
			};

			frames.push({icon, delay: Math.max(40, iter.get_delay_time())});

			let advanced = false;
			try {
				advanced = iter.advance(null);
			} catch (_e) {}
			if (!advanced) {
				onDone(frames);
				return GLib.SOURCE_REMOVE;
			};
		};

		if (guard >= 240) {
			onDone(frames);
			return GLib.SOURCE_REMOVE;
		};

		return GLib.SOURCE_CONTINUE;
	});
	return idleId;
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
			cacheGifFrames(path, decoded);
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

			// ffmpeg fallback: decode via GdkPixbuf asynchronously (idle-chunked)
			// so the 240-frame pixel loop does not block the compositor.
			pixbufFramesAsync(path, decoded => {
				finish(decoded.length > 1 ? decoded : null);
			});
		});
		return;
	};

	// No ffmpeg: decode via idle-chunked GdkPixbuf path.
	pixbufFramesAsync(path, decoded => {
		finish(decoded.length > 1 ? decoded : null);
	});
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
		trackUrl: variantValue(md['xesam:url']) ?? null,
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

// Control icons: gray when inactive, white/black when active
function controlIconFile(theme, iconName, isActive = false) {
	const suffix = isActive 
		? (theme?.dark ? '-white' : '-black')
		: '';
	return widgetResourcePath('music', `dw-${iconName}${suffix}.svg`);
};

function controlIcon(theme, iconName, isActive = false) {
	const file = controlIconFile(theme, iconName, isActive);

	return file && Gio.File.new_for_path(file).query_exists(null)
		? Gio.FileIcon.new(Gio.File.new_for_path(file))
		: null;
};

// Loop-control icons painted in the widget accent color (system accent or
// style-accent-color). St.Icon + FileIcon renders these fine, so the SVG is
// recolored on disk in a per-(icon,state,accent) cache file.
function controlAccentIcon(theme, iconName, isActive = false) {
	const accent = String(theme?.accent ?? '#5b9de0');
	const file = controlIconFile(theme, iconName, isActive);

	if (!file || !Gio.File.new_for_path(file).query_exists(null)) {
		return null;
	};

	const id = `${String(iconName)}-${isActive ? 1 : 0}-${accent.replace(/[^a-zA-Z0-9]/g, '_')}`;
	const cachePath = GLib.build_filenamev([
		GLib.get_user_cache_dir(), 'desktop-widgets', 'music-icons', `${id}.svg`,
	]);

	try {
		if (!Gio.File.new_for_path(cachePath).query_exists(null)) {
			const [ok, contents] = Gio.File.new_for_path(file).load_contents(null);

			if (ok) {
				const svg = new TextDecoder().decode(contents)
					.replace(/stroke="[^"]*"/g, `stroke="${accent}"`)
					.replace(/fill="(?!none)[^"]*"/g, `fill="${accent}"`);

				GLib.mkdir_with_parents(GLib.path_get_dirname(cachePath), 0o755);
				Gio.File.new_for_path(cachePath).replace_contents(svg, null, false, Gio.FileCreateFlags.NONE, null);
			};
		};

		return Gio.FileIcon.new(Gio.File.new_for_path(cachePath));
	} catch (_error) {
		// Fall back to the plain variant rather than an invisible icon.
		return controlIcon(theme, iconName, isActive);
	};
};

// Click squash-and-spring lives in lib/buttonBounce.js (shared with the
// stopwatch/timer/pomodoro/task buttons) and is wired in createControlButton.

// Control buttons: plain St.Button + St.Icon with the bundled SVG, exactly
// like the reference implementation (gray when inactive, white/black when
// active). No cairo painting; click gets a squash-and-spring bounce.
function createControlButton(theme, iconName, iconSize = 18, padding = 4, radius = 9, isActive = false, accentPainted = false) {
	const gicon = accentPainted
		? controlAccentIcon(theme, iconName, isActive)
		: controlIcon(theme, iconName, isActive);

	const icon = new St.Icon({
		gicon,
		style: `icon-size: ${iconSize}px;`
	});

	const button = new St.Button({
		style_class: 'widget-music-button',
		can_focus: false,
		reactive: true,
		style: `border-radius: ${radius}px; padding: ${padding}px;`,
	});

	button._iconSize = iconSize;
	button._iconName = iconName;
	button._theme = theme;
	button._isActive = isActive;
	button._accentIcon = accentPainted;
	button.set_child(icon);
	button.set_width(27);
	button.set_height(27);
	button.set_pivot_point(0.5, 0.5);
	button.connect('clicked', () => bounceButton(button));
	// Hover = no frame, just the icon briefly shrinking (shared with every
	// other widget's buttons); the click keeps the squash-and-spring bounce.
	bindHoverShrink(button);

	return {button, icon};
};

function recolorIcon(target, alpha = 1) {
	target.icon.style = `icon-size: ${target.button._iconSize ?? 18}px;${alpha < 1 ? ` opacity: ${alpha};` : ''}`;
};

function setButtonIcon(target, iconName, isActive = false) {
	const gicon = target.button._accentIcon
		? controlAccentIcon(target.button._theme, iconName, isActive)
		: controlIcon(target.button._theme, iconName, isActive);

	if (gicon) {
		// Clear the textual name first: St.Icon keeps whichever source was
		// set last, and swapping only the gicon left the old bars painted.
		target.icon.icon_name = '';
		target.icon.gicon = gicon;
		target.button._iconName = iconName;
		target.button._isActive = isActive;
	}
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

	card.container = new St.BoxLayout(boxLayoutProps({
		x_expand: true,
		y_expand: true,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${gap}px;`,
	}));

	// Bin wrapper so the lyrics overlay can cover the WHOLE widget instead
	// of only the cover-art preview: the card is the lower layer, the lyrics
	// feed slides above it while open and closes on a click.
	card.stage = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
	card.stage.add_child(card.container);

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

	// ── Lyrics overlay ────────────────────────────────────────────────────
	// The top-right status icon doubles as the toggle: a click swaps the
	// cover art for a synced lyrics feed. The resolution chain lives in
	// lib/lyrics.js (local .lrc -> lrclib.net -> cached); any failure just
	// keeps the cover art in place.
	card._lyricsDir = getDataDir('lyrics');
	card._lyricsOn = false;
	card._lyricsToken = 0;
	card._lyricsKey = null;
	card._lyricsMeta = null;
	card._lyricsLines = null;
	card._lyricsSynced = false;
	card._lyricsLabels = [];
	card._lyricsActive = -1;

	// Isle's lyric presentation constants, ported from
	// isle@zickrian.github.io/src/pages/lyrics.js: the sung line bright,
	// the following three fading by distance, sung lines dimmest, the rest
	// slightly smaller (scale around the left pivot); scroll anchors the
	// sung line at 36% of the viewport and a manual scroll parks the
	// follow for 4 s.
	const LYR_CURRENT_OPACITY = 255;
	const LYR_COMING_OPACITY = [150, 115, 90];
	const LYR_SUNG_OPACITY = 75;
	const LYR_RESTING_SCALE = 0.93;
	const LYR_LINE_EASE_MS = 380;
	const LYR_SCROLL_EASE_MS = 150;  // Reduced from 520ms for instant snap
	const LYR_ANCHOR = 0.36;
	const LYR_MANUAL_HOLD_MS = 4000;
	const LYR_INTRO_MS = 3;
	// Isle's dynamic scheduling: +30ms buffer after the exact line timestamp
	// to ensure the position has definitely crossed the threshold.
	const LYR_SCHEDULE_BUFFER_MS = 30;
	// How far AHEAD of the player position lines switch (ms). Isle uses none:
	// a line lights up exactly at its timestamp. The old constant was -350
	// and was ADDED to the position, so every line switched 350 ms LATE
	// (its comment meant "early" — the sign was inverted). The lag it tried
	// to cover came from position bugs fixed below (re-anchored Playing
	// status, stale positions passed to instant re-syncs).
	const LYR_LEAD_MS = 0;

	const lyrFont = Math.max(11, Math.round(widgetHeight * 0.09));
	const lyricStyleInactive = `font-size: ${lyrFont}px; color: ${theme.muted};`;
	const lyricStyleActive = `font-size: ${lyrFont}px; font-weight: 700; color: ${theme.accent};`;

	card._lyricsManualUntil = 0;
	card._lyricsPlaying = false;
	card._lyricsScrollPending = -1;
	card._lyricsOpacities = [];
	card._lyricsScales = [];
	card._lyricsUpperHooked = false;
	card._lyricsScheduledUpdate = null;
	card._controller = null; // Reference to controller for position calculation

	// Panel structure (proven primitives only): a vertical Box with the
	// badge row on top — the music icon anchors top-right even while the
	// overlay is open — over a Bin layer where the feed fills the area and
	// the hint floats centered over it (same centering the cover icon uses).
	// Panel structure: vertical box with badge header row at top and lyrics
	// feed below, maximizing vertical space while keeping the music icon
	// visible and clickable in the top-right corner.
	card.lyricsPanel = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		x_expand: true,
		y_expand: true,
		visible: false,
		reactive: true,
		// Minimal padding for maximum lyrics viewport.
		style: `border-radius: ${coverRadius}px; padding: 2px 10px 2px 10px;`,
	}));

	// Compact badge row: music icon in top-right, minimal height.
	const badgeRow = new St.BoxLayout(boxLayoutProps({
		x_expand: true,
		style: 'height: 24px;',
	}));
	card._lyricsBadge = new St.Button({
		child: new St.Icon({
			gicon: controlIcon(theme, 'music', true),
			style: 'icon-size: 16px;',
		}),
		x_align: Clutter.ActorAlign.END,
		style: 'padding: 2px;',
	});
	bindHoverShrink(card._lyricsBadge);
	card._lyricsBadge.connect('clicked', () => {
		bounceButton(card._lyricsBadge);
		card.toggleLyrics();
	});
	badgeRow.add_child(new St.Widget({x_expand: true}));
	badgeRow.add_child(card._lyricsBadge);
	card.lyricsPanel.add_child(badgeRow);

	card._lyricsFeed = new St.Widget({
		layout_manager: new Clutter.BinLayout(),
		x_expand: true,
		y_expand: true,
	});

	card._lyricsBox = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		// Normal spacing for readable multi-line wrapped lyrics.
		// Top/bottom padding prevents text clipping at container edges.
		style: 'spacing: 3px; padding: 8px 0px 8px 0px;',
	}));
	card._lyricsScroll = new St.ScrollView({
		x_expand: true,
		y_expand: true,
		style: 'padding: 0px; margin: 0px;',
	});
	card._lyricsScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.EXTERNAL);
	card._lyricsScroll.add_child(card._lyricsBox);
	card._lyricsFeed.add_child(card._lyricsScroll);

	const hintFont = Math.max(14, Math.round(widgetHeight * 0.11));
	card._lyricsHint = createLabel('…', 'widget-music-lyric',
		`font-size: ${hintFont}px; font-weight: 700; color: ${theme.text};`);
	card._lyricsHint.clutter_text.single_line_mode = true;
	card._lyricsHint.clutter_text.ellipsize = Pango.EllipsizeMode.END;
	card._lyricsHint.x_align = Clutter.ActorAlign.CENTER;
	card._lyricsHint.y_align = Clutter.ActorAlign.CENTER;
	card._lyricsFeed.add_child(card._lyricsHint);

	card.lyricsPanel.add_child(card._lyricsFeed);

	// The panel covers the whole card, so a click anywhere on it returns to
	// the normal card (including the badge — it is a passive mirror of the
	// toggle icon beneath).
	card.lyricsPanel.connect('button-press-event', (actor, event) => {
		// Only the LEFT button closes — the right button is the cross
		// swipe's press leg; toggling on it tore the gesture mid-flight.
		if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
		card.toggleLyrics();
		return Clutter.EVENT_PROPAGATE;
	});
	// Isle's manual-scroll hold after a user scroll (wheel/touchpad): the
	// auto-follow parks for 4 s instead of fighting the hand — and the
	// running scroll tween stops mid-flight, since it would otherwise keep
	// dragging the view against the fingers (their remove_transition
	// analog here is killing the hand-rolled tween — St-51 lacks
	// st_adjustment_ease).
	card.lyricsPanel.connect('scroll-event', () => {
		card._lyricsManualUntil = Date.now() + LYR_MANUAL_HOLD_MS;
		if (card._lyricsScrollTween) {
			GLib.source_remove(card._lyricsScrollTween);
			card._lyricsScrollTween = null;
		};
		return Clutter.EVENT_PROPAGATE;
	});
	card.stage.add_child(card.lyricsPanel);

	card._setLyricsHint = function (text) {
		card._lyricsHint.text = text;
		card._lyricsHint.visible = Boolean(text);
	};

	// Breathing «…» while the resolver runs: a chained in/out ease that
	// stops the moment real content (or the miss hint) lands.
	card._startLyricsWait = function () {
		if (card._lyricsWaitOn) {
			return;
		};
		card._lyricsWaitOn = true;

		const step = () => {
			if (!card._lyricsWaitOn || !card._lyricsHint.mapped) {
				card._stopLyricsWait();
				return;
			};

			card._lyricsHint.ease({
				opacity: 70,
				duration: 650,
				mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
				onComplete: () => {
					if (!card._lyricsWaitOn) {
						return;
					};

					card._lyricsHint.ease({
						opacity: 255,
						duration: 650,
						mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
						onComplete: step,
					});
				},
			});
		};

		step();
	};

	card._stopLyricsWait = function () {
		card._lyricsWaitOn = false;

		if (card._lyricsHint) {
			card._lyricsHint.remove_all_transitions();
			card._lyricsHint.opacity = 255;
		};
	};

	card._resetLyricsFeed = function () {
		card._stopLyricsWait();

		// A follow tween must never write into a feed that is being torn
		// down or replaced.
		if (card._lyricsScrollTween) {
			GLib.source_remove(card._lyricsScrollTween);
			card._lyricsScrollTween = null;
		};

		for (const child of card._lyricsBox.get_children()) {
			// Rows with repeat:-1 breathing anims must stop before removal
			// (a detached actor would keep easing off-stage forever).
			if (child._setBreathing) {
				child._setBreathing(false);
			};
			card._lyricsBox.remove_child(child);
		};

		card._lyricsLabels = [];
		card._lyricsActive = -1;
		card._lyricsSynced = false;
		// A rebuilt feed follows again: the manual park is tied to the old
		// rows (Isle resets the hold on every track rebuild too).
		card._lyricsManualUntil = 0;
		card._lyricsScrollPending = -1;
		card._lyricsOpacities = [];
		card._lyricsScales = [];
	};

	card._buildLyrics = function (result) {
		card._resetLyricsFeed();

		const hasLyrics = result && Array.isArray(result.lines) && result.lines.length > 0;

		if (!hasLyrics) {
			card._lyricsLines = null;
			card._setLyricsHint(_('No lyrics found'));
			return;
		};

		card._lyricsSynced = Boolean(result.synced);
		
		// Convert to milliseconds immediately (match Isle's data structure exactly)
		// This ensures indices align correctly between _lyricsLines and _lyricsLabels
		let linesMs = result.lines.map(line => ({
			time_ms: line.time * 1000,  // seconds → milliseconds
			text: line.line || ''
		}));

		if (card._lyricsSynced) {
			// Isle's long-intro rule: a song whose first line comes late
			// opens with the breathing pause dots at 0:00.
			if (linesMs.length > 0 && linesMs[0].time_ms > LYR_INTRO_MS) {
				linesMs = [{time_ms: 0, text: ''}, ...linesMs];
			};
		};

		// Store the millisecond-based array (matches Isle's structure)
		card._lyricsLines = linesMs;

		for (const entry of linesMs) {
			const row = entry.text ? buildLyricLine(entry.text, entry.time_ms) : buildPauseDots(entry.time_ms);

			card._lyricsBox.add_child(row);
			card._lyricsLabels.push(row);
		};

		// Isle's end spacer: room after the last line, so it too can scroll
		// up to the reading anchor (padding would not do: St takes it off
		// the scrolled view).
		if (card._lyricsLabels.length > 0) {
			card._lyricsBox.add_child(new St.Widget({
				x_expand: true,
				style: `height: ${Math.round(lyrFont * (card._lyricsSynced ? 4.5 : 1.5))}px;`,
			}));
		};

		card._setLyricsHint('');

		// Wrapped rows reflow when the container width changes (window
		// resize, widget scale): the adjustment's upper limit changes, and
		// the active line's allocation moves — re-anchor it unless a manual
		// scroll hold is parked (Isle's relayout hook), once per feed.
		if (!card._lyricsUpperHooked && card._lyricsScroll.vadjustment) {
			card._lyricsUpperHooked = true;
			card._lyricsScroll.vadjustment.connect('notify::upper', () => {
				if (card._lyricsOn && card._lyricsSynced && Date.now() >= card._lyricsManualUntil) {
					// Force re-scroll without changing the active row by
					// resetting the active index so the tick sees a change.
					const same = card._lyricsActive;
					card._lyricsActive = -2;
					card._tickLyrics(card._lyricsPositionUs ?? 0);
				};
			});
		};

		// Landing on a line mid-song (toggle open, track switch): the
		// ladder sets in one shot, then the follow scroll snaps to the
		// anchor on the same frame.
		card._tickLyrics(card._lyricsPositionUs ?? 0, { shown: true });
	};

	// One lyric line: multi-line wrap on word boundaries (char fallback —
	// the WORD_CHAR rule), no truncation and no ellipsis, so a long line
	// keeps its full text at any card width and simply grows the block.
	// Synced rows are reactive (Isle): a click jumps the player to the
	// line's stamp through the seek hook; stopping the press also keeps
	// the panel's own close-on-click handler out of the way.
	function buildLyricLine(text, timeMs) {
		// Isle's instrumental fallback: empty text shows ♪ music note
		const displayText = text.trim() || '♪';
		const row = new St.Label({
			text: displayText,
			x_align: Clutter.ActorAlign.START,
			// Resting state: dimmest-comer opacity + slightly smaller, as
			// Isle's rows are built before their first follow().
			opacity: card._lyricsSynced ? LYR_COMING_OPACITY.at(-1) : 140,
			style: card._lyricsSynced ? lyricStyleInactive : lyricStyleInactive,
		});
		row.clutter_text.single_line_mode = false;
		row.clutter_text.line_wrap = true;
		row.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
		row.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
		row._styleInactive = lyricStyleInactive;
		row._styleActive = lyricStyleActive;

		if (card._lyricsSynced) {
			row.reactive = true;
			row.set_pivot_point(0, 0.5);
			row.set_scale(LYR_RESTING_SCALE, LYR_RESTING_SCALE);
			row.connect('button-press-event', (actor, event) => {
				if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
				if (typeof card._lyricsSeekUs === 'function') {
					// Convert milliseconds to microseconds for MPRIS (Isle does: line.time_ms * 1000)
					card._lyricsSeekUs(Math.round(timeMs * 1000));
				};
				return Clutter.EVENT_STOP;
			});
		};

		return row;
	};

	// Isle's instrumental pause row: a single subtle music note (♪) that
	// pulses gently when active, left-aligned to match lyric text flow —
	// no plain text dots, matching Isle's top-bar overlay instrumental
	// indicator. The note responds to the active state (accent color, full
	// opacity) just like text lines do.
	function buildPauseDots(timeMs) {
		const row = new St.BoxLayout(boxLayoutProps({
			vertical: false,
			x_align: Clutter.ActorAlign.START,
			y_align: Clutter.ActorAlign.CENTER,
			style: `height: ${Math.round(lyrFont * 1.4)}px;`,
		}));

		const noteSize = Math.round(lyrFont * 1.1);
		const note = new St.Label({
			text: '♪',
			x_align: Clutter.ActorAlign.START,
			y_align: Clutter.ActorAlign.CENTER,
			// Extra line-height prevents top/bottom clipping of the glyph.
			// Color and opacity are set dynamically by the ladder.
			style: `font-size: ${noteSize}px; line-height: ${Math.round(noteSize * 1.3)}px; padding: 2px 0px;`,
		});
		note.set_pivot_point(0, 0.5);
		row.add_child(note);

		row._isDotsRow = true;
		row._noteChild = note;
		row._setBreathing = (on) => {
			if (on === row._breathing) return;
			row._breathing = on;
			note.remove_all_transitions();
			note.set_scale(1, 1);
			if (!on || !row.mapped) {
				// When not breathing, the ladder's opacity takes over
				// (set via row.opacity in applyRow).
				return;
			};
			try {
				if (St.Settings.get().enable_animations) {
					note.ease({
						scale_x: 1.15,
						scale_y: 1.15,
						duration: 800,
						mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
						autoReverse: true,
						repeatCount: -1,
					});
				};
			} catch (error) {};
		};

		if (card._lyricsSynced) {
			row.reactive = true;
			row.connect('button-press-event', (actor, event) => {
				if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
				if (typeof card._lyricsSeekUs === 'function') {
					// Convert milliseconds to microseconds for MPRIS
					card._lyricsSeekUs(Math.round(timeMs * 1000));
				};
				return Clutter.EVENT_STOP;
			});
		};

		return row;
	};

	card.toggleLyrics = function ({ animated = false, next = true } = {}) {
		if (card._coverSize < 64 || !(card._lyricsMeta && card._lyricsMeta.title)) {
			return;
		};
		if (card.crossBusy) {
			return;
		};

		const goingLyrics = !card._lyricsOn;
		card._lyricsOn = goingLyrics;

		// ── Instant swap (click path), plus the cold-start fallback: a
		// stage without a real allocation yet cannot measure a page, so it
		// flips without a flight (the system cross's cold-start branch).
		const stageBox = card.stage.get_allocation_box();
		const pageW = Math.floor(stageBox.get_width());
		if (!animated || pageW < 32) {
			card.lyricsPanel.visible = card._lyricsOn;
			// Hide entire card content when showing lyrics (glass mode shows only text)
			card.container.visible = !card._lyricsOn;
			if (card._lyricsOn) {
				// Same-track reopen reuses the existing feed; an empty feed
				// (previous lookup failed) forces a retry.
				card._loadLyrics(card._lyricsLabels.length === 0);
			};
			return;
		};

		// ── The cross (swipe path) — the system monitor's page flight,
		// copied 1:1: both pages live side by side in the stage bin, start
		// exactly one baseDistance apart (base = pageW + pageW/16, GNOME's
		// baseDistance), and travel by their own translations in lockstep —
		// EASE_OUT_CUBIC over CROSS_DURATION on both travellers, nothing
		// fades, the pages never overlap; the only thing crossing the pane
		// is the seam between them. No page dashes here on purpose.
		const base = pageW + Math.round(pageW / 16);

		card.crossBusy = true;
		const leaving = goingLyrics ? card.container : card.lyricsPanel;
		const entering = goingLyrics ? card.lyricsPanel : card.container;

		// The arriving page waits exactly one baseDistance off-stage; the
		// offset lands BEFORE it turns visible — no flash at its old spot.
		entering.translation_x = next ? base : -base;
		entering.visible = true;

		if (goingLyrics) {
			// Real content rides in: start the resolve at the flight start
			// (the same call and the same retry rule the click toggle uses),
			// the way the system cross pushes live data onto both pages.
			card._loadLyrics(card._lyricsLabels.length === 0);
		};

		leaving.ease({
			translation_x: next ? -base : base,
			duration: CROSS_DURATION,
			mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
			onComplete: () => {
				if (isActorDestroyed(leaving)) return;
				leaving.visible = false;
				// The slot resets for the next flight, the way the system
				// cross re-lays its rows once the pages settle.
				leaving.translation_x = 0;
			},
		});
		entering.ease({
			translation_x: 0,
			duration: CROSS_DURATION,
			mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
			onComplete: () => {
				// The arriving page is the page now on duty — same as the
				// system cross's onComplete wiring.
				card.crossBusy = false;
			},
		});
	};

	card._loadLyrics = function (force = false) {
		const meta = card._lyricsMeta;

		if (!meta || !meta.title) {
			card._setLyricsHint(_('Play something to get going'));
			return;
		};

		const key = `${meta.artist ?? ''}|${meta.title}`;
		if (!force && key === card._lyricsKey) {
			return;
		};

		card._lyricsKey = key;
		card._lyricsToken += 1;
		const token = card._lyricsToken;
		card._setLyricsHint('…');
		card._startLyricsWait();

		resolveLyrics({
			artist: meta.artist,
			title: meta.title,
			durationUs: meta.length,
			trackUrl: meta.trackUrl,
			dir: card._lyricsDir,
		}).then(result => {
			if (token !== card._lyricsToken) {
				// A newer track (or toggle cycle) superseded this lookup.
				return;
			};

			card._buildLyrics(result);
		}).catch(error => {
			if (token !== card._lyricsToken) {
				return;
			};

			card._buildLyrics(null);
		});
	};

	// ── System-cross swipe over the whole card ────────────────────────────
	// Copied from the system monitor's gesture: right-button press-drag-
	// release, threshold 30px, serialized by crossBusy — a swipe during a
	// travelling cross is swallowed. The left button stays free for the
	// controls and the click toggles above; drag left plays "next".
	card.stage.reactive = true;
	let swipeStartX = null;

	card.stage.connect('button-press-event', (actor, event) => {
		if (event.get_button() !== 3) return Clutter.EVENT_PROPAGATE;
		swipeStartX = event.get_coords()[0];
		return Clutter.EVENT_PROPAGATE;
	});

	card.stage.connect('button-release-event', (actor, event) => {
		if (swipeStartX === null) return Clutter.EVENT_PROPAGATE;
		const startX = swipeStartX;
		swipeStartX = null;
		const delta = event.get_coords()[0] - startX;

		if (Math.abs(delta) < SWIPE_THRESHOLD) return Clutter.EVENT_STOP;
		if (card.crossBusy) return Clutter.EVENT_STOP;

		card.toggleLyrics({ animated: true, next: delta < 0 });
		return Clutter.EVENT_STOP;
	});

	// Follow hook: highlights the line being sung and glides it to the
	// reading anchor — ported from isle@zickrian.github.io's
	// LyricsPane.follow(): opened-at-once rows (`shown`) skip the ease;
	// opacity/scale ladders only touch rows that actually change; a manual
	// scroll hold parks the SCROLL (highlighting keeps running); pause-dot
	// rows breathe only with the playing state.
	card._tickLyrics = function (positionUs, { shown = false } = {}) {
		// Kept for the rebuild path (_buildLyrics lands mid-song).
		card._lyricsPositionUs = positionUs;

		if (!card._lyricsSynced || card._lyricsLabels.length === 0) {
			return;
		};

		// Off stage (panel closed or not mapped yet) nothing eases or
		// scrolls: rows hold their states, and the shown path explicitly
		// bypasses so a mid-flight rebuild still lands dressed.
		if (!shown && (!card._lyricsOn || !card.lyricsPanel.mapped)) {
			return;
		};

		// Convert microseconds to milliseconds and apply fine-tuned offset
		// to compensate for audio output buffer latency + UI rendering lag.
		const positionMs = (positionUs / 1000) + LYR_LEAD_MS;
		
		// Binary search: find LAST index where line.time_ms <= positionMs
		// This matches Isle's exact logic - finds the currently ACTIVE line.
		// Line N is active from lines[N].time_ms up until lines[N+1].time_ms
		let index = -1;
		let low = 0;
		let high = card._lyricsLines.length - 1;
		while (low <= high) {
			const mid = (low + high) >> 1;
			if (card._lyricsLines[mid].time_ms <= positionMs) {
				index = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}

		if (index < 0 || (index === card._lyricsActive && !shown && card._lyricsScrollPending < 0)) {
			return;
		};

		// Per-row last eased values (Isle's `follow`): only rows that
		// actually change get a tween, the rest keep easing where they are.
		if (card._lyricsOpacities?.length !== card._lyricsLabels.length) {
			card._lyricsOpacities = card._lyricsLabels.map(() => -1);
			card._lyricsScales = card._lyricsLabels.map(() => -1);
		};

		const applyRow = (row, i, opacity, scale, immediate) => {
			// Text rows get active/inactive styles; instrumental note rows
			// get active accent color or inactive muted color based on the
			// opacity ladder (current line = accent + full opacity).
			if (row._styleActive) {
				row.style = opacity >= 255 ? row._styleActive : row._styleInactive;
			} else if (row._noteChild) {
				// Instrumental note: change color to accent when active,
				// muted when inactive. The row's opacity is applied on top.
				const color = opacity >= 255 ? theme.accent : theme.muted;
				const noteSize = Math.round(lyrFont * 1.1);
				row._noteChild.style = `font-size: ${noteSize}px; color: ${color}; line-height: ${Math.round(noteSize * 1.3)}px; padding: 2px 0px;`;
			};

			if (card._lyricsOpacities[i] === opacity && card._lyricsScales[i] === scale) {
				return;
			};
			card._lyricsOpacities[i] = opacity;
			card._lyricsScales[i] = scale;

			// As ease() would off screen: there at once (`shown`, Isle's
			// just-on-screen path); otherwise the 380ms ease.
			row.remove_all_transitions();
			if (immediate) {
				row.opacity = opacity;
				row.set_scale(scale, scale);
			} else {
				row.ease({
					opacity,
					scale_x: scale,
					scale_y: scale,
					duration: LYR_LINE_EASE_MS,
					mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
				});
			};
		};

		card._lyricsActive = index;
		card._lyricsLabels.forEach((row, i) => {
			const current = i === index;
			const opacity = current ? LYR_CURRENT_OPACITY
				: i < index ? LYR_SUNG_OPACITY
					: LYR_COMING_OPACITY[Math.min(i - index - 1, LYR_COMING_OPACITY.length - 1)];
			const scale = current ? 1 : LYR_RESTING_SCALE;
			applyRow(row, i, opacity, scale, shown);
			if (row._setBreathing) {
				row._setBreathing(current && card._lyricsPlaying && row.mapped);
			};
		});

		const current = card._lyricsLabels[index] ?? card._lyricsLabels[0] ?? null;
		if (!current) {
			return;
		};

		// St.ScrollView in this runtime answers neither the "vscroll" JS
		// property nor a working get_vscroll_bar() accessor (journaled),
		// while the St.Scrollable interface exposes the adjustment right
		// on the view as "vadjustment" — verified against the installed
		// St-51 typelib, which also lacks st_adjustment_ease, so the
		// follow tween walks adjustment.value by hand.
		const adjustment = card._lyricsScroll.vadjustment ?? null;

		if (!adjustment) {
			return;
		};

		// Layout-managed children are positioned through their ALLOCATION:
		// the actor's own y property stays 0 (it is the fixed-position
		// slot), which made every line look like the first row
		// (journaled: line=46 y=0 upper=984 page=130 -> 0).
		const rowY = current.allocation ? current.allocation.y1 : 0;
		// Isle's reading anchor: the sung line rests at 36% of the viewport
		// from the top (not dead center) — the eye reads above the motion.
		const ideal = rowY + current.height / 2 - adjustment.page_size * LYR_ANCHOR;
		const highest = Math.max(adjustment.lower, adjustment.upper - adjustment.page_size);
		const clamped = Math.min(Math.max(ideal, adjustment.lower), highest);

		if (!isFinite(clamped)) {
			return;
		};

		// A manual scroll parks the follow for a while (Isle's hold):
		// highlight updates keep running, the view keeps where the hand
		// left it until the hold expires.
		if (!shown && Date.now() < card._lyricsManualUntil) {
			card._lyricsScrollPending = -1;
			return;
		};

		// The view has no layout yet (cold start / mid-flight): park the
		// request; the 250 ms ticker reprocesses and scrolls once mapped.
		if (!card._lyricsScroll.mapped) {
			card._lyricsScrollPending = index;
			return;
		};

		card._lyricsScrollPending = -1;

		if (Math.abs(clamped - adjustment.value) < 1) {
			return;
		};

		// Kill a running follow tween so two writes never race.
		if (card._lyricsScrollTween) {
			GLib.source_remove(card._lyricsScrollTween);
			card._lyricsScrollTween = null;
		};

		// Isle's 520 ms ease-out-cubic scroll...
		const startValue = adjustment.value;
		const delta = clamped - startValue;
		const durationMs = shown ? 1 : LYR_SCROLL_EASE_MS;
		const startedAt = GLib.get_monotonic_time() / 1000;

		card._lyricsScrollTween = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
			const t = Math.min(1, (GLib.get_monotonic_time() / 1000 - startedAt) / durationMs);
			const eased = 1 - Math.pow(1 - t, 3);

			adjustment.value = startValue + delta * eased;

			if (t < 1) {
				return GLib.SOURCE_CONTINUE;
			};

			card._lyricsScrollTween = null;
			return GLib.SOURCE_REMOVE;
		});

		// Isle's dynamic scheduling: calculate exactly when the next line
		// starts and schedule a timer for that moment (+30ms buffer),
		// instead of fixed-interval polling. This ensures instant line
		// switching at the exact timestamp.
		if (card._lyricsPlaying && !shown && card._lyricsLines && index >= 0) {
			const nextLine = card._lyricsLines[index + 1];
			if (nextLine) {
				// Calculate milliseconds until next line with sync offset applied
				const nextTimeMs = nextLine.time_ms - LYR_LEAD_MS;
				const currentPosMs = positionMs - LYR_LEAD_MS;
				const msUntilNext = Math.max(0, nextTimeMs - currentPosMs);
				
				// Cancel any existing scheduled update
				if (card._lyricsScheduledUpdate) {
					GLib.source_remove(card._lyricsScheduledUpdate);
					card._lyricsScheduledUpdate = null;
				};

				// Schedule the next update for exactly when the line appears
				if (msUntilNext < 60000) { // Only schedule if within 1 minute
					card._lyricsScheduledUpdate = GLib.timeout_add(
						GLib.PRIORITY_DEFAULT,
						msUntilNext + LYR_SCHEDULE_BUFFER_MS,
						() => {
							card._lyricsScheduledUpdate = null;
							// Recalculate position at the scheduled moment
							const controller = card._controller;
							if (controller && controller._playing
								&& Math.floor(GLib.get_real_time() / 1000) >= controller._seekLockUntil) {
								card._tickLyrics(controller._currentPositionUs());
							};
							return GLib.SOURCE_REMOVE;
						}
					);
				};
			};
		};
	};

	card.column = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		x_expand: true,
		style: 'spacing: 4px;',
	}));

	card.title = createLabel('', 'widget-music-title', `font-size: ${titleFont}px; font-weight: 800; color: ${theme.text};`);
	card.title.clutter_text.single_line_mode = true;
	// Without ellipsize the meta line's min width equals the full text width,
	// which pushed the column past the body clip and shaved the top-right
	// status icon. Ellipsis keeps the column inside its allocation.
	card.title.clutter_text.ellipsize = Pango.EllipsizeMode.END;

	// The idle title used a 🐾 emoji: without a color emoji font the shell
	// draws it as a white box ("tofu"). A bundled full-color paw-prints
	// glyph stands in for the emoji, right after the text like an emoji.
	const pawPath = widgetResourcePath('music', 'paw-prints-emoji.svg');
	card.titlePaw = new St.Icon({
		gicon: pawPath ? Gio.FileIcon.new(Gio.File.new_for_path(pawPath)) : null,
		icon_size: Math.round(titleFont * 1.05),
		y_align: Clutter.ActorAlign.CENTER,
		style: 'margin-left: 5px;',
		visible: false,
	});
	// Natural width only, so the glyph sits right after the text instead of
	// being pushed to the far edge (the label still ellipsizes if needed).
	card.title.x_expand = false;
	card.titleRow = new St.BoxLayout(boxLayoutProps({
		x_expand: true,
	}));
	// Long titles/artists scroll like Apple Music instead of ending in "…".
	card.titleMarquee = createMarquee(card.title, {expand: false});
	card.titleRow.add_child(card.titleMarquee.actor);
	card.titleRow.add_child(card.titlePaw);

	card.artist = createLabel('', 'widget-music-artist', `font-size: ${artistFont}px; color: ${theme.muted};`);
	card.artist.clutter_text.single_line_mode = true;
	card.artist.clutter_text.ellipsize = Pango.EllipsizeMode.END;

	card.times = new St.BoxLayout(boxLayoutProps({
		x_expand: true,
		style: 'spacing: 10px;',
	}));

	card.timeElapsed = createLabel('0:00', 'widget-music-time', `font-size: ${timeFont}px; color: ${theme.muted};`);
	card.timeElapsed.x_align = Clutter.ActorAlign.START;
	card.timeTotal = createLabel('0:00', 'widget-music-time', `font-size: ${timeFont}px; color: ${theme.muted};`);
	card.timeTotal.x_align = Clutter.ActorAlign.END;

	card._barHeight = barHeight;
	card._thumbSize = thumbSize;
	card._contentWidth = contentWidth;
	card._lastLength = 0;

	// Ported from liquidglass-widgets: animated seek bar (thickness 3->8px
	// on hover/drag), drag-to-seek with a stage grab, and built-in time
	// labels painted under the bar.
	const mutedColor = parseCssColor(theme.muted ?? '#ffffff');
	const accentColor = parseCssColor(theme.accent ?? '#5b9de0');
	card.slider = new SeekBar({
		accent: [accentColor.r, accentColor.g, accentColor.b],
		fg: [mutedColor.r, mutedColor.g, mutedColor.b],
		// Light glass needs a stronger track and a higher disabled floor,
		// or the bar disappears into the milky surface while idle.
		trackAlpha: theme.dark ? 0.2 : 0.4,
		disabledOpacity: theme.dark ? 90 : 150,
		fontSize: Math.round(timeFont * 0.85),
	});
	card.slider.x_expand = true;
	// 16 = bar headroom (thickness up to 8 at hover + margin) + 2px gap, then
	// the MEASURED pixel height of the time markup (its size= is in points and
	// renders wider in px, so a bare 1.25 guess shaved the digits' bottoms).
	card.slider.set_size(-1, 16 + Math.ceil(card.slider.timeLabelHeight));

	card.fractionForEvent = function (event) {
		const [stageX] = event.get_coords();
		const fallbackWidth = card._contentWidth || card.slider.get_width() || 300;
		const fallbackTrackX = card.slider.get_transformed_position()[0] + 8;
		const fraction = (stageX - fallbackTrackX) / fallbackWidth;
		if (fraction < 0 || fraction > 1) return null;
		return fraction;
	};

	card.preview = function (fraction) {
		const f = Math.max(0, Math.min(1, fraction ?? 0));
		const length = card._lastLength || 0;
		card.timeElapsed.text = formatUs(Math.round(length * f));
	};

	card.controls = new St.BoxLayout(boxLayoutProps({
		style: 'spacing: 2px;',
		x_align: Clutter.ActorAlign.CENTER,
	}));

	// The repeat control is painted in the widget accent color (system accent
	// or style-accent-color), per the reference look.
	card.btnLoop = createControlButton(theme, 'repeat', 18, 4, 9, false, true);
	card.btnPrev = createControlButton(theme, 'rewind', 18, 4, 9);
	card.btnPlay = createControlButton(theme, 'play', 22, 2, 11);
	card.btnNext = createControlButton(theme, 'fast-forward', 18, 4, 9);

	card.controls.add_child(card.btnLoop.button);
	card.controls.add_child(card.btnPrev.button);
	card.controls.add_child(card.btnPlay.button);
	card.controls.add_child(card.btnNext.button);

	// The new icon sits top-right of the first row of the right column:
	// that row belongs to it alone, the rest of the content sits below.
	card.statusIcon = new St.Icon({
		gicon: controlIcon(theme, 'music', false), // Inactive by default (gray)
		x_align: Clutter.ActorAlign.END,
		reactive: false,
		style: 'icon-size: 18px; margin-bottom: 2px;',
	});

	card.times.add_child(card.timeElapsed);
	card.times.add_child(card.timeTotal);
	// The SeekBar paints its own time labels now; the old labels row stays
	// out of the layout (its update code is kept harmless above).
	if (card._coverSize >= 64) {
		// The top-right music icon opens/closes the lyrics overlay. Same
		// visuals as the old static icon; now clickable, with the shared
		// hover shrink and click bounce of every other widget button.
		card.lyricsToggle = new St.Button({
			child: card.statusIcon,
			x_align: Clutter.ActorAlign.END,
			style: 'padding: 2px;',
		});
		bindHoverShrink(card.lyricsToggle);
		card.lyricsToggle.connect('clicked', () => {
			bounceButton(card.lyricsToggle);
			card.toggleLyrics();
		});
		card.column.add_child(card.lyricsToggle);
	} else {
		card.column.add_child(card.statusIcon);
	};
	card.column.add_child(card.titleRow);
	card.artistMarquee = createMarquee(card.artist);
	card.column.add_child(card.artistMarquee.actor);
	card.column.add_child(card.slider);
	card.column.add_child(card.controls);
	card.container.add_child(card.coverBox);
	card.container.add_child(card.column);

	const isMini = widgetHeight <= 140;
	if (isMini) {
		card.slider.hide();
		card.times.hide();
		// The mini right column is 113px wide; the full-size control row is
		// 4×27px + gaps = 114px, so it overflowed the body clip by a pixel and
		// shaved the top-right status icon. 26px buttons (icon 18 + 2×4 pad)
		// bring the row to 110px.
		for (const button of [card.btnLoop.button, card.btnPrev.button, card.btnPlay.button, card.btnNext.button]) {
			button.set_width(26);
			button.set_height(26);
		};
	};

	card.update = function ({title, artist, artUrl, trackUrl = null, playing, position, length, canControl, canPrev, canNext, canPlay, canPause, loop = 'None', canSeek = false, seekPreview = false, loopSupported = true, forcePrev = false, forceNext = false}) {
		const hasTrack = Boolean(title && title.length > 0);
		const gifPath = !hasTrack
			? emptyGifPath(this._settings?.get_string('music-empty-gif'))
			: null;

		if (hasTrack) {
			card.title.text = title;
			card.titlePaw.visible = false;
			card.artist.text = artist || _('Unknown artist');

			stopEmptyGif(card);
			card._gifPath = null;

			card.showArt(artUrl);
		} else {
			// The real 🐾 emoji when a color emoji font is installed; without
			// one the shell draws a white box ("tofu"), so the emoji is then
			// stripped and the bundled paw picture stands in for it.
			const waiting = _("I'm waiting 🐾");
			const emoji = hasColorEmojiFont();
			card.title.text = emoji ? waiting : waiting.replace(/\s*\u{1F43E}\s*/gu, '');
			card.titlePaw.visible = !emoji;
			card.artist.text = _('Play something to get going');

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
		};

		// Lyrics plumbing: remember the query for the (lazy) load, auto-close
		// the overlay on an empty card, refresh an open feed on track change
		// (the key guard inside _loadLyrics keeps same-track ticks a no-op).
		if (hasTrack) {
			card._lyricsMeta = {title, artist, length, trackUrl};

			if (card._lyricsOn) {
				card._loadLyrics();
			};
		} else {
			card._lyricsMeta = null;

			if (card._lyricsOn) {
				card._lyricsOn = false;
				card.lyricsPanel.visible = false;
				card.container.visible = true; // Show card content when lyrics close
			};
		};

		const displayLength = hasTrack ? length : 0;
		card._lastLength = displayLength;
		card.timeTotal.text = displayLength > 0 ? formatUs(displayLength) : '0:00';
		card.slider.setLength?.(displayLength);
		// Skipped while dragging (SeekBar guards inside, paints _dragPos).

		if (!seekPreview) {
			card.timeElapsed.text = hasTrack ? formatUs(position) : '0:00';
			card.slider.setPosition?.(hasTrack ? position : 0);
		};

		// Inactive widget guard: players like VLC/Amberol keep Can* = true
		// advertised over MPRIS even while stopped, so the old gate left every
		// button "clickable but dead" on the empty card. Real control requires
		// content: a track loaded or playback actually running.
		const trackGate = hasTrack || playing;
		const control = (canControl !== false || canPlay || canPause || canPrev || canNext || canSeek) && trackGate;

		// Fully inactive (no track, not playing) dims the row harder than the
		// in-session "capability off" state. On light glass the dark icons
		// at the old 45-level vanished into the milky surface, so the idle
		// floor is higher there; dark glass keeps the tuned look.
		const idleDim = theme.dark ? 45 : 120;
		const loopDim = theme.dark ? 30 : 80;
		const dimmed = control ? 100 : idleDim;

		const loopOk = loopSupported !== false;

		// Buttons stay reactive: the disabled look is carried by the dimmed
		// opacity, while every click still plays the squash bounce (visual
		// feedback on dead buttons). Dead clicks are safe no-ops —
		// _callMethod bails without this._name, _cycleLoop/_setLoop too.
		card.btnLoop.button.reactive = loopOk;
		card.btnLoop.button.opacity = !loopOk ? loopDim : (control ? 255 : idleDim);
		card.btnPrev.button.reactive = true;
		card.btnPrev.button.opacity = control && (canPrev || forcePrev) ? 255 : dimmed;
		card.btnPlay.button.reactive = true;
		card.btnPlay.button.opacity = control && (playing ? canPause : canPlay) ? 255 : dimmed;
		card.btnNext.button.reactive = true;
		card.btnNext.button.opacity = control && (canNext || forceNext) ? 255 : dimmed;

		const seekable = control && (length > 0 || playing) && (canSeek || canPlay || canPause);
		card.slider.setEnabled?.(seekable);
		// The bar stays reactive even when it cannot seek: hover must still
		// animate its thickness (the user expectations), while drag attempts
		// bail out inside SeekBar's own press guard (disabled/lengthless).

		// Update play/pause icon (bare pause bars — no ring, bigger symbol)
		setButtonIcon(card.btnPlay, playing ? 'pause' : 'play', hasTrack);
		recolorIcon(card.btnPlay);
		
		// Update navigation icons (prev/next) with active state
		setButtonIcon(card.btnPrev, 'rewind', hasTrack);
		setButtonIcon(card.btnNext, 'fast-forward', hasTrack);
		
		// Update status icon (lyrics) based on track state
		if (card.statusIcon) {
			card.statusIcon.gicon = controlIcon(theme, 'music', hasTrack);
			card.statusIcon.opacity = hasTrack ? 255 : idleDim;
		}
		
		// Update loop icon based on state
		if (loop === 'Track') {
			setButtonIcon(card.btnLoop, 'repeat-1', hasTrack);
			recolorIcon(card.btnLoop);
		} else if (loop === 'Playlist') {
			setButtonIcon(card.btnLoop, 'repeat', hasTrack);
			recolorIcon(card.btnLoop);
		} else {
			setButtonIcon(card.btnLoop, 'repeat-off', hasTrack);
			recolorIcon(card.btnLoop, control ? 1 : (theme.dark ? 0.4 : 0.6));
		}
		
		recolorIcon(card.btnPrev);
		recolorIcon(card.btnNext);

		// Keep the lyrics feed in sync with the reported position. Runs every
		// tick but repaints only on an active-line change (guarded inside).
		// The playing state drives the pause-dot breathing (Isle's
		// syncPlaying()).
		card._lyricsPlaying = playing;
		card._tickLyrics(position);
	};

	card.update({title: null, artist: null, artUrl: null, playing: false, position: 0, length: 0,
		canControl: false, canPrev: false, canNext: false, canPlay: false, canPause: false, loop: 'None', canSeek: false});

	return card;
};

let Controller = class Controller {
	constructor(card, bus, settings) {
		this._card = card;

		// Isle's click-to-seek (LyricsPane rows): clicking a lyric line
		// jumps the player to that stamp. Reuses the controller's own seek
		// commit path (SetPosition + Seek fallback + rate-aware bookkeeping)
		// with the fraction derived from the line's microsecond target.
		card._lyricsSeekUs = (us) => {
			if (!this._card || !this._name || !(this._length > 0)) {
				return;
			};
			const fraction = Math.max(0, Math.min(1, us / this._length));
			this._commitSeek(fraction);
		};

		this._bus = bus;
		this._settings = settings;
		this._name = null;
		this._subIds = [];
		this._watchId = 0;
		this._timerId = 0;
		this._retryTimer = 0;
		this._timerId = 0;
		this._lyricsTimerId = 0;
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
		this._meta = {title: null, artist: null, artUrl: null, trackUrl: null};
		this._relisten = false;
		this._bound = false;
		this._lastPlayingAt = {};
		this._fakePlayPause = {};
		this._playToggleBusy = false;
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

		// destroy() may have run while the player list was resolving; wiring
		// a player after that would re-subscribe D-Bus signals and re-arm
		// the timers destroy() already removed (leak until extension disable).
		if (this._relisten === false || !this._card) {
			return;
		};

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
		const ignoreBrowsers = this._settings?.get_boolean('music-ignore-browsers') ?? true;

		for (const candidate of await this.listCandidates()) {
			const props = await this._readProps(candidate);

			if (!props) {
				continue;
			};

			const status = variantValue(props.PlaybackStatus);
			const meta = parseMetadata(variantValue(props.Metadata));
			const hasTitle = Boolean(meta.title && meta.title.length);
			const isChromium = isChromiumName(candidate);
			const isProxy = candidate.toLowerCase().includes('playerctld');

			const playing = status === 'Playing' && hasTitle;
			let value = 0;

			if (playing) {
				// Every playing player keeps a heartbeat timestamp, so the
				// most recently activated one stays stable while it plays.
				this._lastPlayingAt[candidate] = Date.now();
				value = 500;
			} else if (status === 'Paused' && hasTitle) {
				value = 100;
			} else if (hasTitle) {
				value = 50;
			};

			rows.push({name: candidate, props, status, hasTitle, playing, value,
				recency: this._lastPlayingAt[candidate] ?? 0, isChromium, isProxy});
		};

		const candidates = rows.filter(row => row.value > 0);
		const playingRows = candidates.filter(row => row.playing);
		const idleRows = candidates.filter(row => !row.playing);

		// What is playing right now owns the card. The browser skip
		// preference only outranks it while some other app still plays:
		// Spotify playing beats a noisy YouTube tab, but on an empty field
		// the YouTube tab is shown rather than "ignored to nothing".
		const playNonBrowser = playingRows.filter(row => !row.isChromium);
		const playPool = playingRows.length === 0
			? []
			: (ignoreBrowsers && playNonBrowser.length > 0 ? playNonBrowser : playingRows);

		if (playPool.length > 0) {
			playPool.sort((a, b) => b.recency - a.recency
				|| (a.isProxy ? 1 : 0) - (b.isProxy ? 1 : 0));
			return playPool[0];
		};

		// Nothing plays: paused-with-title keeps leading bare titles, and
		// the browser preference applies only while alternatives remain.
		let idlePool = idleRows;
		if (ignoreBrowsers) {
			const nonBrowser = idleRows.filter(row => !row.isChromium);
			if (nonBrowser.length > 0) {
				idlePool = nonBrowser;
			};
		};

		idlePool.sort((a, b) => b.value - a.value
			|| b.recency - a.recency
			|| (a.isProxy ? 1 : 0) - (b.isProxy ? 1 : 0));

		return idlePool[0] ?? null;
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

					// Instant lyrics sync on play/pause: breathing animation
					// state changes immediately, not waiting for the ticker.
					// The CURRENT position: _position is only the last sample.
					if (this._card?._lyricsOn && this._card?._lyricsSynced) {
						this._card._tickLyrics(this._currentPositionUs());
					};
				};

				if (changed?.Position !== undefined) {
					this._position = Math.max(0, Number(variantValue(changed.Position) ?? 0));
					// Record timestamp when position was received (no backdating)
					// Isle's daemon captures position and timestamp atomically; we
					// receive them via D-Bus with a small delay, but the MPRIS position
					// value itself is already accurate for the player's internal state.
					const now = Math.floor(GLib.get_real_time() / 1000);
					this._posAt = now;  // No artificial backdating
					this._lastPosSync = now;

					// Instant lyrics sync on position change: immediate line
					// switching instead of waiting up to 50ms for the ticker.
					if (this._card?._lyricsOn && this._card?._lyricsSynced) {
						this._card._tickLyrics(this._position);
					};
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
					this._posAt = Math.floor(GLib.get_real_time() / 1000);
					this._lastPosSync = Math.floor(GLib.get_real_time() / 1000);
					this._seekLockUntil = 0;

					// Instant lyrics re-sync on seek: the ticker would take up
					// to 100ms to catch the new position, but a seek demands
					// immediate line switching for responsive UX.
					if (this._card?._lyricsOn && this._card?._lyricsSynced) {
						this._card._tickLyrics(position);
					};

					if (this._chromium && this._playing && position < 500000) {
						this._acceptUntil = Math.floor(GLib.get_real_time() / 1000) + 1500;
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
				this._meta = {title: null, artist: null, artUrl: null, trackUrl: null};
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
		const wasPlaying = this._playing;
		this._playing = status === 'Playing';

		if (status === 'Playing') {
			const now = Math.floor(GLib.get_real_time() / 1000);
			this._acceptUntil = now + 1500;
			if (wasPlaying) {
				// Players re-send PlaybackStatus=Playing with other changes
				// (metadata, volume…). Re-anchoring without folding in the
				// elapsed time rewound the position by up to the poll
				// interval — the lyrics fell behind until the next sync.
				this._position = this._currentPositionUs(now);
			};
			// Paused → Playing: the position was frozen at the pause, so
			// counting starts from now.
			this._posAt = now;

			if (this._chromium) {
				this._refreshMeta();
			};
		};

		if (wasPlaying && status === 'Paused') {
			// Freeze the accumulated position so re-play doesn't add the
			// pause duration to the extrapolated offset.
			const now = Math.floor(GLib.get_real_time() / 1000);
			this._position = Math.max(0, this._position + (Math.max(0, this._rate) || 1) * (now - this._posAt) * 1000);
			this._posAt = now;
		};

		if (status === 'Stopped') {
			this._meta = {title: null, artist: null, artUrl: null, trackUrl: null};
			this._length = 0;
			this._position = 0;
			this._posAt = Math.floor(GLib.get_real_time() / 1000);
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

			if (meta.trackUrl !== displayed.trackUrl) {
				displayed.trackUrl = meta.trackUrl;
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

		this._meta = {title: meta.title, artist: meta.artist, artUrl: meta.artUrl, trackUrl: meta.trackUrl};

		if (this._chromium) {
			this._lockedTrackId = meta.trackId ?? null;
		};

		if (meta.length > 0) {
			this._length = meta.length;
		};

		if (meta.trackId && meta.trackId !== this._trackId) {
			this._trackId = meta.trackId;
			this._position = 0;
			this._posAt = Math.floor(GLib.get_real_time() / 1000);
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
			// Players like Amberol pre-load queue metadata while Stopped and
			// never re-emit Metadata when playback starts on the SAME track
			// (only PlaybackStatus changes) — dropping it here left the card
			// empty with just buttons/slider reacting. The reference renders
			// whatever metadata the player reports, Stopped or not.
			this._meta = meta.title
				? {title: meta.title, artist: meta.artist, artUrl: meta.artUrl, trackUrl: meta.trackUrl}
				: {title: null, artist: null, artUrl: null, trackUrl: null};
			this._lockedTrackId = null;
			this._length = meta.length > 0 ? meta.length : 0;
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
			this._posAt = Math.floor(GLib.get_real_time() / 1000);
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
			try {
				const now = Math.floor(GLib.get_real_time() / 1000);

				if (this._playing) {
					if (now >= this._seekLockUntil && !this._seekActive) {
						this._position = Math.max(0, this._position + (Math.max(0, this._rate) || 1) * (now - this._posAt) * 1000);
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
			} catch (error) {
				// Keep the per-second renderer alive: in GJS an exception
				// inside a GLib.timeout_add callback would otherwise destroy
				// the source, silently killing the ticking slider/time.
				log(`music widget tick error: ${error}`);
			};
			return GLib.SOURCE_CONTINUE;
		});

		// Dedicated fast lyrics ticker: high-frequency position tracking
		// (50ms = 20fps) ensures responsive line switching. Uses GLib.get_real_time()
		// for microsecond precision matching Isle's timing approach.
		if (!this._lyricsTimerId) {
			this._lyricsTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
				try {
					if (!this._card || !this._card._lyricsOn || !this._card._lyricsSynced || !this._card._lyricsLabels?.length) {
						return GLib.SOURCE_CONTINUE;
					};
					// High-resolution time calculation using microseconds
					const nowMs = Math.floor(GLib.get_real_time() / 1000);
					let position = this._position;
					if (this._playing && nowMs >= this._seekLockUntil && !this._seekActive) {
						// Calculate position with microsecond precision
						const elapsedMs = nowMs - this._posAt;
						position = this._position + (Math.max(0, this._rate) || 1) * elapsedMs * 1000;
					};
					this._card._tickLyrics(position);
				} catch (error) {
					log(`lyrics tick error: ${error}`);
				};
				return GLib.SOURCE_CONTINUE;
			});
		};
	};

	async _reconsider() {
		if (this._relisten === false || !this._bus) {
			return;
		};

		let best;

		try {
			// _pickActive is async — without await this was a Promise, so the
			// player switch check always bailed and widgets missed freshly
			// started players (e.g. first track in Amberol).
			best = await this._pickActive();
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

	// The playback position NOW (µs), advanced in real time from the last
	// sample while playing — Isle's positionMs(), in microseconds.
	_currentPositionUs(nowMs = Math.floor(GLib.get_real_time() / 1000)) {
		let position = this._position;
		if (this._playing && !this._seekActive && nowMs >= this._seekLockUntil)
			position += (Math.max(0, this._rate) || 1) * (nowMs - this._posAt) * 1000;
		if (this._length > 0)
			position = Math.min(position, this._length);
		return Math.max(0, position);
	};

	_render() {
		if (!this._card) {
			return;
		};

		const now = Math.floor(GLib.get_real_time() / 1000);
		const settle = this._seekActive || now < this._seekLockUntil;
		let position = this._position;

		if (this._playing && !settle) {
			position = this._position + (Math.max(0, this._rate) || 1) * (now - this._posAt) * 1000;
		};

		this._card.update({
			title: this._meta.title,
			artist: this._meta.artist,
			artUrl: this._meta.artUrl,
			trackUrl: this._meta.trackUrl,
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
		// SeekBar handles press/motion/release internally (stage grab); only
		// the commit hook is wired here.
		c.slider._onSeek = fraction => {
			this._positionBeforeSeek = this._position;
			this._commitSeek(fraction);
		};
	};

	// The SeekBar handles press/motion/release internally (stage grab) and
	// calls back through c.slider._onSeek when the user commits a seek.

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
		const trackId = (await this._readTrackId()) || this._trackId || null;

		this._position = target;
		this._posAt = Date.now();
		this._lastPosSync = Date.now();
		this._seekLockUntil = Date.now() + 2000;
		this._render();

		// Reference seekTo rule: SetPosition only with the player's real,
		// current trackId; players without one (or that reject it) only honor
		// relative Seek — feeding them a fabricated NoTrack object path makes
		// GetPosition-targeted apps silently ignore the seek.
		if (trackId && trackId.startsWith('/')) {
			const reply = await this._callRemote(this._name, PLAYER_PATH, PLAYER_IFACE, 'SetPosition',
				GLib.Variant.new('(ox)', [trackId, target]), null);

			if (reply === null) {
				const offset = target - this._positionBeforeSeek;
				const seekReply = await this._callRemote(this._name, PLAYER_PATH, PLAYER_IFACE, 'Seek',
					GLib.Variant.new('(x)', [offset]), null);

				if (seekReply === null) {
					warn('music-seek-failed', 'SetPosition failed and fallback Seek failed too');
				};
			};
		} else {
			const offset = target - this._positionBeforeSeek;
			const reply = await this._callRemote(this._name, PLAYER_PATH, PLAYER_IFACE, 'Seek',
				GLib.Variant.new('(x)', [offset]), null);

			if (reply === null) {
				warn('music-seek-failed', 'Seek failed (no trackId)');
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
						this._posAt = Math.floor(GLib.get_real_time() / 1000);
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
			// Flatpak Amberol accepts PlayPause, answers it successfully
			// and silently does nothing (checked by direct busctl: Play
			// works, PlayPause never toggles). The call returning without
			// an error meant no fallback ever fired and the card sat there
			// while "music did not turn on". Read the status back after
			// the toggle; when it did not change, send the explicit
			// Play/Pause that such players do honor — and remember the
			// player so the next click skips the probe entirely.
			const name = this._name;

			if (this._playToggleBusy) {
				return;
			};

			this._playToggleBusy = true;

			try {
				if (this._fakePlayPause?.[name]) {
					await call(this._playing ? 'Pause' : 'Play');
					return;
				};

				const beforeProps = await this._readProps(name);
				const before = beforeProps ? variantValue(beforeProps.PlaybackStatus) ?? null : null;

				await call('PlayPause');

				// PlaybackStatus changes arrive within milliseconds of the
				// call; this small wait is only a read-back window.
				await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
					resolve();
					return GLib.SOURCE_REMOVE;
				}));

				const afterProps = this._name === name ? await this._readProps(name) : null;
				const after = afterProps ? variantValue(afterProps.PlaybackStatus) ?? null : null;

				if (!before || !after || before !== after) {
					return;
				};

				this._fakePlayPause = this._fakePlayPause || {};
				this._fakePlayPause[name] = true;

				await call(before === 'Playing' ? 'Pause' : 'Play');
			} finally {
				this._playToggleBusy = false;
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
		this._fakePlayPause = {};

		if (this._timerId) {
			GLib.source_remove(this._timerId);
			this._timerId = 0;
		};

		if (this._lyricsTimerId) {
			GLib.source_remove(this._lyricsTimerId);
			this._lyricsTimerId = 0;
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

			// The 16 ms lyrics scroll tween writes adjustment.value and must
			// not fire into a destroyed card after this.
			if (this._card._lyricsScrollTween) {
				GLib.source_remove(this._card._lyricsScrollTween);
				this._card._lyricsScrollTween = null;
			};

			// Dynamic lyrics scheduling timer must also be cleaned up.
			if (this._card._lyricsScheduledUpdate) {
				GLib.source_remove(this._card._lyricsScheduledUpdate);
				this._card._lyricsScheduledUpdate = null;
			};
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
	const [widgetWidth, widgetHeight] = sizeForWidget(widget);
	const card = createCard(theme, createLabel, widgetWidth, widgetHeight);
	card._settings = settings;

	// Restore lyrics state across theme/style re-renders: when _rebuildWidgets
	// destroys the old card and creates a new one, the lyrics view should stay
	// open if it was open before. Store in widget._runtimeState (survives rebuild).
	widget._runtimeState = widget._runtimeState || {};
	if (widget._runtimeState.lyricsWasOn) {
		card._lyricsOn = true;
		card.lyricsPanel.visible = true;
		card.container.visible = false;
	}

	// Track state on toggle for next rebuild
	const originalToggle = card.toggleLyrics;
	card.toggleLyrics = function(opts) {
		originalToggle.call(card, opts);
		widget._runtimeState.lyricsWasOn = card._lyricsOn;
	};

	const controller = new Controller(card, sessionBus(), settings);
	card._controller = controller; // Store reference for dynamic scheduling

	body.add_child(card.stage);
	body.connect('destroy', () => {
		// Save lyrics state before destruction so next render can restore it
		widget._runtimeState.lyricsWasOn = card._lyricsOn;
		controller.destroy();
	});
	controller.start();
};