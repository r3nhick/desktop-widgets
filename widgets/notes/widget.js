/*
 * Notes widget
 * Adapted for desktop-widgets@r3nhick rendering system
 * Markdown support: bold (**text**), italic (*text*), checkboxes, headers
 */

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Pango from 'gi://Pango';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { getDataDir, isActorDestroyed, loadJsonFromFileAsync, saveJsonToFile, parseCssColor, cssColorToRgba } from '../../utils/ported.js';
import { boxLayoutProps } from '../../utils/gnomeCompat.js';
import { bindHoverShrink } from '../../lib/buttonBounce.js';

export const type = 'notes';
export const label = 'Quick Notes';
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium', 'large', 'portrait', 'mini', 'minilarge'];

const SECONDARY_OPACITY = 0.55;
const MAX_TITLE_LENGTH = 50;

// Default sample shown in fresh notes, and its task-flavored predecessor.
const OLD_NOTE_CONTENT_SAMPLE = '- [ ] Task 1\n- [x] Task 2\n\n**Click edit to start**';
const NOTE_CONTENT_SAMPLE = 'Write anything here — plans, ideas, links.\n\n*Markdown is supported*: **bold**, *italic* and # headers.\n\nClick the edit button (top right) to change this note.';

const MARKDOWN_RULES = [
    [/\*\*(.*?)\*\*/g, '<b>$1</b>'],
    [/\*(.*?)\*/g, '<i>$1</i>'],
    [/^- \[ \]/gm, '☐ '],
    [/^- \[x\]/gm, '☑ '],
    [/^### (.*$)/gm, '<span size="large" weight="bold">$1</span>'],
    [/^## (.*$)/gm, '<span size="x-large" weight="bold">$1</span>'],
    [/^# (.*$)/gm, '<span size="xx-large" weight="bold">$1</span>'],
];

function convertMarkdownToPango(text) {
    if (!text) return '';
    let escaped = GLib.markup_escape_text(text, -1);
    for (const [regex, replacement] of MARKDOWN_RULES) {
        escaped = escaped.replace(regex, replacement);
    }
    // Overlapping markers ("*a **b* c**") produce mis-nested tags; Pango
    // then rejects the whole markup and the note rendered EMPTY. Fall back
    // to the plain (escaped) text in that case.
    try {
        Pango.parse_markup(escaped, -1, '\0');
    } catch (_e) {
        return GLib.markup_escape_text(text, -1);
    }
    return escaped;
}

export function style(theme) {
    return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text};`;
}

export function render({ body, widget, theme, settings }) {
    const textColor = theme.text;
    const dataFilePath = GLib.build_filenamev([getDataDir('notes'), `notes-${widget.id}.json`]);
    
    let titleFontSize = settings?.get_int('notes-title-font-size') ?? 16;
    let contentFontSize = settings?.get_int('notes-content-font-size') ?? 18;
    
    // Controls get a translucent band derived from the text color instead
    // of the shell theme's solid .button / St.Entry fills: those painted dark
    // opaque blocks over the Glass backdrop. Works on Solid cards as well.
    const textRgba = a => cssColorToRgba(textColor, a);
    const titleEntryStyle = () => `color: ${textColor}; font-size: ${titleFontSize}px; font-weight: 600;`
        + ` background-color: ${textRgba(0.08)}; border: none; box-shadow: none;`
        + ` border-radius: ${Math.round(titleFontSize * 0.55)}px; padding: 3px 8px;`;

    let noteTitle = _('Quick Notes');
    let noteContent = _(NOTE_CONTENT_SAMPLE);
    let isEditing = false;
    const state = { saveTimerId: null, settingsHandlers: [] };

    const mainBox = new St.BoxLayout(boxLayoutProps({
        vertical: true,
        x_expand: true,
        y_expand: true,
        style: `padding: 8px;`,
    }));

    // Header with editable title and edit button
    const headerBox = new St.BoxLayout(boxLayoutProps({
        x_expand: true,
        style: 'margin-bottom: 6px;',
    }));

    const titleLabel = new St.Label({
        text: noteTitle,
        style: `color: ${textColor}; font-size: ${titleFontSize}px; font-weight: 600; opacity: ${SECONDARY_OPACITY};`,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
        reactive: true,
    });
    titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

    const titleEntry = new St.Entry({
        text: noteTitle,
        style: titleEntryStyle(),
        x_expand: true,
        can_focus: true,
        hint_text: _('Title...'),
    });
    titleEntry.clutter_text.set_max_length(MAX_TITLE_LENGTH);
    titleEntry.hide();

    const editIcon = new St.Icon({
        icon_name: 'document-edit-symbolic',
        icon_size: 16,
        style: `color: ${textColor}; opacity: 0.6;`,
    });

    const editButton = new St.Button({
        child: editIcon,
        style: `background-color: ${textRgba(0.08)}; border: none; box-shadow: none;`
            + ' border-radius: 9px; padding: 6px 10px; margin-left: 6px;',
        can_focus: true,
        track_hover: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    bindHoverShrink(editButton);

    headerBox.add_child(titleLabel);
    headerBox.add_child(titleEntry);
    headerBox.add_child(editButton);
    mainBox.add_child(headerBox);

    // Scroll view for content (both viewer and editor)
    const scrollView = new St.ScrollView({
        x_expand: true,
        y_expand: true,
    });
    scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.EXTERNAL);

    const scrollContent = new St.BoxLayout(boxLayoutProps({
        vertical: true,
        x_expand: true,
    }));
    scrollView.set_child(scrollContent);
    mainBox.add_child(scrollView);

    // Display container (for view mode with markdown) - inside scroll
    const viewerContainer = new St.BoxLayout(boxLayoutProps({
        style: `color: ${textColor};`,
        x_expand: true,
    }));

    const displayLabel = new Clutter.Text({
        font_name: `${contentFontSize}px`,
        use_markup: true,
        editable: false,
        selectable: true,
        reactive: true,
        line_wrap: true,
        x_expand: true,
    });
    viewerContainer.add_child(displayLabel);

    function makeColor(cssColor, defaultHex) {
        const c = parseCssColor(cssColor || defaultHex);
        const color = new Cogl.Color();
        color.red = Math.round(c.r * 255);
        color.green = Math.round(c.g * 255);
        color.blue = Math.round(c.b * 255);
        color.alpha = Math.round((c.a !== undefined ? c.a : 1) * 255);
        return color;
    }

    const selBg = makeColor(theme.accent, '#3584e4');
    const selText = makeColor(textColor, '#ffffff');
    displayLabel.set_selection_color(selBg);
    displayLabel.set_selected_text_color(selText);

    viewerContainer.connect('style-changed', () => {
        if (isActorDestroyed(body) || !viewerContainer.get_stage()) return;
        displayLabel.set_color(viewerContainer.get_theme_node().get_foreground_color());
    });

    // Editor container (for edit mode)
    const editorContainer = new St.BoxLayout(boxLayoutProps({
        style: `color: ${textColor};`,
        x_expand: true,
    }));

    const textEditor = new Clutter.Text({
        font_name: `${contentFontSize}px`,
        editable: true,
        selectable: true,
        reactive: true,
        line_wrap: true,
        x_expand: true,
    });
    editorContainer.add_child(textEditor);
    textEditor.set_selection_color(selBg);
    textEditor.set_selected_text_color(selText);

    viewerContainer.add_child(displayLabel);

    editorContainer.connect('style-changed', () => {
        if (isActorDestroyed(body) || !editorContainer.get_stage()) return;
        textEditor.set_color(editorContainer.get_theme_node().get_foreground_color());
    });

    // Handle paste events in Clutter.Text
    // Clipboard access: St.Clipboard is the only clipboard API available from
    // the shell side (GTK's clipboard is not exposed here). It is used strictly
    // inside the notes editor for copy/cut/paste of the widget's own content.
    textEditor.connect('button-press-event', (actor, event) => {
        if (event.get_button() === 2) { // Middle mouse button = paste
            const clipboard = St.Clipboard.get_default();
            clipboard.get_text(St.ClipboardType.CLIPBOARD, (clipboard, text) => {
                if (text && isEditing) {
                    const cursorPos = textEditor.get_cursor_position();
                    const currentText = textEditor.get_text();
                    const newText = currentText.slice(0, cursorPos) + text + currentText.slice(cursorPos);
                    textEditor.set_text(newText);
                    textEditor.set_cursor_position(cursorPos + text.length);
                }
            });
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });

    // Handle Ctrl+V paste and Ctrl+C/X copy
    textEditor.connect('key-press-event', (actor, event) => {
        const modifiers = event.get_state();
        const keyval = event.get_key_symbol();
        
        // Ctrl+C
        if ((modifiers & Clutter.ModifierType.CONTROL_MASK) && 
            (keyval === Clutter.KEY_c || keyval === Clutter.KEY_C)) {
            const selText = textEditor.get_selection();
            if (selText) {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, selText);
            }
            return Clutter.EVENT_STOP;
        }

        // Ctrl+X
        if ((modifiers & Clutter.ModifierType.CONTROL_MASK) && 
            (keyval === Clutter.KEY_x || keyval === Clutter.KEY_X)) {
            const selText = textEditor.get_selection();
            if (selText) {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, selText);
                textEditor.delete_selection();
            }
            return Clutter.EVENT_STOP;
        }
        
        // Ctrl+V
        if ((modifiers & Clutter.ModifierType.CONTROL_MASK) && 
            (keyval === Clutter.KEY_v || keyval === Clutter.KEY_V)) {
            const clipboard = St.Clipboard.get_default();
            clipboard.get_text(St.ClipboardType.CLIPBOARD, (clipboard, text) => {
                if (text && isEditing) {
                    textEditor.delete_selection();
                    const cursorPos = textEditor.get_cursor_position();
                    const currentText = textEditor.get_text();
                    const newText = currentText.slice(0, cursorPos) + text + currentText.slice(cursorPos);
                    textEditor.set_text(newText);
                    textEditor.set_cursor_position(cursorPos + text.length);
                }
            });
            return Clutter.EVENT_STOP;
        }

        // Shift+Enter = line break inside the note. Plain Enter commits and
        // closes the editor (the classic path also fires on some shells).
        if (keyval === Clutter.KEY_Return || keyval === Clutter.KEY_KP_Enter) {
            if (modifiers & Clutter.ModifierType.SHIFT_MASK) {
                if (isEditing) {
                    // insert_unichar equals typing the character: the engine
                    // moves the cursor itself and keeps selection bookkeeping
                    // coherent. The previous set_text()+set_cursor_position()
                    // dance left a stale selection bound highlighting chunks
                    // of the note after the break.
                    textEditor.insert_unichar('\n');

                    // The bound follows the insert; collapsing it removes any
                    // stale selection (GNOME 51 has no select_region API).
                    textEditor.set_selection_bound(textEditor.get_cursor_position());
                }
                return Clutter.EVENT_STOP;
            }

            if (isEditing) {
                commitEdit();
            }
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    });

    displayLabel.connect('key-press-event', (actor, event) => {
        const modifiers = event.get_state();
        const keyval = event.get_key_symbol();
        
        // Ctrl+C in viewer mode
        if ((modifiers & Clutter.ModifierType.CONTROL_MASK) && 
            (keyval === Clutter.KEY_c || keyval === Clutter.KEY_C)) {
            const selText = displayLabel.get_selection();
            if (selText) {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, selText);
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });

    // GNOME 51 carries no click-count API on Clutter.Event — a double-click
    // is two quick presses at the same spot.
    const doubleClickListener = () => {
        let lastPress = null;
        return (event) => {
            const [gx, gy] = event.get_coords();
            const now = GLib.get_monotonic_time();
            const near = lastPress !== null && (now - lastPress.time) <= 400000 &&
                Math.abs(gx - lastPress.x) <= 6 && Math.abs(gy - lastPress.y) <= 6;
            lastPress = {time: now, x: gx, y: gy};
            return near;
        };
    };

    // Plain-text actors give a 1:1 index for a click point.
    const plainIndexAt = (actor, event) => {
        try {
            const [gx, gy] = event.get_coords();
            const [ax, ay] = actor.get_transformed_position();
            return actor.clutter_text.coords_to_position(gx - ax, gy - ay);
        } catch (_error) {
            return -1;
        }
    };

    // Double-click on the title edits with the title entry focused and the
    // cursor exactly at the clicked character.
    const titleDouble = doubleClickListener();
    titleLabel.connect('button-press-event', (actor, event) => {
        if (isEditing || event.get_button() !== 1 || !titleDouble(event)) {
            return Clutter.EVENT_PROPAGATE;
        }

        showEditor();

        const raw = titleEntry.get_text() ?? '';
        const idx = plainIndexAt(actor, event);
        if (idx >= 0) {
            const at = Math.min(Math.max(0, idx), raw.length);
            titleEntry.clutter_text.set_cursor_position(at);
            titleEntry.clutter_text.set_selection_bound(at);
            global.stage.set_key_focus(titleEntry.clutter_text);
        }
        return Clutter.EVENT_STOP;
    });

    // Double-click in the viewer is caught at the stage capture phase, so
    // the second press is STOPped before Clutter.Text ever sees it — the
    // built-in double-click word selection cannot race the cursor placement
    // anymore (routing through the actor was flaky: "selects a word every
    // other time").
    const bodyDouble = doubleClickListener();
    global.stage.connectObject('captured-event', (_stage, event) => {
        if (event.type() !== Clutter.EventType.BUTTON_PRESS) {
            return Clutter.EVENT_PROPAGATE;
        }

        const src = event.get_source();
        if (!src || event.get_button() !== 1) {
            return Clutter.EVENT_PROPAGATE;
        }

        // Only presses that land on the viewer text count.
        let a = src;
        while (a && a !== displayLabel) {
            a = a.get_parent();
        }
        if (!a) {
            return Clutter.EVENT_PROPAGATE;
        }

        const dbl = bodyDouble(event);
        if (isEditing || !dbl) {
            return Clutter.EVENT_PROPAGATE;
        }

        showEditor();

        const raw = textEditor.get_text() ?? '';
        const plain = displayLabel.get_text() ?? '';
        if (raw.length > 0 && plain.length > 0) {
            const idx = plainIndexAt(displayLabel, event);
            if (idx >= 0) {
                const at = Math.min(raw.length, Math.round(idx * raw.length / plain.length));
                textEditor.set_cursor_position(at);
                textEditor.set_selection_bound(at);
            }
        }
        // The double-click never reaches the text: no word selection.
        return Clutter.EVENT_STOP;
    }, body);

    scrollContent.add_child(viewerContainer);
    scrollContent.add_child(editorContainer);
    const updateFontSizes = () => {
        const newTitleSize = settings?.get_int('notes-title-font-size') ?? 16;
        const newContentSize = settings?.get_int('notes-content-font-size') ?? 18;
        
        if (newTitleSize !== titleFontSize) {
            titleFontSize = newTitleSize;
            titleLabel.set_style(`color: ${textColor}; font-size: ${titleFontSize}px; font-weight: 600; opacity: ${SECONDARY_OPACITY};`);
            titleEntry.set_style(titleEntryStyle());
        }
        
        if (newContentSize !== contentFontSize) {
            contentFontSize = newContentSize;
            displayLabel.set_font_name(`${contentFontSize}px`);
            textEditor.set_font_name(`${contentFontSize}px`);
        }
    };

    const showViewer = () => {
        if (global.stage.get_key_focus() === textEditor) {
            global.stage.set_key_focus(null);
        }
        if (global.stage.get_key_focus() === titleEntry.clutter_text) {
            global.stage.set_key_focus(null);
        }
        
        titleLabel.set_text(noteTitle);
        titleLabel.show();
        titleEntry.hide();
        
        displayLabel.set_markup(convertMarkdownToPango(noteContent));
        editorContainer.hide();
        viewerContainer.show();
        editIcon.set_icon_name('document-edit-symbolic');
        isEditing = false;
    };

    const showEditor = () => {
        titleEntry.set_text(noteTitle);
        titleLabel.hide();
        titleEntry.show();
        
        textEditor.set_text(noteContent);
        viewerContainer.hide();
        editorContainer.show();
        global.stage.set_key_focus(textEditor);
        editIcon.set_icon_name('object-select-symbolic');
        isEditing = true;
    };

    // Shared finish-editing path: pull both fields, switch back to the viewer
    // and write the file (the edit button, plain Enter in the body and the
    // destroy flush all land here).
    const commitEdit = () => {
        noteTitle = titleEntry.get_text();
        noteContent = textEditor.get_text();
        showViewer();
        saveJsonToFile(dataFilePath, { title: noteTitle, notes: noteContent });
    };

    const scheduleSave = () => {
        if (state.saveTimerId) {
            GLib.source_remove(state.saveTimerId);
        }
        state.saveTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            state.saveTimerId = null;
            saveJsonToFile(dataFilePath, { title: noteTitle, notes: noteContent });
            return GLib.SOURCE_REMOVE;
        });
    };

    textEditor.connect('text-changed', () => {
        if (isEditing) {
            noteContent = textEditor.get_text();
            scheduleSave();
        }
    });

    // Plain Enter on GNOME 51 never reaches key-press handlers of editable
    // text actors — it arrives as the Clutter.Text 'activate' signal (same
    // channel as github/todo). Commit and close the editor from here; the
    // line break itself lives on Shift+Enter (see the key-press handler).
    textEditor.connect('activate', () => {
        if (!isEditing) {
            return;
        };

        commitEdit();
    });

    titleEntry.clutter_text.connect('text-changed', () => {
        if (isEditing) {
            noteTitle = titleEntry.get_text();
            scheduleSave();
        }
    });

    // Plain Enter on GNOME 51 arrives as Clutter.Text 'activate' (proven by
    // the github/todo entries), StEntry keeps no signal of its own. The
    // title commits and the cursor moves into the note body — the natural
    // edit flow; Escape rolls the title back and moves focus down too.
    const commitTitleToBody = () => {
        if (!isEditing) {
            return;
        };

        noteTitle = titleEntry.get_text();
        scheduleSave();
        if (global.stage.get_key_focus() === titleEntry.clutter_text) {
            global.stage.set_key_focus(textEditor);
        }
    };

    titleEntry.clutter_text.connect('activate', () => commitTitleToBody());

    titleEntry.clutter_text.connect('key-press-event', (_actor, event) => {
        const sym = event.get_key_symbol();

        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
            commitTitleToBody();
            return Clutter.EVENT_STOP;
        }

        if (sym === Clutter.KEY_Escape) {
            titleEntry.set_text(noteTitle);
            commitTitleToBody();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    });

    editButton.connect('clicked', () => {
        if (isEditing) {
            commitEdit();
        } else {
            showEditor();
        }
    });

    // Watch for font size changes
    if (settings) {
        const titleHandler = settings.connect('changed::notes-title-font-size', updateFontSizes);
        const contentHandler = settings.connect('changed::notes-content-font-size', updateFontSizes);
        state.settingsHandlers.push(titleHandler, contentHandler);
    }

    // Cleanup on destroy
    body.connect('destroy', () => {
        if (state.saveTimerId) {
            GLib.source_remove(state.saveTimerId);
            state.saveTimerId = null;
        }
        if (settings) {
            for (const handler of state.settingsHandlers) {
                settings.disconnect(handler);
            }
            state.settingsHandlers = [];
        }
        if (isEditing) {
            noteTitle = titleEntry.get_text();
            noteContent = textEditor.get_text();
            saveJsonToFile(dataFilePath, { title: noteTitle, notes: noteContent });
            if (global.stage.get_key_focus() === textEditor) {
                global.stage.set_key_focus(null);
            }
            if (global.stage.get_key_focus() === titleEntry.clutter_text) {
                global.stage.set_key_focus(null);
            }
        }
    });

    // Initial state
    showViewer();
    body.add_child(mainBox);

    // Load saved notes
    loadJsonFromFileAsync(dataFilePath, (savedData, loadError) => {
        if (isActorDestroyed(body)) return;
        if (savedData) {
            if (savedData.title !== undefined) {
                noteTitle = savedData.title;
            }
            if (savedData.notes !== undefined) {
                noteContent = savedData.notes;
                // One-time swap: saved notes that still hold the old
                // task-flavored sample never got edited by the user, so
                // replace that text with the notes-flavored default.
                if (noteContent === _(OLD_NOTE_CONTENT_SAMPLE) || noteContent === OLD_NOTE_CONTENT_SAMPLE) {
                    noteContent = _(NOTE_CONTENT_SAMPLE);
                    saveJsonToFile(dataFilePath, { title: noteTitle, notes: noteContent });
                };
            }
            if (!isEditing) {
                showViewer();
            }
        } else if (!loadError) {
            saveJsonToFile(dataFilePath, { title: noteTitle, notes: noteContent });
        }
    });
}
