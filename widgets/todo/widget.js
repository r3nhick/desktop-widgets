/*
 * Task widget ported from gridgets
 * Adapted for desktop-widgets@r3nhick rendering system
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { getDataDir, isActorDestroyed, loadJsonFromFileAsync, parseCssColor, saveJsonToFile, saveJsonToFileSync, cssColorToRgba } from '../../utils/ported.js';

export const type = 'todo';
export const label = 'Task';
export const defaultSize = 'medium';
export const supportedSizes = ['mini', 'medium', 'large', 'tall'];

const REF_WIDTH = 360;
const REF_HEIGHT = 170;
const SECONDARY_OPACITY = 0.55;
const LEFT_COLUMN_WIDTH = 110;
const MINI_LEFT_COLUMN_WIDTH = 88;
const TITLE_FONT_SIZE = 22;
const TITLE_FONT_SIZE_MINI = 30;
const COUNT_FONT_SIZE = 36;
const COUNT_FONT_SIZE_MINI = 34;
const ADD_BUTTON_SIZE = 36;
const ADD_BUTTON_SIZE_MINI = 29;
const TASK_ROW_RADIUS = 12;
const TASK_ROW_PADDING_V = 12;
const TASK_ROW_PADDING_H = 16;
const TASK_TEXT_FONT_SIZE = 17;
const TASK_TEXT_FONT_SIZE_MINI = 26;
const CHECKBOX_SIZE = 19;
const CHECKBOX_SIZE_MINI = 16;
const ROW_SPACING = 10;
const BORDER_ALPHA = 0.14;

const DEFAULT_TASKS = [
    { text: 'Make tea', done: false },
    { text: 'Make cake', done: false },
    { text: 'Linux os', done: false },
];

const defaultTaskText = (text) => ({
    'Make tea': _('Make tea'),
    'Make cake': _('Make cake'),
    'Linux os': _('Linux os'),
}[text] ?? text);

function textOnAccentColor(hex) {
    const { r, g, b } = parseCssColor(hex);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    return lum > 0.55 ? 'rgba(30,30,30,0.92)' : 'rgba(255,255,255,0.92)';
}

export function style(theme) {
    return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text};`;
}

export function render({ body, widget, theme, sizeForWidget }) {
    const accentHex = theme.accent || '#3584e4';
    const accentRgb = parseCssColor(accentHex);
    const accentBytes = `${Math.round(accentRgb.r * 255)},${Math.round(accentRgb.g * 255)},${Math.round(accentRgb.b * 255)}`;
    const accentStyle = `color: ${accentHex};`;
    const rowBg = `background-color: rgba(${accentBytes},0.1);`;
    const textColor = theme.text;
    const sizeKey = widget?.size ?? 'medium';
    const isMini = sizeKey === 'mini';

    const todosFilePath = GLib.build_filenamev([
        getDataDir('todos'),
        `todo-${widget?.id}.json`,
    ]);

    let tasks = DEFAULT_TASKS.map(t => ({ ...t, text: defaultTaskText(t.text) }));
    let tasksLoaded = false;
    const state = { entryVisible: false };

    const [refW, refH] = sizeForWidget(widget);
    const contentW = Math.max(1, refW - 34);
    const contentH = Math.max(1, refH - 34);
    const scale = Math.max(0.4, Math.min(contentW / REF_WIDTH, contentH / REF_HEIGHT));
    const px = (v) => Math.max(1, Math.round(v * scale));

    const mainBox = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        x_expand: true,
        y_expand: true,
    });
    body.add_child(mainBox);

    const leftColumn = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style: `width: ${px(isMini ? MINI_LEFT_COLUMN_WIDTH : LEFT_COLUMN_WIDTH)}px;`,
    });
    mainBox.add_child(leftColumn);

    const titleLabel = new St.Label({
        text: _('Tasks'),
        style: `font-size: ${px(isMini ? TITLE_FONT_SIZE_MINI : TITLE_FONT_SIZE)}px; font-weight: 700; color: ${textColor}; opacity: ${SECONDARY_OPACITY};`,
    });

    const counterRow = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        style: 'margin-top: 6px; spacing: 8px;',
    });

    const listIcon = new St.Icon({
        icon_name: 'view-list-symbolic',
        icon_size: px(isMini ? 26 : 30),
        style: accentStyle,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const countLabel = new St.Label({
        text: String(tasks.filter(t => !t.done).length),
        style: `font-size: ${px(isMini ? COUNT_FONT_SIZE_MINI : COUNT_FONT_SIZE)}px; font-weight: 500; color: ${textColor};`,
        y_align: Clutter.ActorAlign.CENTER,
    });

    counterRow.add_child(listIcon);
    counterRow.add_child(countLabel);

    const addButton = new St.Button({
        child: new St.Icon({
            icon_name: 'list-add-symbolic',
            icon_size: px(isMini ? 20 : 26),
            style: accentStyle,
        }),
        reactive: true,
        can_focus: true,
        style: rowBg + ` border-radius: 9999px; width: ${px(isMini ? ADD_BUTTON_SIZE_MINI : ADD_BUTTON_SIZE)}px; height: ${px(isMini ? ADD_BUTTON_SIZE_MINI : ADD_BUTTON_SIZE)}px;`,
    });

    if (isMini) {
        leftColumn.add_child(titleLabel);
        leftColumn.add_child(counterRow);
        leftColumn.add_child(new St.Widget({ y_expand: true }));
        leftColumn.add_child(addButton);
    } else {
        leftColumn.add_child(titleLabel);
        leftColumn.add_child(counterRow);
        leftColumn.add_child(new St.Widget({ y_expand: true }));
        leftColumn.add_child(addButton);
    }

    const rightColumn = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
        style: `spacing: ${px(ROW_SPACING)}px; padding-left: ${isMini ? 4 : 10}px;`,
    });
    mainBox.add_child(rightColumn);

    const scrollView = new St.ScrollView({
        style_class: 'vfade',
        x_expand: true,
        y_expand: true,
    });
    scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.EXTERNAL);
    rightColumn.add_child(scrollView);

    const taskList = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        style: `spacing: ${px(ROW_SPACING)}px;`,
    });
    scrollView.set_child(taskList);

    const entryRow = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        x_expand: true,
        style: rowBg + ` border-radius: ${px(TASK_ROW_RADIUS)}px; padding: ${Math.max(1, px(TASK_ROW_PADDING_V) - 3)}px ${px(TASK_ROW_PADDING_H)}px;`,
    });

    const taskEntry = new St.Entry({
        hint_text: _('New task…'),
        can_focus: true,
        x_expand: true,
    });
    entryRow.add_child(taskEntry);
    entryRow.hide();
    rightColumn.add_child(entryRow);
    body.set_clip_to_allocation(true);

    const save = () => saveJsonToFile(todosFilePath, { tasks });

    function buildTaskRow(task) {
        const fontSize = px(isMini ? TASK_TEXT_FONT_SIZE_MINI : TASK_TEXT_FONT_SIZE);
        const cSize = px(isMini ? CHECKBOX_SIZE_MINI : CHECKBOX_SIZE);

        const row = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            style: rowBg + ` border-radius: ${px(TASK_ROW_RADIUS)}px; padding: ${px(TASK_ROW_PADDING_V)}px ${px(TASK_ROW_PADDING_H)}px; spacing: ${px(10)}px;`,
        });

        const checkbox = new St.Button({
            reactive: true,
            can_focus: true,
            style: task.done
                ? `background-color: ${accentHex}; border-radius: 9999px; width: ${cSize}px; height: ${cSize}px;`
                : `border: 1.5px solid ${cssColorToRgba(textColor, 0.35)}; border-radius: 9999px; width: ${cSize}px; height: ${cSize}px;`,
            y_align: Clutter.ActorAlign.START,
        });

        if (task.done) {
            checkbox.child = new St.Icon({
                icon_name: 'object-select-symbolic',
                icon_size: px(isMini ? 12 : 16),
                style: `color: ${textOnAccentColor(accentHex)};`,
            });
        }

        const escaped = String(task.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const labelText = task.done ? `<s>${escaped}</s>` : escaped;

        const textLabel = new St.Label({
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
            style: `font-size: ${fontSize}px; color: ${textColor}; opacity: ${task.done ? 0.5 : 1.0};`,
        });
        textLabel.clutter_text.use_markup = true;
        textLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        textLabel.clutter_text.line_wrap = true;
        textLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        textLabel.clutter_text.set_markup(labelText);

        checkbox.connect('clicked', () => {
            if (isActorDestroyed(body)) return;
            task.done = !task.done;
            save();
            renderTasks();
        });

        const deleteButton = new St.Button({
            child: new St.Icon({
                icon_name: 'edit-delete-symbolic',
                icon_size: px(isMini ? 17 : 18),
            }),
            reactive: true,
            can_focus: true,
            style: 'opacity: 0.45;',
            y_align: Clutter.ActorAlign.START,
        });
        deleteButton.connect('clicked', () => {
            if (isActorDestroyed(body)) return;
            const idx = tasks.indexOf(task);
            if (idx !== -1) {
                tasks.splice(idx, 1);
                save();
                renderTasks();
            }
        });

        row.add_child(checkbox);
        row.add_child(textLabel);
        row.add_child(deleteButton);
        return row;
    }

    function renderTasks() {
        if (isActorDestroyed(body)) return;
        countLabel.text = String(tasks.filter(t => !t.done).length);
        taskList.destroy_all_children();
        if (tasks.length === 0) {
            taskList.add_child(new St.Label({
                text: _('No tasks yet'),
                x_align: Clutter.ActorAlign.CENTER,
                style: `font-size: ${px(TASK_TEXT_FONT_SIZE)}px; color: ${textColor}; opacity: 0.5;`,
            }));
            return;
        }
        tasks.forEach(task => taskList.add_child(buildTaskRow(task)));
    }

    const showEntry = () => {
        state.entryVisible = true;
        entryRow.show();
        global.stage.set_key_focus(taskEntry);
    };

    const hideEntry = () => {
        state.entryVisible = false;
        taskEntry.text = '';
        entryRow.hide();
        if (global.stage.get_key_focus() === taskEntry)
            global.stage.set_key_focus(null);
    };

    const commitTask = () => {
        const text = taskEntry.text.trim();
        if (text !== '') {
            tasks.push({ text, done: false });
            save();
            renderTasks();
        }
        hideEntry();
    };

    addButton.connect('clicked', () => {
        if (isActorDestroyed(body)) return;
        if (state.entryVisible) hideEntry();
        else showEntry();
    });

    taskEntry.clutter_text.connect('key-press-event', (_actor, event) => {
        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
            commitTask();
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Escape) {
            hideEntry();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });

    body.connect('destroy', () => {
        if (global.stage.get_key_focus() === taskEntry)
            global.stage.set_key_focus(null);
        if (tasksLoaded)
            saveJsonToFileSync(todosFilePath, { tasks });
    });

    loadJsonFromFileAsync(todosFilePath, (savedData, loadError) => {
        if (isActorDestroyed(body)) return;
        tasksLoaded = true;
        if (savedData && Array.isArray(savedData.tasks)) {
            tasks = savedData.tasks.filter(t => t && typeof t.text === 'string').map(t => ({ text: t.text, done: !!t.done }));
            renderTasks();
        } else if (!loadError) {
            save();
        }
    });

    renderTasks();
}
