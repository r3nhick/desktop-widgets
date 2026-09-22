import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

// Desktop-widgets screen time engine: tracks focused windows and accumulates
// per-app, per-hour seconds. Persists one JSON file per day.

const TICK_INTERVAL_MS = 1000;
const SAVE_THROTTLE_MS = 15000;
const MICROSECONDS_PER_SECOND = 1000000;
const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;
const DEFAULT_RETENTION_DAYS = 30; // Keep data for this many days by default

function getDataDir() {
	const userDataDir = GLib.get_user_data_dir();
	const dir = GLib.build_filenamev([userDataDir, 'desktop-widgets', 'screen-time']);
	GLib.mkdir_with_parents(dir, 0o755);
	return dir;
}

function todayDateString() {
	const now = GLib.DateTime.new_now_local();
	return `${now.get_year()}-${String(now.get_month()).padStart(2, '0')}-${String(now.get_day_of_month()).padStart(2, '0')}`;
}

function dayFilePath(dateString) {
	return GLib.build_filenamev([getDataDir(), `${dateString}.json`]);
}

function cleanupOldFiles(retentionDays) {
	const dir = getDataDir();
	const cutoff = GLib.DateTime.new_now_local().add_days(-retentionDays);
	const cutoffDate = `${cutoff.get_year()}-${String(cutoff.get_month()).padStart(2, '0')}-${String(cutoff.get_day_of_month()).padStart(2, '0')}`;

	try {
		const dirFile = Gio.File.new_for_path(dir);
		const enumerator = dirFile.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
		let info;
		while ((info = enumerator.next_file(null)) !== null) {
			const name = info.get_name();
			const match = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
			if (!match) continue;
			if (match[1] < cutoffDate) {
				try {
					dirFile.get_child(name).delete(null);
				} catch (e) {
					console.error(`Failed to delete old screen time file ${name}: ${e.message}`);
				}
			}
		}
		enumerator.close(null);
	} catch (e) {
		console.error(`Failed to cleanup old screen time files: ${e.message}`);
	}
}

function loadJsonFromFileAsync(filePath, callback) {
	const file = Gio.File.new_for_path(filePath);
	file.load_contents_async(null, (source, result) => {
		try {
			const [ok, contents] = source.load_contents_finish(result);
			if (ok) {
				const data = JSON.parse(new TextDecoder('utf-8').decode(contents));
				callback(data);
			} else {
				callback(null);
			}
		} catch (e) {
			callback(null);
		}
	});
}

function saveJsonToFile(filePath, data) {
	try {
		const dir = GLib.path_get_dirname(filePath);
		GLib.mkdir_with_parents(dir, 0o755);
		const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
		Gio.File.new_for_path(filePath).replace_contents_bytes_async(
			GLib.Bytes.new(bytes), null, false, Gio.FileCreateFlags.NONE, null,
			(file, result) => {
				try {
					file.replace_contents_finish(result);
				} catch (e) {
					console.error(`Failed to save screen time data: ${e.message}`);
				}
			});
	} catch (e) {
		console.error(`Failed to save screen time data: ${e.message}`);
	}
}

export const screenTimeEngine = {
	_refCount: 0,
	_appHours: new Map(),
	_focusedKey: null,
	_focusStartMicro: null,
	_currentDate: null,
	_tickId: 0,
	_focusSignalId: 0,
	_saveThrottleId: 0,
	_listeners: new Set(),
	_retentionDays: DEFAULT_RETENTION_DAYS,

	/** Sets how many days of history to keep; older files are cleaned up on next start/rollover. */
	setRetentionDays(days) {
		const value = Math.max(1, Math.floor(Number(days) || DEFAULT_RETENTION_DAYS));
		if (value === this._retentionDays) return;
		this._retentionDays = value;
		cleanupOldFiles(this._retentionDays);
	},

	acquire() {
		this._refCount++;
		if (this._refCount === 1) this._start();
		return () => this.release();
	},

	release() {
		if (this._refCount === 0) return;
		this._refCount--;
		if (this._refCount === 0) this._stop();
	},

	addListener(callback) {
		this._listeners.add(callback);
	},

	removeListener(callback) {
		this._listeners.delete(callback);
	},

	getTodayDate() {
		return this._currentDate;
	},

	getTodaySnapshot() {
		return this._buildSnapshot(this._currentDate, this._appHours);
	},

	loadDayAsync(dateString, callback) {
		this._loadRawAsync(dateString, (appsMap) => {
			callback(this._buildSnapshot(dateString, appsMap));
		});
	},

	_loadRawAsync(dateString, callback) {
		loadJsonFromFileAsync(dayFilePath(dateString), (data) => {
			const appsMap = new Map();
			if (data && typeof data.apps === 'object') {
				for (const [key, hours] of Object.entries(data.apps)) {
					if (Array.isArray(hours))
						appsMap.set(key, hours.slice(0, HOURS_PER_DAY));
				}
			}
			callback(appsMap);
		});
	},

	_buildSnapshot(dateString, appsMap) {
		const hoursAggregate = new Array(HOURS_PER_DAY).fill(0);
		const apps = [];
		let totalSeconds = 0;

		for (const [key, hours] of appsMap) {
			let appTotal = 0;
			for (let hour = 0; hour < hours.length; hour++) {
				appTotal += hours[hour];
				hoursAggregate[hour] += hours[hour];
			}
			totalSeconds += appTotal;
			if (appTotal > 0)
				apps.push({ key, seconds: appTotal });
		}

		apps.sort((a, b) => b.seconds - a.seconds);
		return { date: dateString, totalSeconds, apps, hours: hoursAggregate };
	},

	_start() {
		this._currentDate = todayDateString();
		cleanupOldFiles(this._retentionDays);
		this._focusedKey = this._resolveFocusedKey();
		this._focusStartMicro = this._focusedKey ? GLib.get_real_time() : null;
		this._focusSignalId = global.display.connect('notify::focus-window', () => this._onFocusChanged());
		this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_INTERVAL_MS, () => {
			this._tick();
			return GLib.SOURCE_CONTINUE;
		});

		const loadDate = this._currentDate;
		this._loadRawAsync(loadDate, (loadedMap) => {
			if (this._refCount === 0 || this._currentDate !== loadDate)
				return;
			for (const [key, hours] of loadedMap) {
				if (!this._appHours.has(key))
					this._appHours.set(key, hours);
			}
		});
	},

	_stop() {
		if (this._tickId) {
			GLib.Source.remove(this._tickId);
			this._tickId = 0;
		}
		if (this._focusSignalId) {
			global.display.disconnect(this._focusSignalId);
			this._focusSignalId = 0;
		}
		this._flushFocused(GLib.get_real_time());
		this._saveNow();
		this._appHours.clear();
		this._listeners.clear();
		this._focusedKey = null;
		this._focusStartMicro = null;
	},

	_onFocusChanged() {
		const now = GLib.get_real_time();
		this._flushFocused(now);
		this._focusedKey = this._resolveFocusedKey();
		this._focusStartMicro = this._focusedKey ? now : null;
	},

	_tick() {
		const now = GLib.get_real_time();
		this._flushFocused(now);
		this._maybeRollover();
		this._scheduleSave();
		for (const callback of this._listeners)
			callback();
	},

	_maybeRollover() {
		const today = todayDateString();
		if (today === this._currentDate) return;
		this._saveNow();
		this._currentDate = today;
		this._appHours.clear();
		cleanupOldFiles(this._retentionDays);
	},

	_flushFocused(nowMicro) {
		if (!this._focusedKey || this._focusStartMicro === null) return;

		let cursor = this._focusStartMicro;
		while (cursor < nowMicro) {
			const epochSecond = Math.floor(cursor / MICROSECONDS_PER_SECOND);
			const segmentStart = GLib.DateTime.new_from_unix_local(epochSecond);
			const secondsIntoHour = segmentStart.get_minute() * 60 + segmentStart.get_second();

			this._maybeRollover();

			const boundaryEpochSecond = epochSecond - secondsIntoHour + SECONDS_PER_HOUR;
			const cursorEnd = Math.min(nowMicro, boundaryEpochSecond * MICROSECONDS_PER_SECOND);
			const seconds = Math.floor((cursorEnd - cursor) / MICROSECONDS_PER_SECOND);
			if (seconds > 0)
				this._addSeconds(this._focusedKey, segmentStart.get_hour(), seconds);

			cursor = cursorEnd;
		}
		this._focusStartMicro = nowMicro;
	},

	_addSeconds(appKey, hour, seconds) {
		let hours = this._appHours.get(appKey);
		if (!hours) {
			hours = new Array(HOURS_PER_DAY).fill(0);
			this._appHours.set(appKey, hours);
		}
		hours[hour] += seconds;
	},

	_resolveFocusedKey() {
		const focusedWindow = global.display.focus_window;
		if (!focusedWindow) return null;
		const app = Shell.WindowTracker.get_default().get_window_app(focusedWindow);
		if (!app) return null;
		return app.get_id() || app.get_name() || null;
	},

	_scheduleSave() {
		if (this._saveThrottleId) return;
		this._saveThrottleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_THROTTLE_MS, () => {
			this._saveThrottleId = 0;
			this._saveNow();
			return GLib.SOURCE_REMOVE;
		});
	},

	_saveNow() {
		if (this._saveThrottleId) {
			GLib.Source.remove(this._saveThrottleId);
			this._saveThrottleId = 0;
		}
		saveJsonToFile(dayFilePath(this._currentDate), {
			date: this._currentDate,
			apps: Object.fromEntries(this._appHours),
		});
	},
};
