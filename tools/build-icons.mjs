#!/usr/bin/env node
/**
 * Генерує іконки розширення з lucide-вихідників у двох кольорах.
 *
 * ЧОМ НЕ `-symbolic`:
 * GTK 4 (gtkiconpaintable.c) для іконки з суфіксом `-symbolic` бере
 * ФОРМУ шляху і заливає її суцільним кольором foreground — `fill="none"`
 * ігнорується. Перевірено експериментом: коло r=8 зі stroke-width 1.5
 * дає 37% непрозорих пікселів замість ~13% у контурі. Тобто всі
 * лінійні (lucide) іконки перетворюються на суцільні плями.
 *
 * Тому іконки йдуть БЕЗ суфікса: тоді GTK малює їх буквально, і
 * колір береться з файлу. Щоб працювало в обох темах, генеруємо
 * дві копії:
 *   dw-<name>-light.svg  — темні контури, для світлої теми
 *   dw-<name>-dark.svg   — світлі контури, для темної теми
 * prefs.js обирає потрібну і перемикає при зміні теми.
 *
 * Використання:
 *   node tools/build-icons.mjs <каталог з lucide *.svg>
 */

import {readdirSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, basename} from 'node:path';

const SRC = process.argv[2] || join(
    process.env.HOME, 'Downloads', 'Icons');
const OUT = join(
    import.meta.dirname, '..', 'icons', 'hicolor', 'scalable', 'actions');

/** Товщина контуру. 1.5 — щоб лінії weren't злипались на 16px. */
const STROKE_WIDTH = '1.5';

const SHAPES = ['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'];

const THEMES = {
    light: '#1c1a29',   // світла тема: темні контури
    dark: '#ffffff',    // темна тема: світлі контури
};

/** Кольори, які GTK підставляє замість поточного stroke. */
const STROKE = /stroke="[^"]*"/g;

/**
 * Ставить на кожну фігуру явні атрибути обведення.
 * Робимо це явно (а не успадкуванням), бо GTK не гарантує
 * успадкування presentation-атрибутів через власні елементи.
 */
function shapeAttrs(tag, color) {
    let out = tag;

    if (/stroke="[^"]*"/.test(out)) {
        out = out.replace(STROKE, `stroke="${color}"`);
    } else {
        out = injectBeforeClose(out, `stroke="${color}"`);
    }

    if (/stroke-width="[^"]*"/.test(out)) {
        out = out.replace(/stroke-width="[^"]*"/g, `stroke-width="${STROKE_WIDTH}"`);
    } else {
        out = injectBeforeClose(out, `stroke-width="${STROKE_WIDTH}"`);
    }

    if (!/fill="/.test(out))
        out = injectBeforeClose(out, 'fill="none"');

    if (!/stroke-linecap=/.test(out))
        out = injectBeforeClose(out, 'stroke-linecap="round" stroke-linejoin="round"');

    return out;
}

/** Вставляє атрибути перед /> або >. */
function injectBeforeClose(tag, attrs) {
    return tag.endsWith('/>')
        ? `${tag.slice(0, -2).trimEnd()} ${attrs}/>`
        : `${tag.slice(0, -1).trimEnd()} ${attrs}>`;
}

/** Прибирає службові класи lucide — GTK їх не потребує. */
function stripClasses(tag) {
    if (!/class="[^"]*"/.test(tag))
        return tag;
    return tag.replace(/class="([^"]*)"/, (_m, cls) => {
        const keep = cls.split(/\s+/).filter(c => c.startsWith('lucide'));
        return keep.length ? ` class="${keep.join(' ')}"` : '';
    });
}

/** Перетворює lucide-SVG на наш формат для однієї теми. */
function convert(source, color) {
    let out = source;

    // корінь: розмір 16px, viewBox лишаємо 24 — GTK масштабує
    out = out.replace(/<svg\b[^>]*?>/, tag => {
        let t = tag;
        t = t.replace(/width="[^"]*"/, 'width="16"');
        t = t.replace(/height="[^"]*"/, 'height="16"');
        t = t.replace(STROKE, `stroke="${color}"`);
        if (!/viewBox=/.test(t))
            t = injectBeforeClose(t, 'viewBox="0 0 24 24"');
        if (!/fill=/.test(t))
            t = injectBeforeClose(t, 'fill="none"');
        if (/stroke-width=/.test(t))
            t = t.replace(/stroke-width="[^"]*"/, `stroke-width="${STROKE_WIDTH}"`);
        else
            t = injectBeforeClose(t, `stroke-width="${STROKE_WIDTH}"`);
        if (!/stroke-linecap=/.test(t))
            t = injectBeforeClose(t, 'stroke-linecap="round" stroke-linejoin="round"');
        return stripClasses(t);
    });

    // кожна фігура
    for (const shape of SHAPES)
        out = out.replace(new RegExp(`<${shape}\\b[^>]*?/?>`, 'g'),
            tag => stripClasses(shapeAttrs(tag, color)));

    return `${out.trim()}\n`;
}

function main() {
    mkdirSync(OUT, {recursive: true});

    let files;
    try {
        files = readdirSync(SRC).filter(f => f.endsWith('.svg')).sort();
    } catch {
        console.error(`не читаю каталог ${SRC}`);
        process.exit(1);
    }
    if (!files.length) {
        console.error(`у ${SRC} немає *.svg`);
        process.exit(1);
    }

    for (const file of files) {
        const name = basename(file, '.svg');
        const source = readFileSync(join(SRC, file), 'utf8');
        for (const [theme, color] of Object.entries(THEMES)) {
            const target = join(OUT, `dw-${name}-${theme}.svg`);
            writeFileSync(target, convert(source, color));
        }
        console.log(`✓ ${name} → dw-${name}-light.svg, dw-${name}-dark.svg`);
    }

    console.log(`\n${files.length} іконок × ${Object.keys(THEMES).length} теми`);
}

main();
