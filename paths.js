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

/**
 * Шлях до іконки розширення (`icons/hicolor/scalable/actions/<name>.svg`).
 *
 * Потрібний у shell, де GTK не шукає в темі: іконки dw-* мають два
 * кольорові варіанти (-light/-dark) і не мають суфікса -symbolic, тож
 * їх не можна віддати через icon_name — тільки шляхом на диск.
 */
function iconPath(name) {
	return EXTENSION_PATH
		? GLib.build_filenamev([
			EXTENSION_PATH,
			'icons',
			'hicolor',
			'scalable',
			'actions',
			`${String(name ?? '')}.svg`,
		])
		: null;
};

export { EXTENSION_PATH, assetPath, iconPath };