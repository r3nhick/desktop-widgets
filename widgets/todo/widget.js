/*
 * Task widget ported from gridgets
 * Adapted for desktop-widgets@r3nhick rendering system
 */

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { attachBounce, bindHoverShrink } from '../../lib/buttonBounce.js';
import { editorKeyAction } from '../../lib/todoEditorKeys.js';
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
    // Completion transitions queued by the checkbox and consumed by
    // buildTaskRow on the row that the rebuild creates (the clicked row is
    // destroyed in the same frame, so animations must target the new one).
    const animQueue = new Map(); // task object → 'toDone' | 'toUndone'

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
        // The row already carries the translucent band; the shell theme's
        // solid entry fill painted a dark block over the Glass backdrop.
        style: `background-color: transparent; border: none; box-shadow: none; padding: 0; color: ${textColor};`,
    });
    entryRow.add_child(taskEntry);
    entryRow.hide();
    rightColumn.add_child(entryRow);
    body.set_clip_to_allocation(true);

    const save = () => saveJsonToFile(todosFilePath, { tasks });

    // The row being text-edited right now (editor replaces the label).
    let editingTask = null;
    const setImmediateRowFocus = (editor) => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            // global.stage.set_key_focus is the notes widget's proven way to
            // focus a Clutter.Text; grab_key_focus raced the shell's own
            // focus routing there.
            if (!isActorDestroyed(editor))
                global.stage.set_key_focus(editor);
            return GLib.SOURCE_REMOVE;
        });
    };

    function buildTaskRow(task) {
        const fontSize = px(isMini ? TASK_TEXT_FONT_SIZE_MINI : TASK_TEXT_FONT_SIZE);
        const cSize = px(isMini ? CHECKBOX_SIZE_MINI : CHECKBOX_SIZE);
        const anim = animQueue.get(task) ?? null;
        if (anim) animQueue.delete(task);

        const editing = editingTask === task;

        const row = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            reactive: true,
            style: rowBg + ` border-radius: ${px(TASK_ROW_RADIUS)}px; padding: ${px(TASK_ROW_PADDING_V)}px ${px(TASK_ROW_PADDING_H)}px; spacing: ${px(10)}px;`,
        });
        // Hover feedback softer than the buttons' 0.85: the wide row shrinks
        // just a touch on both axes and springs back on leave. A row flag
        // gates everything: rows are destroyed wholesale on every re-render
        // and their enter/leave events keep firing mid-dispose — touching a
        // disposed actor there crashed the shell.
        let rowAlive = true;
        row.connect('destroy', () => { rowAlive = false; });
        row.set_pivot_point(0.5, 0.5);
        row.connect('enter-event', (actor, event) => {
            if (!rowAlive) return Clutter.EVENT_PROPAGATE;
            if (!editing && !isActorDestroyed(editButton))
                editButton.opacity = 255;
            if (anim) return Clutter.EVENT_PROPAGATE;

            // Screen coords -> row-relative geometry: when the pointer
            // sits inside the outer 2% band, the infinite squash starts
            // (scale shrinks its own hit area, the retargeted pointer
            // falls out, leave cancels and the pointer re-enters in
            // place — GJS sides it as a flicker/steady-state loop; tall
            // rows grow the band from ~0.7px into a real fall-in zone).
            // Those positions hover WITHOUT the squash; the reveal above
            // still plays.
            let squash = true;
            try {
                const [rowX, rowY] = row.get_transformed_position();
                const [rowW, rowH] = row.get_transformed_size();
                const [ptrX, ptrY] = event.get_coords();
                const relY = rowH > 0 ? (ptrY - rowY) / rowH : 0.5;
                const relX = rowW > 0 ? (ptrX - rowX) / rowW : 0.5;

                if (relY < 0.02 || relY > 0.98 || relX < 0.015 || relX > 0.985) {
                    squash = false;
                };

            } catch (e) {
                // Unallocated row mid-flight: keep the squash (the safest
                // default for the common hover case).

            };

            if (!squash) return Clutter.EVENT_PROPAGATE;
            row.ease({
                scale_x: 0.97,
                scale_y: 0.97,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
            return Clutter.EVENT_PROPAGATE;
        });
        row.connect('leave-event', () => {
            if (!rowAlive) return Clutter.EVENT_PROPAGATE;
            if (!editing && !isActorDestroyed(editButton)) editButton.opacity = 0;
            row.ease({
                scale_x: 1,
                scale_y: 1,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
            return Clutter.EVENT_PROPAGATE;
        });

        const checkbox = new St.Button({
            reactive: true,
            can_focus: true,
            style: task.done
                ? `background-color: ${accentHex}; border: 1.5px solid ${accentHex}; border-radius: 9999px; width: ${cSize}px; height: ${cSize}px;`
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
            // The codebase's own proven idiom (github card): the label
            // centers itself in the row height — y_expand inflated the row
            // instead (user-visible).
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${fontSize}px; color: ${textColor};`,
        });
        textLabel.clutter_text.use_markup = true;
        textLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        textLabel.clutter_text.line_wrap = true;
        textLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        textLabel.clutter_text.set_markup(labelText);
        textLabel.opacity = task.done ? 128 : 255;

        const toggleTask = () => {
            if (rowAlive === false) return;
            if (isActorDestroyed(body)) return;
            // A click on another row while one row is being edited just
            // closes the editor — the click is not a completion toggle.
            if (editingTask !== null && editingTask !== task) {
                editingTask = null;
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (!isActorDestroyed(body) && body.get_parent())
                        renderTasks();
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            // Transition plays on the rebuilt row: this one is destroyed in
            // the same frame, animations started here would never run.
            animQueue.set(task, task.done ? 'toUndone' : 'toDone');
            task.done = !task.done;
            save();
            // The rebuild destroys rows — never do it inside a dispatched
            // click/emission on this very row; defer to the next idle.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (!isActorDestroyed(body) && body.get_parent())
                    renderTasks();
                return GLib.SOURCE_REMOVE;
            });
        };

        checkbox.connect('clicked', toggleTask);
        // Clicking anywhere on the row toggles the task too — the checkbox
        // and the buttons swallow their own clicks first (EVENT_STOP), so
        // they never double-fire through the row.
        row.connect('button-release-event', (_actor, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            toggleTask();
            return Clutter.EVENT_STOP;
        });

        // Pencil: hover-revealed via the actor's opacity property (a CSS
        // 'opacity: 0' style may be overridden by the theme, leaving it
        // always visible).
        const editButton = new St.Button({
            child: new St.Icon({
                icon_name: 'document-edit-symbolic',
                icon_size: px(isMini ? 14 : 15),
            }),
            reactive: true,
            can_focus: true,
            opacity: 0,
            y_align: Clutter.ActorAlign.CENTER,
        });
        attachBounce(editButton);
        editButton.connect('clicked', () => {
            if (isActorDestroyed(body)) return;
            editingTask = task;
            // Rebuilding rows inside the click's own signal emission leaves
            // events mid-dispatch on disposed actors — defer it to the next
            // idle so the editor opens cleanly.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (!isActorDestroyed(body) && body.get_parent())
                    renderTasks();
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_STOP;
        });

        let rowContent = textLabel;
        if (editing) {
            // Multi-line editor: St.Entry is single-line, plain Clutter.Text
            // wraps and takes Shift+Enter newlines. Slightly smaller than the
            // row label (tight paddings, no theme entry chrome).
            const entryText = new Clutter.Text({
                text: String(task.text || ''),
                editable: true,
                selectable: true,
                reactive: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });
            entryText.single_line_mode = false;
            entryText.line_wrap = true;
            entryText.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            entryText.ellipsize = Pango.EllipsizeMode.NONE;
            // FILL so the text hugs the left edge: BinLayout centers a
            // non-expanding child, which visually centered the text.
            entryText.x_expand = true;
            entryText.x_align = Clutter.ActorAlign.FILL;
            entryText.font_name = `Ubuntu ${fontSize - 1}px`;
            // Clutter.Color is not exposed in this GJS — build a Cogl.Color
            // the way the notes widget's editor does.
            const makeColor = () => {
                const c = parseCssColor(textColor);
                const color = new Cogl.Color();
                color.red = Math.round(c.r * 255);
                color.green = Math.round(c.g * 255);
                color.blue = Math.round(c.b * 255);
                color.alpha = 255;
                return color;
            };
            entryText.set_color(makeColor());
            entryText.set_cursor_color(makeColor());

            const taskEntry = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
                reactive: true,
                style: `background-color: ${cssColorToRgba(textColor, 0.07)}; `
                    + `border-radius: ${px(7)}px; padding: ${px(3)}px ${px(6)}px;`,
            });
            taskEntry.add_child(entryText);
            const finishEdit = (accept) => {
                if (isActorDestroyed(body)) return;
                const value = String(entryText.text || '').trim();
                if (accept && value) {
                    task.text = value;
                    save();
                }
                editingTask = null;
                renderTasks();
            };
            // The handler lives on the FOCUSED actor (entryText) so it runs
            // BEFORE Clutter.Text's default key handling: plain Enter commits
            // before the newline is inserted, Shift+Enter propagates so the
            // text inserts the newline itself.
            entryText.connect('key-press-event', (_actor, event) => {
                const action = editorKeyAction(
                    event.get_key_symbol(),
                    (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0,
                    {
                        enter: Clutter.KEY_Return,
                        kpEnter: Clutter.KEY_KP_Enter,
                        escape: Clutter.KEY_Escape,
                    },
                );
                if (action === 'commit') {
                    finishEdit(true);
                    return Clutter.EVENT_STOP;
                }
                if (action === 'cancel') {
                    finishEdit(false);
                    return Clutter.EVENT_STOP;
                }
                // 'newline' = Shift+Enter: Clutter.Text never inserts the
                // break itself (the notes editor learned this the hard way) —
                // insert_unichar equals typing it and keeps cursor/selection
                // bookkeeping coherent; the bound collapse removes any stale
                // selection after the break.
                if (action === 'newline') {
                    entryText.insert_unichar('\n');
                    entryText.set_selection_bound(entryText.get_cursor_position());
                    return Clutter.EVENT_STOP;
                }
                // Everything else (typing) propagates.
                return Clutter.EVENT_PROPAGATE;
            });
            // NO cancel on key-focus-out: the shell re-routes key focus right
            // after the grab (searchController), firing focus-out within the
            // same frame — the editor would close itself immediately and the
            // pencil would look dead. Enter commits, Shift+Enter adds a new
            // line, Esc cancels.
            setImmediateRowFocus(entryText);
            rowContent = taskEntry;
        }

        const deleteButton = new St.Button({
            child: new St.Icon({
                icon_name: 'edit-delete-symbolic',
                icon_size: px(isMini ? 17 : 18),
            }),
            reactive: true,
            can_focus: true,
            style: 'opacity: 0.45;',
            // CENTRE like the pencil: with multi-line rows y_align START kept
            // the trash parked at the top of the grown row.
            y_align: Clutter.ActorAlign.CENTER,
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
        row.add_child(rowContent);
        row.add_child(editButton);
        row.add_child(deleteButton);
        // Press feedback on the checkbox and the delete (trash) button.
        attachBounce(checkbox);
        attachBounce(deleteButton);

        // Completion transition — livening up the checked state: the row
        // gives a soft squash, the checkbox fills in, the tick springs and
        // the text settles into the muted done look (or lights back up).
        if (anim) {
            row.set_pivot_point(0.5, 0.5);
            row.remove_transition('scale-y');
            row.scale_y = 0.93;
            row.ease({
                scale_y: 1,
                duration: 260,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });

            checkbox.set_pivot_point(0.5, 0.5);
            checkbox.opacity = 110;
            checkbox.ease({
                opacity: 255,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            if (anim === 'toDone') {
                textLabel.opacity = 255;
                textLabel.ease({
                    opacity: 128,
                    duration: 240,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });

                const tick = checkbox.child;
                if (tick) {
                    tick.set_pivot_point(0.5, 0.5);
                    tick.scale_x = 0.3;
                    tick.scale_y = 0.3;
                    tick.ease({
                        scale_x: 1,
                        scale_y: 1,
                        duration: 300,
                        mode: Clutter.AnimationMode.EASE_OUT_BACK,
                    });
                };
            } else {
                textLabel.opacity = 128;
                textLabel.ease({
                    opacity: 255,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            };
        };

        return row;
    }

    function renderTasks() {
        if (isActorDestroyed(body)) return;
        const nextCount = String(tasks.filter(t => !t.done).length);
        if (nextCount !== countLabel.text) {
            countLabel.text = nextCount;
            // Springy pulse so the remaining counter also feels alive.
            countLabel.set_pivot_point(0.5, 0.5);
            countLabel.remove_transition('scale-x');
            countLabel.remove_transition('scale-y');
            countLabel.scale_x = 0.8;
            countLabel.scale_y = 0.8;
            countLabel.ease({
                scale_x: 1,
                scale_y: 1,
                duration: 260,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        };
        taskList.destroy_all_children();
        if (tasks.length === 0) {
            // Vertically center the empty hint inside the right column:
            // equal expanding spacers above and below squeeze the label to
            // the middle of the viewport (a label alone would hug the top).
            taskList.add_child(new St.Widget({
                y_expand: true,
            }));
            taskList.add_child(new St.Label({
                text: _('No tasks yet'),
                x_align: Clutter.ActorAlign.CENTER,
                style: `font-size: ${px(TASK_TEXT_FONT_SIZE)}px; font-weight: 600; color: ${textColor}; opacity: 0.5;`,
            }));
            taskList.add_child(new St.Widget({
                y_expand: true,
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
    attachBounce(addButton);

    // Enter on GNOME 51 may arrive as Clutter.Text 'activate' (see github
    // widget); the key-press fallback remains for other key variants.
    taskEntry.clutter_text.connect('activate', () => commitTask());

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
