import GLib from 'gi://GLib';

let EXTENSION_PATH = null;

try {
	const [path] = GLib.filename_from_uri(import.meta.url);

	EXTENSION_PATH = GLib.path_get_dirname(path);
} catch (error) {
	EXTENSION_PATH = null;
};

function assetPath(name) {
	return EXTENSION_PATH ? GLib.build_filenamev([EXTENSION_PATH, 'assets', String(name ?? '')]) : null;
};

export { EXTENSION_PATH, assetPath };