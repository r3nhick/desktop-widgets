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
import { getDataDir, isActorDestroyed, loadJsonFromFileAsync, saveJsonToFile, parseCssColor } from '../../utils/ported.js';

export const type = 'notes';
export const label = 'Quick Notes';
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium', 'large', 'portrait', 'mini', 'minilarge'];

const SECONDARY_OPACITY = 0.55;
const MAX_TITLE_LENGTH = 50;

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
    
    let noteTitle = _('Quick Notes');
    let noteContent = _('- [ ] Task 1\n- [x] Task 2\n\n**Click edit to start**');
    let isEditing = false;
    const state = { saveTimerId: null, settingsHandlers: [] };

    const mainBox = new St.BoxLayout({
        vertical: true,
        x_expand: true,
        y_expand: true,
        style: `padding: 8px;`,
    });

    // Header with editable title and edit button
    const headerBox = new St.BoxLayout({
        x_expand: true,
        style: 'margin-bottom: 6px;',
    });

    const titleLabel = new St.Label({
        text: noteTitle,
        style: `color: ${textColor}; font-size: ${titleFontSize}px; font-weight: 600; opacity: ${SECONDARY_OPACITY};`,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

    const titleEntry = new St.Entry({
        text: noteTitle,
        style: `color: ${textColor}; font-size: ${titleFontSize}px; font-weight: 600;`,
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
        style_class: 'button',
        can_focus: true,
        track_hover: true,
        y_align: Clutter.ActorAlign.CENTER,
    });

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

    const scrollContent = new St.BoxLayout({
        vertical: true,
        x_expand: true,
    });
    scrollView.set_child(scrollContent);
    mainBox.add_child(scrollView);

    // Display container (for view mode with markdown) - inside scroll
    const viewerContainer = new St.BoxLayout({
        style: `color: ${textColor};`,
        x_expand: true,
    });

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
    const editorContainer = new St.BoxLayout({
        style: `color: ${textColor};`,
        x_expand: true,
    });

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

    scrollContent.add_child(viewerContainer);
    scrollContent.add_child(editorContainer);

    const updateFontSizes = () => {
        const newTitleSize = settings?.get_int('notes-title-font-size') ?? 16;
        const newContentSize = settings?.get_int('notes-content-font-size') ?? 18;
        
        if (newTitleSize !== titleFontSize) {
            titleFontSize = newTitleSize;
            titleLabel.set_style(`color: ${textColor}; font-size: ${titleFontSize}px; font-weight: 600; opacity: ${SECONDARY_OPACITY};`);
            titleEntry.set_style(`color: ${textColor}; font-size: ${titleFontSize}px; font-weight: 600;`);
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

    titleEntry.clutter_text.connect('text-changed', () => {
        if (isEditing) {
            noteTitle = titleEntry.get_text();
            scheduleSave();
        }
    });

    editButton.connect('clicked', () => {
        if (isEditing) {
            noteTitle = titleEntry.get_text();
            noteContent = textEditor.get_text();
            showViewer();
            saveJsonToFile(dataFilePath, { title: noteTitle, notes: noteContent });
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
            }
            if (!isEditing) {
                showViewer();
            }
        } else if (!loadError) {
            saveJsonToFile(dataFilePath, { title: noteTitle, notes: noteContent });
        }
    });
}
