// Lyrics resolver for the music widget's lyrics overlay.
//
// Chain, in order:
//   1. local .lrc next to the track file (xesam:url is file://),
//   2. cached result from a previous lookup (data dir /lyrics),
//   3. lrclib.net (free, keyless) — synced LRC or plain text,
//   4. the video's own YouTube captions, streamed through a local
//      yt-dlp when installed (direct anonymous downloads are walled
//      upstream; the direct timedtext crawl stays as the fallback),
//   5. nothing on any failure — the overlay stays on the folder art.

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// Shared keyless session, the same pattern the github widget uses. Timeouts
// keep a dead-network lookup from pinning the shell; look up happens off the
// paint path and its result arrives when it arrives.
let sharedSession = null;
function getSession() {
	if (!sharedSession) {
		// NOTE: Soup 3 has no io_timeout — unknown constructor properties
		// throw, which (before the fix) silently killed the whole lyrics
		// chain right after the request started.
		sharedSession = new Soup.Session({
			user_agent: 'desktop-widgets@r3nhick',
			timeout: 6,
		});
	};
	return sharedSession;
};

// ── LRC parsing ────────────────────────────────────────────────────────────

// "[mm:ss.xx] line" and multi-stamped "…[mm:ss.xx][mm:ss.yy] …"; metadata
// tags ([ar:], [ti:], [by:]...) hold letters and fall through the digits-only
// pattern. [offset:±N] shifts all timestamps by N milliseconds (some editors
// bake this in, others leave it for runtime). Returned sorted by time.
export function parseLrc(text) {
	const lines = [];
	const pattern = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
	const offsetPattern = /\[offset:\s*([+-]?\d+)\]/i;
	let offsetSeconds = 0;

	// same "[mm:ss.xx] line" and multi-stamp LRC lines
	for (const raw of String(text ?? '').split(/\r\n|\r|\n/)) {
		// Check for [offset:±milliseconds] metadata tag
		const offsetMatch = raw.match(offsetPattern);
		if (offsetMatch) {
			offsetSeconds = Number(offsetMatch[1]) / 1000;  // ms → seconds
			continue;
		};

		pattern.lastIndex = 0;
		let stamp = null;
		let match;
		while ((match = pattern.exec(raw)) !== null) {
			// LRC spec: a POSITIVE offset makes lyrics appear SOONER, so it
			// is subtracted (adding it delayed every line of such files).
			const seconds = Math.max(0, Number(match[1]) * 60 + Number(match[2]) - offsetSeconds);
			(stamp ??= []).push(seconds);
		};

		const content = raw.replace(pattern, '').trim();
		// Empty stamped lines ARE kept: they mark instrumental stretches,
		// rendered as breathing pause dots the way isle@zickrian's lyrics
		// pane does (a full-stop skip would glue sung lines together).
		if (!stamp) continue;

		for (const time of stamp)
			lines.push({time, line: content});
	};

	lines.sort((a, b) => a.time - b.time);
	return lines;
};

// Synced take: index = the last stamped line at or before `positionUs`.
export function lineIndexAt(lines, positionUs) {
	if (!lines || lines.length === 0) return -1;
	const seconds = (Number(positionUs) || 0) / 1e6;
	let lo = 0;
	let hi = lines.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if ((lines[mid].time ?? lines[mid][0]) <= seconds) {
			found = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		};
	};
	return found;
};

// ── Streaming-title cleanup (YouTube browser players etc.) ─────────────────

const JUNK_PATTERNS = [
	// "(Official Music Video)", "[Lyrics]", "(HD)", "(MV)", "(2024 Mix)"...
	/\((?:[^()]*(?:official|video|audio|lyrics|music video|hd|hq|visualizer|instrumental|remaster|mv|4k|store full)[^()]*)\)/gi,
	/\[(?:[^\[\]]*(?:official|video|audio|lyrics|hd|hq|visualizer|instrumental|mv|4k|full)[^\[\]]*)\]/gi,
];

// Turns "Artist - Song (Official Video)" into {artist: "Artist",
// title: "Song"}. When the player supplies no artist (browsers), the dash
// split supplies both; with a real artist a dash inside the title is usually
// meaningful, so it stays.
export function cleanTrackQuery(title, artist) {
	let t = String(title ?? '').trim();
	let a = String(artist ?? '').trim();

	for (const pattern of JUNK_PATTERNS)
		t = t.replace(pattern, '');
	t = t.replace(/\s{2,}/g, ' ').trim();

	const genericArtist = !a
		|| /^(?:various(?: artists)?|unknown|mix|performance|playlist|full album|.+ hours?)$/i.test(a);
	if (genericArtist) {
		const dash = t.split(/\s+[-–—]\s+/);
		if (dash.length >= 2) {
			a = dash[0].trim();
			t = dash.slice(1).join(' - ').trim();
		};
	};

	return {artist: a || null, title: t || null};
};

// ── Resolver ───────────────────────────────────────────────────────────────

// 10-minute negative cache: known misses skip the network entirely (a
// mix/track without lyrics at the source would otherwise hit the busy API
// again on every overlay open).
const MISS_TTL_MS = 10 * 60 * 1000;
const missCache = new Map();

// ── YouTube captions lane (dormant behind the upstream wall) ───────────────
// Walks search -> watch page -> captionTracks -> timedtext. Every step is
// probe-logged; any wall (downloads currently empty for anonymous clients)
// resolves null and the chain just misses.

// Safari/Apple persona — the same signature the VISIONOS player client
// declares; captions unlock only for this coherent session.
const YT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
let ytSession = null;

function getYtSession() {
	if (!ytSession) {
		// A cookie jar keeps the contact realistic; upstream may still gate
		// the timedtext download — the lane stays dormant until allowed.
		ytSession = new Soup.Session({user_agent: YT_UA, timeout: 8});
		ytSession.add_feature(new Soup.CookieJar({
			read_only: false,
			accept_policy: Soup.CookieJarAcceptPolicy.ALWAYS,
		}));
	};

	return ytSession;
};

function ytRequest(method, url, payload = null) {
	return new Promise(resolve => {
		let message = null;
		try {
			message = Soup.Message.new(method, url);
			if (message && payload !== null) {
				message.set_request_body_from_bytes('application/json', new GLib.Bytes(payload));
			};
		} catch (_e) {
			message = null;
		};

		if (!message) {
			resolve(null);
			return;
		};

		getYtSession().send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_source, result) => {
			try {
				resolve(getYtSession().send_and_read_finish(result));
			} catch (_e) {
				resolve(null);
			};
		});
	});
};

function findVideoRenderers(node, out) {
	if (!node || typeof node !== 'object' || out.length >= 8) return;

	if (Array.isArray(node)) {
		for (const child of node) {
			findVideoRenderers(child, out);
		};
		return;
	};

	if (node.videoRenderer && node.videoRenderer.videoId) {
		out.push(node.videoRenderer);
	};

	for (const key of Object.keys(node)) {
		findVideoRenderers(node[key], out);
	};
};

function lengthTextToSeconds(text) {
	if (!text) return 0;
	const parts = String(text).split(':').map(Number);
	if (parts.some(part => Number.isNaN(part))) return 0;
	return parts.reduce((sum, part) => sum * 60 + part, 0);
};

async function searchYouTubeVideoId(title, artist, durationSeconds) {
	const payload = JSON.stringify({
		context: {client: {clientName: 'WEB', clientVersion: '2.20240726.00.00', hl: 'en', gl: 'US'}},
		query: [title, artist].filter(Boolean).join(' '),
	});

	const bytes = await ytRequest('POST', 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false', payload);
	if (!bytes) {
		return null;
	};

	let parsed;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes.get_data()));
	} catch (_e) {
		return null;
	};

	const candidates = [];
	findVideoRenderers(parsed.contents ?? parsed, candidates);

	const qWords = String(title).toLowerCase().split(/\s+/).filter(Boolean);

	let best = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const video of candidates) {
		const titleText = video.title?.runs?.[0]?.text ?? video.title?.simpleText ?? '';
		const ownerText = video.ownerText?.runs?.[0]?.text ?? '';
		const hay = `${titleText} ${ownerText}`.toLowerCase();
		const affinity = qWords.filter(word => hay.includes(word)).length;
		const seconds = lengthTextToSeconds(video.lengthText?.simpleText ?? null);
		const drift = durationSeconds > 0 && seconds > 0
			? Math.min(Math.abs(seconds - durationSeconds), 60) : 25;
		const ownerHit = artist && ownerText.toLowerCase().includes(artist.toLowerCase()) ? 0 : 12;
		const score = Math.max(0, 24 - affinity * 8) + drift + ownerHit;

		if (score < bestScore) {
			bestScore = score;
			best = {video, titleText, ownerText};
		};
	};

	if (!best) {
		return null;
	};

	// The captions of "the same song" cannot run 40+ minutes when the
	// track is 1:09 (or vice versa): reject a video whose own length
	// disagrees with the player's, both known, by more than 10 s.
	const bestSeconds = lengthTextToSeconds(best.video.lengthText?.simpleText ?? null);
	if (durationSeconds > 0 && bestSeconds > 0 && Math.abs(bestSeconds - durationSeconds) > 10) {
		return null;
	};

	return best.video.videoId;
};

function decodeEntities(text) {
	let out = String(text);

	out = out.replace(/&#(\d+);/g, (_, n) => {
		try {
			return String.fromCodePoint(Number(n));
		} catch (_e) {
			return '';
		};
	});
	out = out.replace(/&#x([0-9a-f]+);/gi, (_, n) => {
		try {
			return String.fromCodePoint(parseInt(n, 16));
		} catch (_e) {
			return '';
		};
	});

	return out
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, '\'')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
};

function json3ToLines(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (_e) {
		return null;
	};

	const lines = [];
	for (const event of parsed?.events ?? []) {
		if (!Array.isArray(event.segs) || typeof event.tStartMs !== 'number') continue;
		const text = event.segs.map(seg => seg.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
		if (text) {
			lines.push({time: event.tStartMs / 1000, line: text});
		};
	};

	return lines.length > 0 ? lines : null;
};

// Shared caption-text cleanup: strip ASR noise tokens ([music],
// [applause]) and speaker-turn marks so the feed carries real speech.
// srv1 rows sometimes arrive double-encoded ("&amp;gt;"), so decode
// runs twice before the pattern sweep.
function cleanCaptionText(text) {
	let out = decodeEntities(String(text));
	out = decodeEntities(out);

	return out
		.replace(/\[[^\]]*\]/g, ' ')
		.replace(/(?:^|\s)>{1,2}(?=\s|$)/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
};

function xml3ToLines(raw) {
	const lines = [];
	const pattern = /<text\s+([^>]*)>([\s\S]*?)<\/text>/g;
	let match;

	while ((match = pattern.exec(raw)) !== null) {
		const start = (match[1].match(/start="([\d.]+)"/) ?? [])[1];
		if (start === undefined) continue;
		const text = cleanCaptionText(match[2]);
		if (text) {
			lines.push({time: Number(start), line: text});
		};
	};

	return lines.length > 0 ? lines : null;
};

// Synthetic LRC so a cached payload re-uses the regular parser everywhere.
function linesToLrcText(lines) {
	return lines.map((entry) => {
		const total = Math.max(0, Number(entry.time) || 0);
		const minutes = Math.floor(total / 60);
		const seconds = (total - minutes * 60).toFixed(2).padStart(5, '0');
		return `[${minutes}:${seconds}]${entry.line}`;
	}).join('\n');
};

// ── YouTube captions, pure keyless flow ────────────────────────────
// One coherent "device" session unlocks everything (verified live):
// the watch page (Safari/Apple UA) hands out visitorData, the VISIONOS
// player client (RealityDevice) accepts it with playability OK, and the
// caption baseUrl then serves real timedtext to that same UA. Chrome
// contexts and visitor-less calls stay walled with empty bodies.
async function fetchYouTubeCaptionLines(videoId) {
	// Step 1 — the watch page in the same "device" persona; its
	// INNERTUBE visitorData is what makes the player call accepted.
	const pageBytes = await ytRequest('GET', `https://www.youtube.com/watch?v=${videoId}&hl=en`);
	if (!pageBytes) {
		return null;
	};

	const html = new TextDecoder().decode(pageBytes.get_data());
	const visitorData = (html.match(/"visitorData":"([^"]+)"/) ?? [])[1] ?? null;

	if (!visitorData) {
		return null;
	};

	// Step 2 — VISIONOS player client (RealityDevice). Chrome contexts
	// and visitor-less calls get UNPLAYABLE/LOGIN_REQUIRED here.
	const payload = JSON.stringify({
		videoId,
		context: {client: {
			clientName: 'VISIONOS',
			clientVersion: '1.02',
			deviceMake: 'Apple',
			deviceModel: 'RealityDevice17,1',
			userAgent: YT_UA,
			osName: 'visionOS',
			osVersion: '26.5.23O471',
			visitorData,
		}},
		contentCheckOk: true,
		racyCheckOk: true,
	});

	const playerBytes = await ytRequest('POST', 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false', payload);
	if (!playerBytes) {
		return null;
	};

	let player;
	try {
		player = JSON.parse(new TextDecoder().decode(playerBytes.get_data()));
	} catch (_e) {
		return null;
	};

	const playability = player?.playabilityStatus?.status ?? null;
	const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

	if (playability !== 'OK' || tracks.length === 0) {
		return null;
	};

	// Show the caption YouTube itself opens by default — the media's own
	// language (a Russian video must not drift into English auto-subs the
	// user never asked for). Priority: an explicit default index, then the
	// first entry of the audio track's caption ordering, then the first
	// ASR/manual track, then plain tracks[0].
	const renderer = player?.captions?.playerCaptionsTracklistRenderer ?? {};
	const audioTracks = renderer.audioTracks ?? [];
	const defaultIdx = audioTracks.find(audio => typeof audio?.defaultCaptionTrackIndex === 'number')
		?.defaultCaptionTrackIndex
		?? (audioTracks.find(audio => audio?.hasDefaultTrack)?.captionTrackIndices?.[0])
		?? audioTracks[0]?.captionTrackIndices?.[0]
		?? null;

	const track = (defaultIdx !== null && tracks[defaultIdx])
		?? tracks.find(entry => entry.kind === 'asr')
		?? tracks.find(entry => !entry.kind)
		?? tracks[0];

	// Step 3 — the same-UA download of the timedtext itself; the session
	// cookie jar carries the consent state from step 1.
	const captionBytes = await ytRequest('GET', track.baseUrl);
	const captionRaw = captionBytes ? new TextDecoder().decode(captionBytes.get_data()) : '';

	if (!captionRaw.trim()) {
		return null;
	};

	const lines = xml3ToLines(captionRaw) ?? json3ToLines(captionRaw);

	if (!lines) {
		return null;
	};

	return {lines, lang: track.languageCode ?? 'unknown'};
};

function lyricsCachePath(dir, artist, title) {
	const key = `${artist ?? ''}::${title ?? ''}`;
	let hash = 0;
	for (const ch of key)
		hash = ((hash * 31) + ch.codePointAt(0)) >>> 0;
	return GLib.build_filenamev([dir, `${hash.toString(36)}.json`]);
};

// Cache generation: the pick rules changed (exact endpoint + look gate),
// Cache generation: the pick rules changed twice (exact endpoint + look
// gate, then the artist-required attempt list) — every pre-gate entry is
// ignored once. A previously cached wrong song's lyrics ("СПАСАТЕЛЬНЫЙ
// КРУГ" won the bare "face" attempt) would otherwise keep showing forever.
// 4: lyrics picked before the duration-aware lookup could be another
// recording of the song (album vs single/radio/video cut) whose timestamps
// run seconds late — every older entry is looked up again once.
const CACHE_GATE = 4;
// LRCLIB's own matching tolerance for the same recording.
const SAME_RECORDING_S = 2;
// Search results within this drift count as the playing recording.
const CLOSE_RECORDING_S = 3;

function loadCached(dir, artist, title) {
	return new Promise(resolve => {
		const path = lyricsCachePath(dir, artist, title);
		const file = Gio.File.new_for_path(path);
		file.load_contents_async(null, (_f, res) => {
			try {
				const [ok, contents] = _f.load_contents_finish(res);
				if (!ok) { resolve(null); return; }
				const data = JSON.parse(new TextDecoder().decode(contents));
				if (!data || typeof data.linesAsText !== 'string') { resolve(null); return; }
				if (data.gate !== CACHE_GATE) { resolve(null); return; }
				resolve(data);
			} catch (_e) {
				resolve(null);
			}
		});
	});
};

function saveCached(dir, artist, title, payload) {
	try {
		GLib.mkdir_with_parents(dir, 0o755);
		const path = lyricsCachePath(dir, artist, title);
		const bytes = GLib.Bytes.new(new TextEncoder().encode(
			JSON.stringify({artist, title, gate: CACHE_GATE, ...payload}),
		));
		Gio.File.new_for_path(path).replace_contents_bytes_async(
			bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null,
			(_f, res) => { try { _f.replace_contents_finish(res); } catch (_e) {} },
		);
	} catch (_e) {
		// Cache is best-effort only.
	};
};

function localLrcPath(trackUrl) {
	if (!trackUrl || !trackUrl.startsWith('file://')) return null;
	try {
		const [, path] = GLib.filename_from_uri(trackUrl);
		if (!path) return null;
		const base = GLib.path_get_basename(path);
		const dot = base.lastIndexOf('.');
		const stem = dot > 0 ? base.slice(0, dot) : base;
		return GLib.build_filenamev([GLib.path_get_dirname(path), `${stem}.lrc`]);
	} catch (_e) {
		return null;
	};
};

// Brackets in stream titles are almost always decorative junk absent from
// the indexed song name ("… (outsider house)", "[NCS Release]").
function stripAllBrackets(title) {
	return String(title ?? '')
		.replace(/\([^()]*\)|\[[^\[\]]*\]|\{[^{}]*\}/g, ' ')
		.replace(/\s{2,}/g, ' ')
		.trim();
};

// ── Match-shape helpers: never hand the overlay a lookalike ────────────────
// LRCLIB's free-text search is a fuzz engine — a totally unrelated track
// with synced lyrics ("Мне не надо друзей…" picked for a phonk remix) can
// outscore nothing at all. These helpers score how much a candidate's OWN
// names resemble the query that was sent.
function normalizedKey(text) {
	return String(text ?? '')
		.replace(/\([^()]*\)|\[[^\[\]]*\]|\{[^{}]*\}/g, ' ')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
};

function nameTokens(text) {
	return normalizedKey(text).split(/\s+/).filter(Boolean);
};

// A candidate passes only when the query genuinely lives inside its names:
// ≥60% of the attempt's title tokens (substring level, inflection-tolerant)
// in the candidate's track name, most of the attempt's artist tokens in the
// candidate's artist name, and — where both sides know it — a duration that
// can actually be the same recording (file players report a real length; a
// wrong song almost never lands within ±10 s even for a slowed mix of the
// same track).
function queryFits(entry, attempt, durationSeconds) {
	const candTrack = normalizedKey(entry.trackName);
	const candArtist = normalizedKey(entry.artistName);
	const candName = `${candTrack} ${candArtist}`;

	const titleTokens = nameTokens(attempt.title);
	if (titleTokens.length === 0) return false;
	const titleHits = titleTokens.filter(token => candName.includes(token)).length;
	if (titleHits / titleTokens.length < 0.6) return false;

	if (attempt.artist) {
		const artistTokens = nameTokens(attempt.artist);
		if (artistTokens.length > 0) {
			const artistHits = artistTokens.filter(token => candArtist.includes(token)).length;
			if (artistHits / artistTokens.length < 0.5) return false;
		};
	};

	const entryDur = Number(entry.duration) || 0;
	if (durationSeconds > 0 && entryDur > 0 && Math.abs(entryDur - durationSeconds) > 10) {
		return false;
	};

	return true;
};

// Ordered query attempts for a track. LRCLIB's search matches properly
// indexed names well but fogs through complete file-fallback titles
// ("face - vlone remix by salem slut"), so the list walks from the
// canonical (tagged artist + cleaned title) to the dash parse (filename
// shape: first segment is the artist). Raw strings became {artist, title}
// pairs so each attempt knows what it claims to be — the match gate reads
// both fields.
function queryAttempts(query) {
	const attempts = [];
	const push = (candidate) => {
		if (!candidate || !String(candidate.title ?? '').trim()) return;
		const key = `${candidate.artist ?? ''}|${candidate.title}`;
		if (attempts.some(existing => `${existing.artist ?? ''}|${existing.title}` === key)) return;
		if (attempts.length >= 5) return;
		attempts.push(candidate);
	};

	const plainTitle = stripAllBrackets(query.title);
	push({artist: query.artist, title: plainTitle});
	// A tagged file never drops its artist: an artist-less attempt for
	// "Jeqaly — face…" degenerated into the bare "face" attempt and the
	// Russian rapper FACE won it (name collision + synced lyrics + a
	// perfect same-length match). Untagged (browser/stream) tracks keep
	// the artist-less variants.
	if (!query.artist)
		push({artist: null, title: plainTitle});

	const dash = query.title.split(/\s+[-–—]\s+/).map(part => stripAllBrackets(part).trim()).filter(Boolean);
	if (dash.length >= 2) {
		push({artist: dash[0], title: dash.slice(1).join(' - ')});
		// Never a bare dash-FIRST segment as a title attempt: it is the
		// artist by construction (and collides with real track names).
		push({artist: null, title: dash.slice(1).join(' - ')});
	};

	return attempts;
};

// LRCLIB's exact-match endpoint: authoritative for properly tagged files
// (tagged artist + exact title). A 404 here just continues the chain —
// unlike the fuzzy search, whatever this endpoint returns IS the song.
async function getExactLyrics(attempt, durationSeconds = 0) {
	// With the duration LRCLIB returns the recording that matches it (±2s);
	// without it, any version of the song — another cut's timestamps.
	const url = `https://lrclib.net/api/get`
		+ `?artist_name=${encodeURIComponent(attempt.artist)}`
		+ `&track_name=${encodeURIComponent(attempt.title)}`
		+ (durationSeconds > 0 ? `&duration=${Math.round(durationSeconds)}` : '');

	const message = Soup.Message.new('GET', url);
	if (!message) {
		return null;
	};

	try {
		// eslint-disable-next-line no-await-in-loop
		const bytes = await new Promise(resolve => {
			getSession().send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_source, result) => {
				try {
					resolve(getSession().send_and_read_finish(result));
				} catch (_e) {
					resolve(null);
				};
			});
		});

		if (!bytes || message.get_status() !== Soup.Status.OK) {
			return null;
		};

		const parsed = JSON.parse(new TextDecoder().decode(bytes.get_data()));
		return parsed && ((parsed.syncedLyrics && parsed.syncedLyrics.trim())
			|| (parsed.plainLyrics && parsed.plainLyrics.trim()))
			? parsed
			: null;
	} catch (_e) {
		return null;
	};
};

async function fetchLyricsHttp(query, durationSeconds) {
	for (const attempt of queryAttempts(query)) {
		// Exact first — a tagged file should never even reach the fuzzy
		// search (the exact endpoint cannot return a different song).
		// Needs a real artist: ?artist_name=null once looked like a query.
		const exact = attempt.artist ? await getExactLyrics(attempt, durationSeconds) : null;
		if (exact) {
			// The exact endpoint matched artist+title; it must also be the
			// SAME recording: a 10s-longer cut (the old tolerance) shifts
			// every line by its longer intro — lyrics running seconds late.
			const exactDur = Number(exact.duration) || 0;
			const durationOk = !(durationSeconds > 0 && exactDur > 0)
				|| Math.abs(exactDur - durationSeconds) <= SAME_RECORDING_S;

			if (durationOk) {
				return exact;
			};
		};

		const q = [attempt.title, attempt.artist].filter(Boolean).join(' ');
		const url = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;

		// Per-attempt scope: a dead attempt continues the chain, the loop
		// itself may not fail wholesale.
		for (let tryIndex = 0; tryIndex < 2; tryIndex += 1) {
			const message = Soup.Message.new('GET', url);
			if (!message) {
				break;
			};

			// eslint-disable-next-line no-await-in-loop
			const bytes = await new Promise(resolve => {
				try {
					getSession().send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_source, result) => {
						try {
							resolve(getSession().send_and_read_finish(result));
						} catch (_e) {
							resolve(null);
						};
					});
				} catch (_e) {
					resolve(null);
				};
			});

			if (!bytes) {
				continue;
			};

			if (message.get_status() !== Soup.Status.OK) {
				// The API self-reports overload (503 busy) — one cautious
				// retry of the same query before moving on.
				if (message.get_status() === 503 && tryIndex === 0) {
					// eslint-disable-next-line no-await-in-loop
					await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
						resolve(null);
						return GLib.SOURCE_REMOVE;
					}));
					continue;
				};
				break;
			};

			const raw = new TextDecoder().decode(bytes.get_data());
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch (_e) {
				break;
			};

			if (!Array.isArray(parsed)) {
				break;
			};

			// Synced LRC beats plain text; then text affinity to this
			// attempt's words; duration drift as the tie-breaker. The look
			// gate afterwards is what keeps a synced stranger out.
			const qWords = q.toLowerCase().split(/\s+/).filter(Boolean);
			const usable = parsed.filter(entry => entry
				&& ((entry.syncedLyrics && entry.syncedLyrics.trim())
					|| (entry.plainLyrics && entry.plainLyrics.trim())));

			const score = (entry) => {
				const synced = Boolean(entry.syncedLyrics && entry.syncedLyrics.trim());
				const duration = Number(entry.duration) || 0;
				const drift = durationSeconds > 0 && duration > 0
					? Math.min(Math.abs(duration - durationSeconds), 40) : 20;
				const hay = `${entry.trackName ?? ''} ${entry.artistName ?? ''}`.toLowerCase();
				const affinity = qWords.filter(word => hay.includes(word)).length;
				// Drift weighs heavily: the wrong recording means wrong timings.
				return (synced ? 0 : 1000) + Math.max(0, 30 - affinity * 10) + drift * 8;
			};

			usable.sort((a, b) => score(a) - score(b));
			let passing = usable.filter(entry => queryFits(entry, attempt, durationSeconds));
			// Same recording available? Then only those (a synced stranger
			// cut never wins over it).
			if (durationSeconds > 0) {
				const close = passing.filter(entry => {
					const d = Number(entry.duration) || 0;
					return d > 0 && Math.abs(d - durationSeconds) <= CLOSE_RECORDING_S;
				});
				if (close.length > 0)
					passing = close;
			}

			if (passing.length > 0) {
				const best = passing[0];
				return best;
			};

			if (usable.length > 0) {
				const intruder = usable[0];
			};

			break;
		};
	};

	return null;
};

// Resolves lyrics for the current track. Returns null when nothing exists.
// @param {object} opts
// @param {string|null} opts.artist
// @param {string|null} opts.title
// @param {number} [opts.durationUs] MPRIS length in microseconds
// @param {string|null} [opts.trackUrl] xesam:url (file:// enables the
//     local-lrc lane, http addresses from streaming players are ignored there)
// @param {string} opts.dir  cache directory (e.g. getDataDir('lyrics'))
export async function resolveLyrics({artist, title, durationUs = 0, trackUrl = null, dir = null}) {
	if (!title || !dir) return null;

	const query = cleanTrackQuery(title, artist);
	if (!query.title) return null;
	const durationSeconds = Math.max(0, (Number(durationUs) || 0) / 1e6);


	const localPath = localLrcPath(trackUrl);
	if (localPath) {
		const lrcContents = await new Promise(resolve => {
			Gio.File.new_for_path(localPath).load_contents_async(null, (_f, res) => {
				try {
					const [ok, bytes] = _f.load_contents_finish(res);
					resolve(ok ? bytes : null);
				} catch (_e) {
					resolve(null);
				}
			});
		});
		if (lrcContents) {
			const lines = parseLrc(new TextDecoder().decode(lrcContents));
			if (lines.length > 0) {
				return {synced: true, query, lines};
			};
		};
	};

	// A placeholder track line (tagless playlist row: "Unknown title")
	// resolves nothing — every fuzzy lane over it is a coin toss, and the
	// YouTube lane once handed such a row 4 lines of a random video's
	// captions. The local .lrc above stays reachable: it keys on the file,
	// not on the missing tag.
	if (/^(?:unknown (?:title|track)|untitled|title unknown|track unknown|no title)$/i.test(query.title)) {
		return null;
	};

	let cached = await loadCached(dir, query.artist, query.title);
	// Cached for another recording (album vs single cut…): look it up again.
	if (cached && durationSeconds > 0 && Number(cached.duration) > 0
		&& Math.abs(Number(cached.duration) - durationSeconds) > CLOSE_RECORDING_S)
		cached = null;
	if (cached && typeof cached.linesAsText === 'string' && cached.linesAsText.trim()) {
		// YouTube entries without an explicit lang tag are stale
		// (from the en-first rule before 09a073c); ignore them once.
		const isStaleYt = cached.source === 'youtube' && !cached.lang;

		if (!isStaleYt) {

			if (cached.synced) {
				const lines = parseLrc(cached.linesAsText);
				if (lines.length > 0) {
					return {synced: true, query, lines};
				};
				// Unparseable cached LRC — fall through and refresh from network.
			} else {
				const plain = cached.linesAsText.split(/\r\n|\r|\n/).filter(Boolean);
				if (plain.length > 0) {
					return {synced: false, query, lines: plain.map((line, i) => ({time: -1 - i, line}))};
				};
			};
		};
	};

	const missKey = `${query.artist ?? ''}|${query.title}`;
	const missAt = missCache.get(missKey);
	if (missAt && Date.now() - missAt < MISS_TTL_MS) {
		return null;
	};

	const hit = await fetchLyricsHttp(query, durationSeconds);

	if (!hit) {
		// Last lane: the video's own captions. Local files skip it —
		// searching a streaming platform for an owned file would be wrong.
		if (!(trackUrl ?? '').startsWith('file://')) {
			const videoId = await searchYouTubeVideoId(query.title, query.artist, durationSeconds);

			if (videoId) {
				const captionResult = await fetchYouTubeCaptionLines(videoId);

				if (captionResult) {
					const linesAsText = linesToLrcText(captionResult.lines);
					const lines = parseLrc(linesAsText);

					if (lines.length > 0) {
						missCache.delete(missKey);
						saveCached(dir, query.artist, query.title, {
							synced: true,
							linesAsText,
							source: 'youtube',
							lang: captionResult.lang,
							duration: durationSeconds,
						});
						return {synced: true, query, lines};
					};
				};
			};
		};

		missCache.set(missKey, Date.now());
		return null;
	};

	missCache.delete(missKey);

	const syncedText = hit.syncedLyrics && hit.syncedLyrics.trim() ? hit.syncedLyrics : null;
	const plainText = !syncedText && hit.plainLyrics && hit.plainLyrics.trim() ? hit.plainLyrics : null;
	if (!syncedText && !plainText) return null;

	if (syncedText) {
		const lines = parseLrc(syncedText);
		if (lines.length === 0) return null;
		saveCached(dir, query.artist, query.title, {synced: true, linesAsText: syncedText, duration: durationSeconds});
		return {synced: true, query, lines};
	};

	const lines = plainText.split(/\r\n|\r|\n/).filter(Boolean).map((line, i) => ({time: -1 - i, line}));
	saveCached(dir, query.artist, query.title, {synced: false, linesAsText: plainText, duration: durationSeconds});
	return {synced: false, query, lines};
};
