import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DATA_DIR_NAME = 'desktop-widgets@r3nhick';
const ensuredDirectories = new Set();

function ensureDirectory(dirPath) {
	if (ensuredDirectories.has(dirPath)) {
		return;
	}

	try {
		const file = Gio.File.new_for_path(dirPath);

		if (!file.query_exists(null)) {
			file.make_directory_with_parents(null);
		}

		ensuredDirectories.add(dirPath);
	} catch (error) {
		console.error(`Error creating data directory ${dirPath}: ${error}`);
	}
}

export function getDataDir(subFolder = '') {
	const parts = [GLib.get_user_data_dir(), DATA_DIR_NAME];

	if (subFolder) {
		parts.push(subFolder);
	}

	const dir = GLib.build_filenamev(parts);
	ensureDirectory(dir);
	return dir;
}

export function loadJsonFromFileAsync(filePath, callback) {
	const file = Gio.File.new_for_path(filePath);

	file.load_contents_async(null, (fileObj, res) => {
		let contents = null;

		try {
			const [, bytes] = fileObj.load_contents_finish(res);

			if (bytes) {
				contents = bytes;
			}
		} catch (error) {
			if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
				console.error(`Error reading ${filePath}: ${error}`);
			}

			callback(null);
			return;
		}

		if (!contents || contents.length === 0) {
			callback(null);
			return;
		}

		try {
			callback(JSON.parse(new TextDecoder('utf-8').decode(contents)));
		} catch (parseError) {
			console.error(`Corrupt JSON in ${filePath}; ignoring saved data: ${parseError}`);
			callback(null, parseError);
		}
	});
}

function writeFile(filePath, data) {
	const parent = Gio.File.new_for_path(filePath).get_parent();

	if (parent) {
		ensureDirectory(parent.get_path());
	}

	const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));

	try {
		Gio.File.new_for_path(filePath).replace_contents(
			bytes, null, false, Gio.FileCreateFlags.NONE, null);
	} catch (error) {
		console.error(`Error saving JSON to ${filePath}: ${error}`);
	}
}

export function saveJsonToFile(filePath, data) {
	writeFile(filePath, data);
}

export function saveJsonToFileSync(filePath, data) {
	try {
		writeFile(filePath, data);
	} catch (error) {
		console.error(`Error saving JSON to ${filePath}: ${error}`);
	}
}

export function isActorDestroyed(actor) {
	try {
		actor.get_stage();
		return false;
	} catch (e) {
		return true;
	}
}

export function parseCssColor(cssColor) {
	if (cssColor.startsWith('#')) {
		const hex = cssColor.slice(1);
		const r = parseInt(hex.slice(0, 2), 16) / 255;
		const g = parseInt(hex.slice(2, 4), 16) / 255;
		const b = parseInt(hex.slice(4, 6), 16) / 255;
		return { r, g, b };
	}
	const rgbaMatch = cssColor.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)$/);
	if (rgbaMatch) {
		return {
			r: parseFloat(rgbaMatch[1]) / 255,
			g: parseFloat(rgbaMatch[2]) / 255,
			b: parseFloat(rgbaMatch[3]) / 255,
			a: rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1,
		};
	}
	return { r: 0, g: 0, b: 0 };
}

export function cssColorToRgba(cssColor, alpha = 1) {
	const { r, g, b } = parseCssColor(cssColor);
	return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`;
}
