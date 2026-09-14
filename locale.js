import GLib from 'gi://GLib';

let _lang = null;

export function lang() {
	if (!_lang) {
		const name = (GLib.get_language_names()[0] || '').toLowerCase();

		if (name.startsWith('uk')) {
			_lang = 'uk';
		} else if (name.startsWith('ru')) {
			_lang = 'ru';
		} else {
			_lang = 'en';
		};
	};

	return _lang;
};
