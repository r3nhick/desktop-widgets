'use strict';

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';

import {ExtensionPreferences, gettext as _}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const WIDGET_TYPES = [
    {type: 'clock', label: 'Clock'},
    {type: 'digitalclock', label: 'Digital Clock'},
    {type: 'binaryclock', label: 'Binary Clock'},
    {type: 'calendar', label: 'Calendar'},
    {type: 'weather', label: 'Weather'},
    {type: 'photos', label: 'Photos'},
    {type: 'battery', label: 'Battery'},
    {type: 'music', label: 'Music'},
];

const DEFAULT_SIZES = {
    clock: 'small',
    digitalclock: 'small',
    binaryclock: 'medium',
    calendar: 'small',
    weather: 'small',
    photos: 'medium',
    battery: 'medium',
    music: 'medium',
};

const PHOTO_SIZES = ['cover', 'contain', 'fill', 'small'];
const PHOTO_SIZE_LABELS = ['Cover', 'Contain', 'Stretch', 'Small'];

const BATTERY_ICON_SIZES = ['small', 'medium', 'large'];
const BATTERY_ICON_SIZE_LABELS = ['Small', 'Medium', 'Large'];

const MUSIC_GIFS = ['pushy.gif', 'pushy2.gif', 'pushy3.gif', 'pushy4.gif', 'pushy5.gif'];

function layoutWidgets(settings) {
    try {
        const value = JSON.parse(settings.get_string('layout-json') || '');
        return Array.isArray(value?.widgets) ? value.widgets : [];
    } catch (_error) {
        return [];
    };
};

const SHADOW_COLOR_RE = /((?:rgba?|hsla?)\([^)]*\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\s*$/;
const DEFAULT_SHADOW_COLOR = 'rgba(0, 0, 0, 0.26)';

function shadowColorFrom(shadowCss) {
    const css = String(shadowCss || '').trim();

    if (!css) {
        return DEFAULT_SHADOW_COLOR;
    };

    const match = css.match(SHADOW_COLOR_RE);

    return match ? match[1] : DEFAULT_SHADOW_COLOR;
};

function composeShadow(colorStr, sizePx) {
    return `0 8px ${sizePx}px ${colorStr}`;
};

function photoSizeIndex(value) {
    const index = PHOTO_SIZES.indexOf(String(value || 'cover'));
    return index >= 0 ? index : 0;
};

function batteryIconSizeIndex(value) {
    const index = BATTERY_ICON_SIZES.indexOf(String(value || 'medium'));
    return index >= 0 ? index : 1;
};

function keyvalIsForbidden(keyval) {
    return [
        Gdk.KEY_Home, Gdk.KEY_Left, Gdk.KEY_Up, Gdk.KEY_Right, Gdk.KEY_Down,
        Gdk.KEY_Page_Up, Gdk.KEY_Page_Down, Gdk.KEY_End, Gdk.KEY_Tab,
        Gdk.KEY_KP_Enter, Gdk.KEY_Return, Gdk.KEY_Mode_switch,
    ].includes(keyval);
};

function isValidBinding(mask, keycode, keyval) {
    return !(mask === 0 || mask === Gdk.ModifierType.SHIFT_MASK && keycode !== 0 &&
        ((keyval >= Gdk.KEY_a && keyval <= Gdk.KEY_z) ||
        (keyval >= Gdk.KEY_A && keyval <= Gdk.KEY_Z) ||
        (keyval >= Gdk.KEY_0 && keyval <= Gdk.KEY_9) ||
        (keyval >= Gdk.KEY_kana_fullstop && keyval <= Gdk.KEY_semivoicedsound) ||
        (keyval >= Gdk.KEY_Arabic_comma && keyval <= Gdk.KEY_Arabic_sukun) ||
        (keyval >= Gdk.KEY_Serbian_dje && keyval <= Gdk.KEY_Cyrillic_HARDSIGN) ||
        (keyval >= Gdk.KEY_Greek_ALPHAaccent && keyval <= Gdk.KEY_Greek_omega) ||
        (keyval >= Gdk.KEY_hebrew_doublelowline && keyval <= Gdk.KEY_hebrew_taf) ||
        (keyval >= Gdk.KEY_Thai_kokai && keyval <= Gdk.KEY_Thai_lekkao) ||
        (keyval >= Gdk.KEY_Hangul_Kiyeog && keyval <= Gdk.KEY_Hangul_J_YeorinHieuh) ||
        (keyval === Gdk.KEY_space && mask === 0) || keyvalIsForbidden(keyval)));
};

function isValidAccel(mask, keyval) {
    return Gtk.accelerator_valid(keyval, mask) || (keyval === Gdk.KEY_Tab && mask !== 0);
};

export default class WidgetsPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;
        this._pages = [];

        window.set_default_size(900, 700);
        window.set_title(_('Desktop Widgets'));
        window.set_search_enabled(false);

        const settings = this.getSettings();

        this._switchToSidebar(window);

        // General page
        const generalPage = new Adw.PreferencesPage();
        generalPage.set_title(_('General'));
        generalPage.set_icon_name('preferences-desktop-symbolic');
        this._buildGeneralPage(generalPage, settings);
        this._addSidebarPage(generalPage);

        // Photos page
        const photosPage = this._createPhotosPage(settings);
        photosPage.set_title(_('Photos Widget'));
        photosPage.set_icon_name('image-x-generic-symbolic');
        this._addSidebarPage(photosPage);

        // Battery page
        const batteryPage = this._createBatteryPage(settings);
        batteryPage.set_title(_('Battery Widget'));
        batteryPage.set_icon_name('battery-symbolic');
        this._addSidebarPage(batteryPage);

        // Music page
        const musicPage = this._createMusicPage(settings);
        musicPage.set_title(_('Music Widget'));
        musicPage.set_icon_name('audio-x-generic-symbolic');
        this._addSidebarPage(musicPage);

        // Calendar page
        const calendarPage = this._createCalendarPage(settings);
        calendarPage.set_title(_('Calendar Widget'));
        calendarPage.set_icon_name('x-office-calendar-symbolic');
        this._addSidebarPage(calendarPage);

        // Digital Clock page
        const digitalClockPage = this._createDigitalClockPage(settings);
        digitalClockPage.set_title(_('Digital Clock Widget'));
        digitalClockPage.set_icon_name('appointment-new-symbolic');
        this._addSidebarPage(digitalClockPage);

        // Appearance page
        const appearancePage = this._createAppearancePage(settings);
        appearancePage.set_title(_('Appearance'));
        appearancePage.set_icon_name('preferences-color-symbolic');
        this._addSidebarPage(appearancePage);

        // Handle window close
        window.connect('close-request', () => {
            for (const page of this._pages)
                page?.destroy?.();

            this._pages = [];
            return false;
        });
    }

    _switchToSidebar(window) {
        // Add dummy Adw.PreferencesPage to avoid logs spamming
        const dummyPrefsPage = new Adw.PreferencesPage();
        window.add(dummyPrefsPage);

        const splitView = new Adw.NavigationSplitView({
            hexpand: true,
            vexpand: true,
            sidebar_width_fraction: 0.277,
        });
        const breakpointBin = new Adw.BreakpointBin({
            width_request: 100,
            height_request: 100,
        });
        const breakpoint = new Adw.Breakpoint();
        breakpoint.set_condition(Adw.BreakpointCondition.parse('max-width: 565px'));
        breakpoint.add_setter(splitView, 'collapsed', true);
        breakpointBin.add_breakpoint(breakpoint);
        breakpointBin.set_child(splitView);
        window.set_content(breakpointBin);

        const splitViewSidebar = new Adw.NavigationPage({
            title: _('Desktop Widgets'),
        });
        const sidebarToolbar = new Adw.ToolbarView();
        const sidebarHeader = new Adw.HeaderBar();
        const sidebarBin = new Adw.Bin();
        this._sidebarListBox = new Gtk.ListBox();
        this._sidebarListBox.add_css_class('navigation-sidebar');
        sidebarBin.set_child(this._sidebarListBox);
        sidebarToolbar.set_content(sidebarBin);
        sidebarToolbar.add_top_bar(sidebarHeader);
        splitViewSidebar.set_child(sidebarToolbar);
        splitView.set_sidebar(splitViewSidebar);

        const splitViewContent = new Adw.NavigationPage();
        this._contentToolbar = new Adw.ToolbarView();
        this._contentHeader = new Adw.HeaderBar();
        this._stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.NONE,
        });
        this._contentToolbar.set_content(this._stack);
        this._contentToolbar.add_top_bar(this._contentHeader);
        splitViewContent.set_child(this._contentToolbar);
        splitView.set_content(splitViewContent);

        this._splitView = splitView;
        this._splitViewContent = splitViewContent;
        this._firstPageAdded = false;

        this._sidebarListBox.connect('row-activated', (_listBox, row) => {
            splitView.set_show_content(true);
            splitViewContent.set_title(row._title);
            this._stack.set_visible_child_name(row._id);
        });
    }

    _addSidebarPage(page) {
        const row = new Gtk.ListBoxRow();
        row._title = page.get_title();
        row._id = row._title.toLowerCase().replace(/\s+/g, '-');

        const rowIcon = new Gtk.Image({
            icon_name: page.get_icon_name(),
        });
        const rowLabel = new Gtk.Label({
            label: row._title,
            xalign: 0,
        });
        const box = new Gtk.Box({
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 6,
            margin_end: 6,
        });
        box.append(rowIcon);
        box.append(rowLabel);
        row.set_child(box);
        row.set_activatable(true);

        this._stack.add_named(page, row._id);
        this._sidebarListBox.append(row);

        if (!this._firstPageAdded) {
            this._splitViewContent.set_title(row._title);
            this._firstPageAdded = true;
        }

        this._pages.push(page);
    }


    _buildGeneralPage(page, settings) {
        const widgetsGroup = new Adw.PreferencesGroup({
            title: _('Widgets'),
            description: _('Configure desktop widgets. Changes apply immediately.'),
            margin_top: 12,
        });

        const editModeRow = new Adw.SwitchRow({
            title: _('Edit mode'),
            subtitle: _('Enable to move and remove widgets on the desktop'),
        });
        editModeRow.set_active(settings.get_boolean('edit-mode'));
        settings.bind('edit-mode', editModeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        widgetsGroup.add(editModeRow);

        const deleteShortcutButton = new Gtk.Button({
            icon_name: 'edit-delete-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['error'],
            hexpand: false,
            vexpand: false,
        });

        const shortcutGroup = new Adw.PreferencesGroup({
            title: _('Edit Mode Shortcut'),
            header_suffix: deleteShortcutButton,
        });

        const shortcutRow = this._createShortcutRow(settings);
        shortcutGroup.add(shortcutRow);
        page.add(shortcutGroup);

        const updateDeleteVisibility = () => {
            deleteShortcutButton.visible =
                Boolean(settings.get_strv('edit-mode-binding').length);
        };
        updateDeleteVisibility();

        deleteShortcutButton.connect('clicked', () => {
            settings.set_strv('edit-mode-binding', []);
        });
        settings.connect('changed::edit-mode-binding', () => updateDeleteVisibility());

        page.add(widgetsGroup);

        // Add widget group
        const addGroup = new Adw.PreferencesGroup({
            title: _('Add Widget'),
            description: _('Add a new widget to your desktop.'),
            margin_top: 12,
        });

        const addRow = new Adw.ActionRow({
            title: _('Select widget to add'),
        });

        const widgetTypesModel = Gtk.StringList.new(WIDGET_TYPES.map(w => _(w.label)));
        const addCombo = new Gtk.DropDown({
            model: widgetTypesModel,
            valign: Gtk.Align.CENTER,
            margin_end: 12,
        });

        const addButton = new Gtk.Button({
            label: _('Add'),
            css_classes: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });

        addButton.connect('clicked', () => {
            const type = WIDGET_TYPES[addCombo.get_selected()].type;
            this._addWidget(settings, type);
        });

        const addBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
        });
        addBox.append(addCombo);
        addBox.append(addButton);

        addRow.add_suffix(addBox);
        addGroup.add(addRow);

        const resetRow = new Adw.ActionRow({
            title: _('Reset default widgets'),
            subtitle: _('Restore the default widget layout'),
            activatable: true,
        });
        resetRow.connect('activated', () => {
            settings.set_string('layout-json', '');
        });
        addGroup.add(resetRow);

        const arrangeRow = new Adw.ActionRow({
            title: _('Arrange widgets'),
            subtitle: _('Align all widgets into a grid of columns and rows'),
            activatable: true,
        });
        arrangeRow.connect('activated', () => {
            settings.set_boolean('arrange-widgets', true);
        });
        addGroup.add(arrangeRow);

        const exportRow = new Adw.ActionRow({
            title: _('Export layout'),
            subtitle: _('Save the current widget layout to a JSON file'),
            activatable: true,
        });
        exportRow.connect('activated', () => {
            this._exportLayout(settings);
        });
        addGroup.add(exportRow);

        const importRow = new Adw.ActionRow({
            title: _('Import layout'),
            subtitle: _('Load a widget layout from a JSON file'),
            activatable: true,
        });
        importRow.connect('activated', () => {
            this._importLayout(settings);
        });
        addGroup.add(importRow);

        page.add(addGroup);

        // Saved layouts group
        const savedGroup = new Adw.PreferencesGroup({
            title: _('Saved Layouts'),
            description: _('Save the current widget positions under a name and restore them later.'),
            margin_top: 12,
        });

        const nameRow = new Adw.EntryRow({title: _('Preset name')});
        const saveButton = new Gtk.Button({
            label: _('Save layout'),
            css_classes: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        nameRow.add_suffix(saveButton);
        savedGroup.add(nameRow);
        nameRow.connect('entry-activated', () => {
            this._savePreset(settings, nameRow.get_text());
        });
        saveButton.connect('clicked', () => {
            this._savePreset(settings, nameRow.get_text());
        });

        let presetListModel = Gtk.StringList.new([]);
        const presetCombo = new Adw.ComboRow({
            title: _('Saved presets'),
            subtitle: _('Pick a saved layout to restore or delete'),
            model: presetListModel,
        });
        savedGroup.add(presetCombo);

        const restoreButton = new Gtk.Button({label: _('Restore')});
        const deleteButton = new Gtk.Button({
            label: _('Delete'),
            css_classes: ['error'],
        });
        const actionBox = new Gtk.Box({
            spacing: 6,
            halign: Gtk.Align.END,
            margin_top: 6,
            margin_bottom: 6,
        });
        actionBox.append(restoreButton);
        actionBox.append(deleteButton);
        const actionRow = new Adw.ActionRow({
            title: _('Restore or delete the selected preset'),
            activatable_widget: restoreButton,
        });
        actionRow.add_suffix(actionBox);
        savedGroup.add(actionRow);

        this._refreshPresetList = () => {
            const names = this._presetNames();
            const hasPresets = names.length > 0;

            presetListModel = Gtk.StringList.new(names);
            presetCombo.set_model(presetListModel);
            presetCombo.selected = hasPresets ? 0 : Gtk.INVALID_LIST_POSITION;
            presetCombo.sensitive = hasPresets;
            restoreButton.sensitive = hasPresets;
            deleteButton.sensitive = hasPresets;
        };

        restoreButton.connect('clicked', () => {
            const name = presetCombo.get_selected_item()?.get_string();
            if (name) {
                this._restorePreset(settings, name);
            };
        });
        deleteButton.connect('clicked', () => {
            const name = presetCombo.get_selected_item()?.get_string();
            if (name) {
                this._deletePreset(name);
            };
        });

        this._refreshPresetList();

        page.add(savedGroup);
    }

    _exportLayout(settings) {
        const chooser = new Gtk.FileChooserNative({
            title: _('Export layout'),
            action: Gtk.FileChooserAction.SAVE,
            transient_for: this._window,
            accept_label: _('Export'),
            cancel_label: _('Cancel'),
        });
        chooser.set_current_name('desktop-widgets-layout.json');

        chooser.connect('response', (_dialog, response) => {
            if (response !== Gtk.ResponseType.ACCEPT) {
                return;
            };

            const path = chooser.get_file().get_path();

            try {
                GLib.file_set_contents(path, settings.get_string('layout-json'));
            } catch (error) {
                this._showError(_('Could not export the layout'), error.message);
            };
        });

        chooser.show();
    }

    _importLayout(settings) {
        const chooser = new Gtk.FileChooserNative({
            title: _('Import layout'),
            action: Gtk.FileChooserAction.OPEN,
            transient_for: this._window,
            accept_label: _('Import'),
            cancel_label: _('Cancel'),
        });

        chooser.connect('response', (_dialog, response) => {
            if (response !== Gtk.ResponseType.ACCEPT) {
                return;
            };

            const path = chooser.get_file().get_path();

            try {
                const [ok, bytes] = GLib.file_get_contents(path);

                if (!ok) {
                    throw new Error(_('Could not read the file'));
                };

                const content = new TextDecoder().decode(bytes);
                const layout = JSON.parse(content);

                if (!Array.isArray(layout?.widgets)) {
                    throw new Error(_('This file is not a valid layout'));
                };

                const types = new Set(WIDGET_TYPES.map(w => w.type));

                for (const widget of layout.widgets) {
                    if (!types.has(widget.type)) {
                        throw new Error(_('Unknown widget type') + `: ${widget.type}`);
                    };
                };

                settings.set_string('layout-json', JSON.stringify({widgets: layout.widgets}));
            } catch (error) {
                this._showError(_('Could not import the layout'), error.message);
            };
        });

        chooser.show();
    }

    _layoutsDir() {
        const dir = this.dir.get_child('layouts');

        if (!dir.query_exists(null)) {
            GLib.mkdir_with_parents(dir.get_path(), 0o755);
        };

        return dir;
    }

    _presetNames() {
        const names = [];
        const dir = this.dir.get_child('layouts');

        if (!dir.query_exists(null)) {
            return names;
        };

        const enumerator = dir.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;

        while ((info = enumerator.next_file(null))) {
            const fileName = info.get_name();

            if (fileName.endsWith('.json')) {
                names.push(fileName.slice(0, -'.json'.length));
            };
        };

        return names.sort();
    }

    _sanitizePresetName(name) {
        return String(name ?? '')
            .trim()
            .replace(/[^a-zA-Z0-9 _-]/g, '_');
    }

    _savePreset(settings, rawName) {
        const name = this._sanitizePresetName(rawName);

        if (!name) {
            return;
        };

        const file = this._layoutsDir().get_child(`${name}.json`);

        if (file.query_exists(null)) {
            const alert = new Gtk.AlertDialog({
                message: _('Overwrite existing layout?'),
                detail: name,
                buttons: [_('Cancel'), _('Overwrite')],
                default_button: 1,
                cancel_button: 0,
            });

            alert.choose(this._window, null, (_dialog, result) => {
                try {
                    if (alert.choose_finish(result) === 1) {
                        this._writePreset(file, settings);
                    };
                } catch (error) {
                    // Dialog dismissed without a selection
                };
            });
        } else {
            this._writePreset(file, settings);
        };
    }

    _writePreset(file, settings) {
        try {
            const [success] = file.replace_contents(
                new TextEncoder().encode(settings.get_string('layout-json')),
                null,
                false,
                Gio.FileCreateFlags.NONE,
                null
            );

            if (!success) {
                throw new Error(_('Could not write the file'));
            };

            this._refreshPresetList?.();
        } catch (error) {
            this._showError(_('Could not save the layout'), error.message);
        };
    }

    _restorePreset(settings, name) {
        const file = this._layoutsDir().get_child(`${name}.json`);

        try {
            const [ok, bytes] = GLib.file_get_contents(file.get_path());

            if (!ok) {
                throw new Error(_('Could not read the file'));
            };

            const content = new TextDecoder().decode(bytes);
            const parsed = JSON.parse(content);

            if (!parsed || !Array.isArray(parsed.widgets)) {
                throw new Error(_('Not a valid widget layout'));
            };

            settings.set_string('layout-json', content);
            this._refreshPresetList?.();
        } catch (error) {
            this._showError(_('Could not restore the layout'), error.message);
        };
    }

    _deletePreset(name) {
        const file = this._layoutsDir().get_child(`${name}.json`);
        const alert = new Gtk.AlertDialog({
            message: _('Delete saved layout?'),
            detail: name,
            buttons: [_('Cancel'), _('Delete')],
            default_button: 1,
            cancel_button: 0,
        });

        alert.choose(this._window, null, (_dialog, result) => {
            try {
                if (alert.choose_finish(result) !== 1) {
                    return;
                };

                file.delete(null);
                this._refreshPresetList?.();
            } catch (error) {
                this._showError(_('Could not delete the layout'), error.message);
            };
        });
    }

    _showError(title, detail) {
        const alert = new Gtk.AlertDialog({
            message: title,
            detail: String(detail || ''),
            buttons: [_('Close')],
        });
        alert.show(this._window);
    }

    _createShortcutRow(settings) {
        const row = new Adw.ActionRow({
            title: _('Edit Mode Shortcut'),
            subtitle: _('Global shortcut to toggle edit mode. Press Backspace to clear.'),
            activatable: true,
        });

        const shortLabel = new Gtk.ShortcutLabel({
            disabled_text: _('New accelerator…'),
            valign: Gtk.Align.CENTER,
            hexpand: false,
            vexpand: false,
        });

        const suffix = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            halign: Gtk.Align.CENTER,
            spacing: 5,
            hexpand: false,
            vexpand: false,
        });
        suffix.append(shortLabel);
        row.add_suffix(suffix);

        const updateLabel = () => {
            shortLabel.set_accelerator(settings.get_strv('edit-mode-binding')[0] || '');
        };
        updateLabel();

        let editor = null;

        row.connect('activated', () => {
            const ctl = new Gtk.EventControllerKey();

            const content = new Adw.StatusPage({
                title: _('New accelerator…'),
                description: _('Type the shortcut to toggle edit mode. Press Backspace to clear.'),
                icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            });

            editor = new Adw.Window({
                modal: true,
                hide_on_close: true,
                transient_for: row.get_root(),
                width_request: 480,
                height_request: 320,
                content,
            });

            editor.add_controller(ctl);
            ctl.connect('key-pressed', (_ctl, keyval, keycode, state) => {
                let mask = state & Gtk.accelerator_get_default_mod_mask();
                mask &= ~Gdk.ModifierType.LOCK_MASK;

                if (!mask && keyval === Gdk.KEY_Escape) {
                    editor.close();
                    return Gdk.EVENT_STOP;
                }

                if (keyval === Gdk.KEY_BackSpace) {
                    settings.set_strv('edit-mode-binding', []);
                    editor.close();
                    updateLabel();
                    return Gdk.EVENT_STOP;
                }

                if (!isValidBinding(mask, keycode, keyval) || !isValidAccel(mask, keyval)) {
                    return Gdk.EVENT_STOP;
                }

                const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
                settings.set_strv('edit-mode-binding', [accel]);
                editor.close();
                updateLabel();
                return Gdk.EVENT_STOP;
            });

            editor.present();
        });

        settings.connect('changed::edit-mode-binding', () => updateLabel());

        return row;
    }

    _createPhotosPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Photos Widget'),
            description: _('Configure how your pictures are scaled and cropped inside the Photos widget bounds.'),
            margin_top: 12,
        });

        const photoSizeModel = Gtk.StringList.new(PHOTO_SIZE_LABELS);
        const photoSizeRow = new Adw.ComboRow({
            title: _('Photo size'),
            subtitle: _('How the photo fits the widget bounds'),
            model: photoSizeModel,
        });
        photoSizeRow.set_selected(photoSizeIndex(settings.get_string('photo-size')));
        photoSizeRow.connect('notify::selected', () => {
            settings.set_string('photo-size', PHOTO_SIZES[photoSizeRow.selected] ?? 'cover');
        });
        group.add(photoSizeRow);

        page.add(group);
        return page;
    }

    _createBatteryPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Battery Widget'),
            description: _('Adjust the visual size of the device indicators displayed inside the battery charge rings.'),
            margin_top: 12,
        });

        const iconSizeModel = Gtk.StringList.new(BATTERY_ICON_SIZE_LABELS);
        const iconSizeRow = new Adw.ComboRow({
            title: _('Battery icon size'),
            subtitle: _('How large the device icon is inside the charging ring'),
            model: iconSizeModel,
        });
        iconSizeRow.set_selected(batteryIconSizeIndex(settings.get_string('battery-icon-size')));
        iconSizeRow.connect('notify::selected', () => {
            settings.set_string('battery-icon-size', BATTERY_ICON_SIZES[iconSizeRow.selected] ?? 'medium');
        });
        group.add(iconSizeRow);

        const slotCountRow = new Adw.SpinRow({
            title: _('Battery slot count'),
            subtitle: _('Maximum number of devices shown'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 8,
                step_increment: 1,
                page_increment: 1,
            }),
        });
        slotCountRow.set_value(settings.get_int('battery-slot-count'));
        slotCountRow.connect('notify::value', () => {
            settings.set_int('battery-slot-count', Math.round(slotCountRow.get_value()));
        });
        group.add(slotCountRow);

        const showPercentRow = new Adw.SwitchRow({
            title: _('Show battery percentage'),
            subtitle: _('Display the charge percentage below each ring'),
        });
        showPercentRow.set_active(settings.get_boolean('battery-show-percent'));
        group.add(showPercentRow);
        showPercentRow.connect('notify::active', () => {
            settings.set_boolean('battery-show-percent', showPercentRow.get_active());
        });

        page.add(group);
        return page;
    }

    _createMusicPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Music Widget'),
            description: _('Preferences for the media player widget on your desktop.'),
            margin_top: 12,
        });

        const ignoreBrowsersRow = new Adw.SwitchRow({
            title: _('Ignore Web Browsers'),
            subtitle: _('Prevent browsers (Chrome, Firefox, etc.) from taking over the music widget.'),
        });
        ignoreBrowsersRow.set_active(settings.get_boolean('music-ignore-browsers'));
        settings.bind('music-ignore-browsers', ignoreBrowsersRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(ignoreBrowsersRow);

        const gifModel = Gtk.StringList.new(MUSIC_GIFS);
        const gifRow = new Adw.ComboRow({
            title: _('Empty state GIF'),
            subtitle: _('Animation shown when no track is playing'),
            model: gifModel,
        });
        const gifIndex = Math.max(0, MUSIC_GIFS.indexOf(settings.get_string('music-empty-gif')));
        gifRow.set_selected(MUSIC_GIFS.indexOf(settings.get_string('music-empty-gif')) >= 0
            ? gifIndex
            : 0);
        gifRow.connect('notify::selected', () => {
            settings.set_string('music-empty-gif', MUSIC_GIFS[gifRow.selected] ?? 'pushy.gif');
        });
        group.add(gifRow);

        page.add(group);
        return page;
    }

    _createCalendarPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Calendar Widget'),
            description: _('Preferences for the date widget on your desktop.'),
            margin_top: 12,
        });

        const WEEKDAY_LABELS = [_('Two letters (Mo Tu We)'), _('Single letter (M T W)')];
        const WEEKDAY_VALUES = ['short', 'narrow'];
        const weekdayModel = Gtk.StringList.new(WEEKDAY_LABELS);
        const weekdayRow = new Adw.ComboRow({
            title: _('Weekday format'),
            subtitle: _('How weekday labels appear in the calendar header'),
            model: weekdayModel,
        });
        weekdayRow.set_selected(Math.max(0, WEEKDAY_VALUES.indexOf(settings.get_string('calendar-weekday-format'))));
        weekdayRow.connect('notify::selected', () => {
            settings.set_string('calendar-weekday-format', WEEKDAY_VALUES[weekdayRow.selected] ?? 'short');
        });
        group.add(weekdayRow);

        page.add(group);
        return page;
    }

    _createDigitalClockPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Digital Clock Widget'),
            description: _('Appearance of the clock on your desktop.'),
            margin_top: 12,
        });

        const FORMAT_LABELS = [_('12-hour'), _('24-hour')];
        const FORMAT_VALUES = ['12', '24'];
        const formatModel = Gtk.StringList.new(FORMAT_LABELS);
        const formatRow = new Adw.ComboRow({
            title: _('Time format'),
            subtitle: _('How the clock shows the hour'),
            model: formatModel,
        });
        formatRow.set_selected(Math.max(0, FORMAT_VALUES.indexOf(settings.get_string('digitalclock-hour-format'))));
        formatRow.connect('notify::selected', () => {
            settings.set_string('digitalclock-hour-format', FORMAT_VALUES[formatRow.selected] ?? '24');
        });
        group.add(formatRow);

        const showSecondsRow = new Adw.SwitchRow({
            title: _('Show seconds'),
            subtitle: _('Only available in the 2×1 and 2×1 mini sizes'),
        });
        showSecondsRow.set_active(settings.get_boolean('digitalclock-show-seconds'));
        group.add(showSecondsRow);
        showSecondsRow.connect('notify::active', () => {
            settings.set_boolean('digitalclock-show-seconds', showSecondsRow.get_active());
        });

        const showAmPmRow = new Adw.SwitchRow({
            title: _('Show AM/PM'),
            subtitle: _('Available with the 12-hour format'),
        });
        showAmPmRow.set_active(settings.get_boolean('digitalclock-show-ampm'));
        group.add(showAmPmRow);
        showAmPmRow.connect('notify::active', () => {
            settings.set_boolean('digitalclock-show-ampm', showAmPmRow.get_active());
        });

        page.add(group);
        return page;
    }

    _createAppearancePage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Widget Styling'),
            description: _('Customize the appearance of all widgets.'),
            margin_top: 12,
        });

        // Border Radius
        const radiusRow = new Adw.SpinRow({
            title: _('Border Radius'),
            subtitle: _('Corner roundness of widgets'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 50,
                step_increment: 1,
                page_increment: 1,
            }),
        });
        radiusRow.set_value(settings.get_int('style-border-radius'));
        radiusRow.connect('notify::value', () => {
            this._debounce('style-border-radius', () => {
                settings.set_int('style-border-radius', radiusRow.get_value());
            }, 150);
        });
        group.add(radiusRow);

        // Border Width
        const borderWidthRow = new Adw.SpinRow({
            title: _('Border Width'),
            subtitle: _('Thickness of widget borders'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 10,
                step_increment: 1,
                page_increment: 1,
            }),
        });
        borderWidthRow.set_value(settings.get_int('style-border-width'));
        borderWidthRow.connect('notify::value', () => {
            this._debounce('style-border-width', () => {
                settings.set_int('style-border-width', borderWidthRow.get_value());
            }, 150);
        });
        group.add(borderWidthRow);

        // Background Color
        const bgColorRow = this._createColorRow(
            _('Background Color'),
            _('Choose background color'),
            settings,
            'style-background',
            '#242424' // fallback for dark theme
        );
        group.add(bgColorRow);

        // Border Color
        const borderColorRow = this._createColorRow(
            _('Border Color'),
            _('Choose border color'),
            settings,
            'style-border-color',
            '#3d3d3d' // fallback for light theme
        );
        group.add(borderColorRow);

        // Shadow
        const shadowRow = new Adw.ActionRow({
            title: _('Box Shadow'),
            subtitle: _('Choose shadow color. Leave unset for default.'),
        });

        const shadowSizeRow = new Adw.SpinRow({
            title: _('Shadow Size'),
            subtitle: _('Blur radius of the shadow'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 1,
                page_increment: 1,
            }),
        });
        shadowSizeRow.set_value(settings.get_int('style-shadow-size'));
        shadowSizeRow.connect('notify::value', () => {
            this._debounce('style-shadow-size', () => {
                const size = Math.round(shadowSizeRow.get_value());
                settings.set_int('style-shadow-size', size);
                if (settings.get_string('style-shadow')) {
                    settings.set_string('style-shadow',
                        composeShadow(shadowColorButton.get_rgba().to_string(), size));
                }
            }, 150);
        });
        group.add(shadowSizeRow);

        const shadowColorButton = this._createColorButton(
            shadowColorFrom(settings.get_string('style-shadow')),
            DEFAULT_SHADOW_COLOR,
            color => {
                settings.set_string('style-shadow',
                    composeShadow(color.to_string(), Math.round(shadowSizeRow.get_value())));
            }
        );

        shadowRow.add_suffix(shadowColorButton);
        shadowRow._colorButton = shadowColorButton;
        shadowRow._fallbackColor = DEFAULT_SHADOW_COLOR;
        group.add(shadowRow);

        // Widget opacity
        const opacityRow = new Adw.ActionRow({
            title: _('Widget opacity'),
            subtitle: _('Transparency of all desktop widgets'),
        });
        const opacityAdjustment = new Gtk.Adjustment({
            lower: 0.1,
            upper: 1.0,
            step_increment: 0.05,
            page_increment: 0.1,
        });
        opacityAdjustment.value = settings.get_double('style-widget-opacity');
        const opacityScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: opacityAdjustment,
            valign: Gtk.Align.CENTER,
            hexpand: false,
            width_request: 220,
            draw_value: false,
        });
        opacityScale.connect('value-changed', () => {
            this._debounce('style-widget-opacity', () => {
                settings.set_double('style-widget-opacity', opacityScale.get_value());
            }, 150);
        });
        opacityRow.add_suffix(opacityScale);
        group.add(opacityRow);

        // Reset Style
        const resetStyleRow = new Adw.ActionRow({
            title: _('Reset Style'),
            subtitle: _('Restore default widget appearance'),
            activatable: true,
        });
        resetStyleRow.connect('activated', () => {
            // Temporarily block color change notifications to prevent writing fallback colors
            this._resetting = true;

            // Reset settings to defaults (empty = use theme)
            settings.set_int('style-border-radius', 16);
            settings.set_int('style-border-width', 1);
            settings.set_int('style-shadow-size', 24);
            settings.set_double('style-widget-opacity', 1.0);
            settings.set_string('style-background', '');
            settings.set_string('style-border-color', '');
            settings.set_string('style-shadow', '');

            // Reset UI controls
            radiusRow.set_value(16);
            borderWidthRow.set_value(1);
            shadowSizeRow.set_value(24);
            opacityScale.set_value(1.0);

            // Reset color buttons back to their fallbacks (skips writing via _resetting flag)
            for (const colorRow of [bgColorRow, borderColorRow, shadowRow]) {
                const rgba = new Gdk.RGBA();
                rgba.parse(colorRow._fallbackColor);
                colorRow._colorButton.set_rgba(rgba);
            }

            this._resetting = false;
        });
        group.add(resetStyleRow);

        page.add(group);
        return page;
    }

    _createColorRow(title, subtitle, settings, key, fallbackColor) {
        const row = new Adw.ActionRow({
            title: title,
            subtitle: subtitle,
        });

        const colorButton = this._createColorButton(
            settings.get_string(key),
            fallbackColor,
            color => settings.set_string(key, color.to_string())
        );

        const colorBox = new Gtk.Box({spacing: 6, homogeneous: false});
        colorBox.append(colorButton);
        row.add_suffix(colorBox);

        row._colorButton = colorButton;
        row._fallbackColor = fallbackColor;
        row._settingsKey = key;

        return row;
    }

    _createColorButton(initialColor, fallbackColor, onColorSet) {
        // Determine GTK version for color dialog vs color button
        const major = Gtk.get_major_version();
        const minor = Gtk.get_minor_version();
        let colorButton;
        let signalEmitted;

        if (major > 4 || major === 4 && minor >= 10) {
            // GTK 4.10+: use Gtk.ColorDialogButton
            signalEmitted = 'notify::rgba';
            const colorDialog = new Gtk.ColorDialog({with_alpha: false});
            colorButton = new Gtk.ColorDialogButton({dialog: colorDialog});
        } else {
            // GTK < 4.10: use Gtk.ColorButton
            signalEmitted = 'color-set';
            colorButton = new Gtk.ColorButton();
        }

        colorButton.set_valign(Gtk.Align.CENTER);
        colorButton.set_halign(Gtk.Align.END);
        colorButton.set_margin_start(12);
        colorButton.set_margin_end(6);

        // Initialize color from settings
        const rgba = new Gdk.RGBA();
        let success = Boolean(initialColor && initialColor.length > 0);
        if (success) {
            try {
                success = rgba.parse(initialColor);
            } catch (e) {
                // parsing failed, fall back to default
                success = false;
            }
        }
        if (!success) {
            rgba.parse(fallbackColor);
        }
        colorButton.set_rgba(rgba);

        // When color changes, run the callback
        colorButton.connect(signalEmitted, () => {
            if (this._resetting) {
                // Skip saving during reset to avoid writing fallback colors
                return;
            }
            onColorSet(colorButton.get_rgba());
        });

        return colorButton;
    }

    _addWidget(settings, type) {
        const serialized = settings.get_string('layout-json');
        let parsed = null;

        try {
            parsed = JSON.parse(serialized);
        } catch (error) {
            parsed = null;
        };

        const widgets = parsed && Array.isArray(parsed.widgets) ? [...parsed.widgets] : [];
        const size = DEFAULT_SIZES[type] ?? 'small';
        const id = `${type}-${Date.now()}`;

        widgets.push({
            id,
            type,
            size,
            x: 24,
            y: 80,
            data: {},
        });

        settings.set_string('layout-json', JSON.stringify({widgets}));
    }

    _debounce(key, callback, delay = 230) {
        if (!this._debounceTimers) {
            this._debounceTimers = {};
        }
        if (this._debounceTimers[key]) {
            GLib.source_remove(this._debounceTimers[key]);
        }
        this._debounceTimers[key] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._debounceTimers[key] = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }
}