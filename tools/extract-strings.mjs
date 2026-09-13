import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const MSGID_RE = /_\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/g;

function walk(directory, files = []) {
	for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
		const full = path.join(directory, entry.name);

		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === 'po' || entry.name === 'locale') {
				continue;
			};

			walk(full, files);
		} else if (entry.name.endsWith('.js')) {
			files.push(full);
		};
	};

	return files;
};

function collect() {
	const found = new Map();

	for (const file of walk(ROOT)) {
		const text = fs.readFileSync(file, 'utf8');
		MSGID_RE.lastIndex = 0;

		let match;
		while ((match = MSGID_RE.exec(text))) {
			const msgid = match[2].replace(/\\'/g, "'").replace(/\\"/g, '"');

			if (!found.has(msgid)) {
				found.set(msgid, []);
			};

			const relative = file.replace(ROOT, '');
			const line = text.slice(0, match.index).split('\n').length;
			found.get(msgid).push(`${relative}:${line}`);
		};
	};

	return found;
};

const entries = collect();
const potPath = path.join(ROOT, 'po', 'desktop-widgets@r3nhick.pot');

fs.mkdirSync(path.dirname(potPath), {recursive: true});

const out = [];
out.push('msgid ""');
out.push('msgstr ""');
out.push('"Project-Id-Version: desktop-widgets@r3nhick\\n"');
out.push('"MIME-Version: 1.0\\n"');
out.push('"Content-Type: text/plain; charset=UTF-8\\n"');
out.push('"Content-Transfer-Encoding: 8bit\\n"');
out.push('"Language-Team: r3nhick\\n"');
out.push('');

for (const [msgid, refs] of [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
	for (const ref of refs) {
		out.push(`#: ${ref}`);
	};

	out.push(`msgid "${escapeC(msgid)}"`);
	out.push('msgstr ""');
	out.push('');
};

fs.writeFileSync(potPath, out.join('\n'));
console.log(`Extracted ${entries.size} strings -> ${potPath}`);

function escapeC(text) {
	return text.replace(/\\(?!")/g, '\\\\').replace(/"/g, '\\"');
};