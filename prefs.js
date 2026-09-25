'use strict';

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';

import {ExtensionPreferences, gettext as _}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {clearLayout, layoutJson, writeLayout} from './layoutDoc.js';

const WIDGET_TYPES = [
    {type: 'applauncher'},
    {type: 'clock'},
    {type: 'digitalclock'},
    {type: 'binaryclock'},
    {type: 'calendar'},
    {type: 'weather'},
    {type: 'photos'},
    {type: 'battery'},
    {type: 'music'},
    {type: 'todo'},
    {type: 'github'},
    {type: 'screentime'},
    {type: 'system'},
    {type: 'notes'},
];

const widgetTypeLabel = (type) => ({
    applauncher: _('App Launcher'),
    clock: _('Clock'),
    digitalclock: _('Digital Clock'),
    binaryclock: _('Binary Clock'),
    calendar: _('Calendar'),
    weather: _('Weather'),
    photos: _('Photos'),
    battery: _('Battery'),
    music: _('Music'),
    todo: _('Task'),
    github: _('GitHub Activity'),
    screentime: _('Screen Time'),
    system: _('System Monitor'),
    notes: _('Notes'),
}[type] ?? type);

const DEFAULT_SIZES = {
    applauncher: 'medium',
    clock: 'small',
    digitalclock: 'small',
    binaryclock: 'medium',
    calendar: 'small',
    weather: 'small',
    photos: 'medium',
    battery: 'medium',
    music: 'medium',
    todo: 'medium',
    github: 'medium',
    screentime: 'medium',
    system: 'small',
    notes: 'medium',
};

const PHOTO_SIZES = ['cover', 'contain', 'fill', 'small'];
const PHOTO_SIZE_LABELS = () => [_('Cover'), _('Contain'), _('Stretch'), _('Small')];

const BATTERY_ICON_SIZES = ['small', 'medium', 'large'];
const BATTERY_ICON_SIZE_LABELS = () => [_('Small'), _('Medium'), _('Large')];

const MUSIC_GIFS = ['pushy.gif', 'pushy2.gif', 'pushy3.gif', 'pushy4.gif', 'pushy5.gif'];

const DEFAULT_LAUNCHER_APPS = [
    {id: 'org.gnome.Nautilus.desktop', name: 'Files'},
    {id: 'org.gnome.Terminal.desktop', name: 'Terminal'},
    {id: 'firefox.desktop', name: 'Firefox'},
    {id: 'org.gnome.Settings.desktop', name: 'Settings'},
];

const LAUNCHER_MAX_APPS = 16;

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

        const iconTheme = Gtk.IconTheme.get_for_display(window.get_display());
        iconTheme.add_search_path(this.dir.get_child('icons').get_path());

        const settings = this.getSettings();

        // Never leave a slider "grabbed" state behind when the window closes.
        window.connect('close-request', () => {
            settings.set_boolean('drag-active', false);
            return false;
        });

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

        // Screen Time page
        const screentimePage = this._createScreentimePage(settings);
        screentimePage.set_title(_('Screen Time Widget'));
        screentimePage.set_icon_name('alarm-symbolic');
        this._addSidebarPage(screentimePage);

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

        // GitHub page
        const githubPage = this._createGithubPage(settings);
        githubPage.set_title(_('GitHub Widget'));
        githubPage.set_icon_name('folder-publicshare-symbolic');
        this._addSidebarPage(githubPage);

        // App Launcher page
        const appLauncherPage = this._createAppLauncherPage(settings);
        appLauncherPage.set_title(_('App Launcher Widget'));
        appLauncherPage.set_icon_name('view-grid-symbolic');
        this._addSidebarPage(appLauncherPage);

        // Notes page
        const notesPage = this._createNotesPage(settings);
        notesPage.set_title(_('Notes Widget'));
        notesPage.set_icon_name('document-edit-symbolic');
        this._addSidebarPage(notesPage);

        // Appearance page
        const appearancePage = this._createAppearancePage(settings);
        appearancePage.set_title(_('Appearance'));
        appearancePage.set_icon_name('preferences-color-symbolic');
        this._addSidebarPage(appearancePage);

        // About page
        const aboutPage = this._createAboutPage();
        aboutPage.set_title(_('About'));
        aboutPage.set_icon_name('help-about-symbolic');
        this._addSidebarPage(aboutPage);

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

        const gapRow = new Adw.SpinRow({
            title: _('Widget gap (px)'),
            subtitle: _('Space between widgets and screen edges'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 50,
                step_increment: 1,
            }),
        });
        gapRow.set_value(settings.get_int('widget-gap'));
        gapRow.connect('notify::value', () => {
            const value = Math.round(gapRow.get_value());
            if (settings.get_int('widget-gap') !== value) {
                settings.set_int('widget-gap', value);
            }
        });
        settings.connect('changed::widget-gap', () => {
            const value = settings.get_int('widget-gap');
            if (Math.round(gapRow.get_value()) !== value) {
                gapRow.set_value(value);
            }
        });
        widgetsGroup.add(gapRow);

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

        const widgetTypesModel = Gtk.StringList.new(WIDGET_TYPES.map(w => widgetTypeLabel(w.type)));
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
            clearLayout(settings);
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

                writeLayout(settings, layout.widgets);
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

            writeLayout(settings, parsed.widgets);
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

                const accel = Gtk.accelerator_name(keyval, mask);
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

        const photoSizeModel = Gtk.StringList.new(PHOTO_SIZE_LABELS());
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

        const iconSizeModel = Gtk.StringList.new(BATTERY_ICON_SIZE_LABELS());
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

    _createScreentimePage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Screen Time Widget'),
            description: _('Per-app screen time is tracked automatically while the widget is on your desktop.'),
            margin_top: 12,
        });

        const retentionRow = new Adw.SpinRow({
            title: _('Keep history for'),
            subtitle: _('Days of data to keep before older days are deleted'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 365,
                step_increment: 1,
                page_increment: 7,
            }),
        });
        retentionRow.set_value(settings.get_int('screentime-retention-days'));
        retentionRow.connect('notify::value', () => {
            settings.set_int('screentime-retention-days', Math.round(retentionRow.get_value()));
        });
        group.add(retentionRow);

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

        const customAppRow = new Adw.ActionRow({
            title: _('Custom app'),
            subtitle: _('App launched when the widget is clicked. Takes priority over built-in players'),
            activatable: true,
        });

        const customAppIcon = new Gtk.Image({
            pixel_size: 24,
            valign: Gtk.Align.CENTER,
        });
        customAppRow.add_prefix(customAppIcon);

        const customAppButtons = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });

        const pickCustomAppButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Choose application'),
        });

        const clearCustomAppButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'destructive-action'],
            tooltip_text: _('Clear'),
        });

        customAppButtons.append(pickCustomAppButton);
        customAppButtons.append(clearCustomAppButton);
        customAppRow.add_suffix(customAppButtons);
        group.add(customAppRow);

        const updateCustomAppRow = () => {
            const appId = settings.get_string('music-custom-app');
            let icon = null;
            let name = '';

            if (appId) {
                try {
                    const appInfo = Gio.DesktopAppInfo.new(appId);
                    if (appInfo) {
                        icon = appInfo.get_icon();
                        name = appInfo.get_display_name() || appInfo.get_name() || appId;
                    } else {
                        name = appId;
                    }
                } catch (e) {
                    name = appId;
                }
            }

            customAppIcon.visible = Boolean(icon);
            if (icon) customAppIcon.set_from_gicon(icon);
            customAppRow.set_subtitle(appId
                ? _('Launched when the widget is clicked: %s').format(name)
                : _('App launched when the widget is clicked. Takes priority over built-in players'));
            clearCustomAppButton.visible = Boolean(appId);
        };

        const openCustomAppPicker = () => {
            const current = settings.get_string('music-custom-app');
            const selectedApps = new Map();
            if (current) selectedApps.set(current, {id: current});

            this._openLauncherAppPicker({
                allApps: this._allInstalledApps(),
                selectedApps,
                onPicked: app => {
                    settings.set_string('music-custom-app', app.id);
                    updateCustomAppRow();
                },
                closeOnPick: true,
            });
        };

        pickCustomAppButton.connect('clicked', openCustomAppPicker);
        customAppRow.connect('activated', openCustomAppPicker);
        clearCustomAppButton.connect('clicked', () => {
            settings.set_string('music-custom-app', '');
            updateCustomAppRow();
        });

        updateCustomAppRow();

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

    _createGithubPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('GitHub Widget'),
            description: _('Customize the GitHub Activity widget appearance.'),
            margin_top: 12,
        });

        const useGreenRow = new Adw.SwitchRow({
            title: _('Use GitHub Green Colors'),
            subtitle: _("Use GitHub's default green color scheme instead of the theme accent color"),
        });
        useGreenRow.set_active(settings.get_boolean('github-use-green'));
        group.add(useGreenRow);
        useGreenRow.connect('notify::active', () => {
            settings.set_boolean('github-use-green', useGreenRow.get_active());
        });

        const usernameRow = new Adw.EntryRow({
            title: _('GitHub username'),
            text: settings.get_string('github-username'),
            show_apply_button: true,
        });
        usernameRow.set_tooltip_text(_('Applied to all GitHub widgets. Empty to set a username per widget'));
        group.add(usernameRow);
        usernameRow.connect('apply', () => {
            const value = usernameRow.get_text().trim().replace(/^@/, '');
            if (value === settings.get_string('github-username')) return;
            settings.set_string('github-username', value);
        });

        page.add(group);
        return page;
    }

    _createNotesPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Notes Widget'),
            description: _('Customize the Notes widget font sizes.'),
            margin_top: 12,
        });

        const titleFontSizeRow = new Adw.SpinRow({
            title: _('Title font size'),
            subtitle: _('Font size in pixels for the notes title'),
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 32,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('notes-title-font-size'),
            }),
        });
        group.add(titleFontSizeRow);
        titleFontSizeRow.connect('notify::value', () => {
            settings.set_int('notes-title-font-size', titleFontSizeRow.get_value());
        });

        const contentFontSizeRow = new Adw.SpinRow({
            title: _('Content font size'),
            subtitle: _('Font size in pixels for the notes content text'),
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 32,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('notes-content-font-size'),
            }),
        });
        group.add(contentFontSizeRow);
        contentFontSizeRow.connect('notify::value', () => {
            settings.set_int('notes-content-font-size', contentFontSizeRow.get_value());
        });

        page.add(group);
        return page;
    }

    _launcherAppsFilePath(widgetId) {
        const dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'desktop-widgets@r3nhick', 'applauncher']);
        GLib.mkdir_with_parents(dataDir, 0o755);
        return GLib.build_filenamev([dataDir, `applauncher-${widgetId}.json`]);
    }

    _loadLauncherApps(dataFilePath) {
        const selectedApps = new Map();
        try {
            if (GLib.file_test(dataFilePath, GLib.FileTest.EXISTS)) {
                const [success, contents] = GLib.file_get_contents(dataFilePath);
                if (success) {
                    const data = JSON.parse(new TextDecoder().decode(contents));
                    if (Array.isArray(data.apps)) {
                        for (const app of data.apps) {
                            if (!app.id) continue;
                            selectedApps.set(app.id, app);
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Failed to load apps:', e);
        }
        return selectedApps;
    }

    _allInstalledApps() {
        const seenIds = new Set();
        const apps = [];
        for (const appInfo of Gio.AppInfo.get_all()) {
            const appId = appInfo.get_id();
            if (!appId || seenIds.has(appId) || !appInfo.should_show()) continue;
            seenIds.add(appId);
            apps.push({
                id: appId,
                name: appInfo.get_display_name() || appInfo.get_name() || appId,
                description: appInfo.get_description() || '',
                icon: appInfo.get_icon() || null,
            });
        }
        apps.sort((a, b) => a.name.localeCompare(b.name));
        return apps;
    }

    _launcherAppIcon(appId) {
        try {
            const appInfo = Gio.DesktopAppInfo.new(appId);
            return appInfo ? appInfo.get_icon() : null;
        } catch (e) {
            return null;
        }
    }

    _openLauncherAppPicker({allApps, selectedApps, onAdded, onPicked = null, closeOnPick = false}) {
        const dialog = new Adw.Window({
            title: _('Add Applications'),
            modal: true,
            transient_for: this._window,
            default_width: 520,
            default_height: 620,
        });

        const toolbar = new Adw.ToolbarView();
        const headerBar = new Adw.HeaderBar();
        const closeButton = new Gtk.Button({
            icon_name: 'window-close-symbolic',
        });
        closeButton.connect('clicked', () => dialog.close());
        headerBar.pack_end(closeButton);
        toolbar.add_top_bar(headerBar);

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
        });

        const searchEntry = new Gtk.SearchEntry({
            placeholder_text: _('Search applications...'),
            margin_start: 12,
            margin_end: 12,
            margin_top: 12,
            margin_bottom: 12,
        });

        const listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
        });
        listBox.add_css_class('boxed-list');

        const scrolled = new Gtk.ScrolledWindow({
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            margin_start: 12,
            margin_end: 12,
            margin_bottom: 12,
        });
        scrolled.set_child(listBox);

        const renderAvailableApps = () => {
            let child = listBox.get_first_child();
            while (child) {
                const next = child.get_next_sibling();
                listBox.remove(child);
                child = next;
            }

            const query = searchEntry.get_text().trim().toLowerCase();
            const filtered = allApps.filter(app => {
                if (selectedApps.has(app.id)) return false;
                if (!query) return true;
                return app.name.toLowerCase().includes(query) ||
                       app.description.toLowerCase().includes(query) ||
                       app.id.toLowerCase().includes(query);
            }).slice(0, 50);

            if (filtered.length === 0) {
                const row = new Gtk.ListBoxRow({selectable: false, activatable: false});
                const label = new Gtk.Label({
                    label: selectedApps.size >= LAUNCHER_MAX_APPS
                        ? _('Maximum apps reached')
                        : _('No matching applications'),
                    margin_top: 20,
                    margin_bottom: 20,
                });
                row.set_child(label);
                listBox.append(row);
                return;
            }

            for (const app of filtered) {
                const row = new Gtk.ListBoxRow({
                    selectable: false,
                    activatable: true,
                });
                const box = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 10,
                    margin_top: 8,
                    margin_bottom: 8,
                    margin_start: 10,
                    margin_end: 10,
                });

                const icon = new Gtk.Image({
                    gicon: app.icon,
                    pixel_size: 32,
                    valign: Gtk.Align.CENTER,
                });

                const textBox = new Gtk.Box({
                    orientation: Gtk.Orientation.VERTICAL,
                    spacing: 2,
                    hexpand: true,
                    valign: Gtk.Align.CENTER,
                });

                const nameLabel = new Gtk.Label({
                    label: app.name,
                    xalign: 0,
                    hexpand: true,
                });

                const detailLabel = new Gtk.Label({
                    xalign: 0,
                    wrap: true,
                    max_width_chars: 30,
                    use_markup: true,
                });
                const detail = app.description || app.id;
                detailLabel.set_markup(`<small><span alpha='65%'>${GLib.markup_escape_text(detail, -1)}</span></small>`);

                textBox.append(nameLabel);
                textBox.append(detailLabel);

                const addButton = new Gtk.Button({
                    icon_name: 'list-add-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat', 'suggested-action'],
                    tooltip_text: _('Add'),
                });

                addButton.connect('clicked', () => {
                    if (selectedApps.size >= LAUNCHER_MAX_APPS) return;
                    selectedApps.set(app.id, app);
                    onAdded?.();
                    onPicked?.(app);
                    if (closeOnPick) {
                        dialog.close();
                        return;
                    }
                    renderAvailableApps();
                });

                box.append(icon);
                box.append(textBox);
                box.append(addButton);
                row.set_child(box);
                listBox.append(row);
            }
        };

        searchEntry.connect('search-changed', renderAvailableApps);

        content.append(searchEntry);
        content.append(scrolled);
        toolbar.set_content(content);
        dialog.set_content(toolbar);

        renderAvailableApps();
        dialog.present();
    }

    _createAppLauncherPage(settings) {
        const page = new Adw.PreferencesPage();
        const groups = [];

        const rebuild = () => {
            for (const group of groups) {
                if (group.get_parent())
                    page.remove(group);
            }
            groups.length = 0;

            const widgets = layoutWidgets(settings);
            const appLauncherWidgets = widgets.filter(w => w.type === 'applauncher');

            if (appLauncherWidgets.length === 0) {
                const group = new Adw.PreferencesGroup({
                    title: _('App Launcher Widget'),
                    description: _('Manage apps for each widget. Changes apply instantly.'),
                    margin_top: 12,
                });

                group.add(new Adw.ActionRow({
                    title: _('No App Launcher widgets found'),
                    subtitle: _('Add an App Launcher widget from the General page first'),
                }));
                groups.push(group);
                page.add(group);
                return;
            }

            for (const widget of appLauncherWidgets) {
                const group = this._buildAppLauncherWidgetGroup(widget);
                groups.push(group);
                page.add(group);
            }
        };

        rebuild();

        const signalId = settings.connect('changed::layout-json', rebuild);
        page.connect('destroy', () => settings.disconnect(signalId));

        return page;
    }

    _buildAppLauncherWidgetGroup(widget) {
        const widgetGroup = new Adw.PreferencesGroup({
            title: `${_('Widget')}: ${widget.id}`,
            margin_top: 12,
        });

        const appsExpander = new Adw.ExpanderRow({
            title: _('Pinned Apps'),
            subtitle: _('Apps shown on this widget, in grid order'),
        });

        const dataFilePath = this._launcherAppsFilePath(widget.id);
        const selectedApps = this._loadLauncherApps(dataFilePath);

        // Defaults only apply when the widget was never saved; once the file
        // exists (even with no apps) respect what the user actually configured.
        if (selectedApps.size === 0
            && !GLib.file_test(dataFilePath, GLib.FileTest.EXISTS)) {
            for (const app of DEFAULT_LAUNCHER_APPS) {
                selectedApps.set(app.id, app);
            }
        }

        const saveApps = () => {
            const data = {apps: Array.from(selectedApps.values())};
            try {
                GLib.file_set_contents(dataFilePath, JSON.stringify(data, null, 2));
            } catch (e) {
                console.error('Failed to save apps:', e);
            }
        };

        const reorderApp = (appId, delta) => {
            const order = Array.from(selectedApps.keys());
            const from = order.indexOf(appId);
            const to = from + delta;
            if (from < 0 || to < 0 || to >= order.length) return;
            [order[from], order[to]] = [order[to], order[from]];
            const reordered = new Map(order.map(id => [id, selectedApps.get(id)]));
            selectedApps.clear();
            for (const [id, app] of reordered) {
                selectedApps.set(id, app);
            }
            saveApps();
            renderPinnedApps();
        };

        // Build app selection UI when expanded
        let uiBuilt = false;
        let allApps = [];
        let builtRows = [];

        const renderPinnedApps = () => {
            for (const row of builtRows) {
                if (row && row.get_parent())
                    appsExpander.remove(row);
            }
            builtRows.length = 0;

            appsExpander.set_subtitle(`${_('Apps')}: ${selectedApps.size}`);
            const apps = Array.from(selectedApps.values());
            const lastIndex = apps.length - 1;

            for (let index = 0; index < apps.length; index++) {
                const app = apps[index];
                const appRow = new Adw.ActionRow({
                    title: app.name || app.id,
                });

                const icon = new Gtk.Image({
                    gicon: this._launcherAppIcon(app.id),
                    pixel_size: 32,
                });
                appRow.add_prefix(icon);

                const reorderBox = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 2,
                });

                if (index > 0) {
                    const upButton = new Gtk.Button({
                        icon_name: 'go-up-symbolic',
                        valign: Gtk.Align.CENTER,
                        css_classes: ['flat'],
                        tooltip_text: _('Move up'),
                    });
                    upButton.connect('clicked', () => reorderApp(app.id, -1));
                    reorderBox.append(upButton);
                }

                if (index < lastIndex) {
                    const downButton = new Gtk.Button({
                        icon_name: 'go-down-symbolic',
                        valign: Gtk.Align.CENTER,
                        css_classes: ['flat'],
                        tooltip_text: _('Move down'),
                    });
                    downButton.connect('clicked', () => reorderApp(app.id, 1));
                    reorderBox.append(downButton);
                }

                appRow.add_suffix(reorderBox);

                const removeButton = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat', 'destructive-action'],
                    tooltip_text: _('Remove'),
                });

                removeButton.connect('clicked', () => {
                    selectedApps.delete(app.id);
                    saveApps();
                    renderPinnedApps();
                });

                appRow.add_suffix(removeButton);
                appsExpander.add_row(appRow);
                builtRows.push(appRow);
            }

            // Add "Add Apps" row at the end
            const addAppsRow = new Adw.ActionRow({
                title: _('Add Apps'),
            });

            const addIcon = new Gtk.Image({
                icon_name: 'list-add-symbolic',
                pixel_size: 24,
            });
            addAppsRow.add_prefix(addIcon);
            addAppsRow.activatable = true;
            appsExpander.add_row(addAppsRow);
            builtRows.push(addAppsRow);

            addAppsRow.connect('activated', () => {
                this._openLauncherAppPicker({
                    allApps,
                    selectedApps,
                    onAdded: () => {
                        saveApps();
                        renderPinnedApps();
                    },
                });
            });
        };

        appsExpander.connect('notify::expanded', () => {
            if (!appsExpander.get_expanded() || uiBuilt) return;
            uiBuilt = true;
            allApps = this._allInstalledApps();
            renderPinnedApps();
        });

        widgetGroup.add(appsExpander);
        return widgetGroup;
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

        // Custom Accent Color
        const customAccentRow = new Adw.SwitchRow({
            title: _('Use Custom Accent Color'),
            subtitle: _('Override the system accent color for all widgets'),
        });
        customAccentRow.set_active(settings.get_boolean('style-use-custom-accent'));
        group.add(customAccentRow);

        const accentColorRow = this._createColorRow(
            _('Accent Color'),
            _('Custom accent color used by all widgets'),
            settings,
            'style-accent-color',
            '#3584e4'
        );
        accentColorRow.sensitive = customAccentRow.get_active();
        group.add(accentColorRow);

        customAccentRow.connect('notify::active', () => {
            settings.set_boolean('style-use-custom-accent', customAccentRow.get_active());
            accentColorRow.sensitive = customAccentRow.get_active();
        });

        // Light Glass Style
        const lightGlassRow = new Adw.SwitchRow({
            title: _('Glass Style'),
            subtitle: _('Apply a glass effect with transparency and blur to all widgets'),
        });
        lightGlassRow.set_active(settings.get_boolean('style-light-glass'));

        // Light Glass Blur
        const lightGlassBlurRow = new Adw.SpinRow({
            title: _('Glass Blur'),
            subtitle: _('Blur radius of the glass effect'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 50,
                step_increment: 1,
                page_increment: 1,
            }),
        });
        lightGlassBlurRow.set_value(settings.get_int('style-light-glass-blur'));
        lightGlassBlurRow.connect('notify::value', () => {
            this._debounce('style-light-glass-blur', () => {
                settings.set_int('style-light-glass-blur', Math.round(lightGlassBlurRow.get_value()));
            }, 150);
        });
        lightGlassBlurRow.sensitive = lightGlassRow.get_active();

        // Signal the shell while a slider is being dragged so it can defer
        // widget re-renders until the handle is actually released.
        const trackSliderDrag = (scale, key) => {
            const click = new Gtk.GestureClick();
            // Capture phase: observe the press/release even though GtkScale
            // claims the pointer sequence for its own drag handling.
            click.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
            click.connect('pressed', () => settings.set_boolean('drag-active', true));
            click.connect('released', () => {
                settings.set_double(key, scale.get_value());
                settings.set_boolean('drag-active', false);
            });
            click.connect('stopped', () => settings.set_boolean('drag-active', false));
            scale.add_controller(click);
        };

        // Light Glass Opacity
        const lightGlassOpacityRow = new Adw.ActionRow({
            title: _('Glass Opacity'),
            subtitle: _('Opacity of the glass background'),
        });
        const glassOpacityAdjustment = new Gtk.Adjustment({
            lower: 0.1,
            upper: 1.0,
            step_increment: 0.05,
            page_increment: 0.1,
        });
        glassOpacityAdjustment.value = settings.get_double('style-light-glass-opacity');
        const glassOpacityScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: glassOpacityAdjustment,
            valign: Gtk.Align.CENTER,
            hexpand: false,
            width_request: 180,
            draw_value: false,
        });
        const glassOpacityPercent = new Gtk.Label({
            label: `${Math.round(glassOpacityAdjustment.value * 100)}%`,
            css_classes: ['dim-label'],
        });
        glassOpacityScale.connect('value-changed', () => {
            glassOpacityPercent.label = `${Math.round(glassOpacityScale.get_value() * 100)}%`;
            this._debounce('style-light-glass-opacity', () => {
                settings.set_double('style-light-glass-opacity', glassOpacityScale.get_value());
            }, 150);
        });
        trackSliderDrag(glassOpacityScale, 'style-light-glass-opacity');
        lightGlassOpacityRow.add_suffix(glassOpacityScale);
        lightGlassOpacityRow.add_suffix(glassOpacityPercent);
        lightGlassOpacityRow.sensitive = lightGlassRow.get_active();

        // GPU warning: always visible above the Glass Style toggle.
        // Must be a PreferencesRow: plain widgets are added to a separate
        // box below the group's listbox, so they always render at the very
        // bottom of the group regardless of add order.
        const glassGpuWarningRow = new Adw.ActionRow({
            title: _('⚠ Warning: Glass Style increases GPU usage'),
            subtitle: _('Glass widgets are redrawn every frame with transparency effects, which raises GPU load. If the desktop becomes slow or your GPU heats up, turn Glass Style off.'),
        });

        lightGlassRow.connect('notify::active', () => {
            settings.set_boolean('style-light-glass', lightGlassRow.get_active());
            lightGlassBlurRow.sensitive = lightGlassRow.get_active();
            lightGlassOpacityRow.sensitive = lightGlassRow.get_active();
        });
        group.add(glassGpuWarningRow);
        group.add(lightGlassRow);
        group.add(lightGlassBlurRow);
        group.add(lightGlassOpacityRow);

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
            width_request: 180,
            draw_value: false,
        });
        const opacityPercent = new Gtk.Label({
            label: `${Math.round(opacityAdjustment.value * 100)}%`,
            css_classes: ['dim-label'],
        });
        opacityScale.connect('value-changed', () => {
            opacityPercent.label = `${Math.round(opacityScale.get_value() * 100)}%`;
            this._debounce('style-widget-opacity', () => {
                settings.set_double('style-widget-opacity', opacityScale.get_value());
            }, 150);
        });
        trackSliderDrag(opacityScale, 'style-widget-opacity');
        opacityRow.add_suffix(opacityScale);
        opacityRow.add_suffix(opacityPercent);
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
            settings.set_boolean('style-use-custom-accent', false);
            settings.set_string('style-accent-color', '');
            settings.set_boolean('style-light-glass', false);
            settings.set_int('style-light-glass-blur', 10);
            settings.set_double('style-light-glass-opacity', 0.7);

            // Reset UI controls
            radiusRow.set_value(16);
            borderWidthRow.set_value(1);
            shadowSizeRow.set_value(24);
            opacityScale.set_value(1.0);
            customAccentRow.set_active(false);
            accentColorRow.sensitive = false;
            lightGlassRow.set_active(false);
            lightGlassBlurRow.set_value(10);
            glassOpacityScale.set_value(0.7);
            lightGlassBlurRow.sensitive = false;
            lightGlassOpacityRow.sensitive = false;

            // Reset color buttons back to their fallbacks (skips writing via _resetting flag)
            for (const colorRow of [bgColorRow, borderColorRow, accentColorRow, shadowRow]) {
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

    _createAboutPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            margin_top: 12,
        });

        const headerBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 18,
            margin_bottom: 18,
            halign: Gtk.Align.CENTER,
        });
        headerBox.append(new Gtk.Image({
            icon_name: 'view-grid-symbolic',
            pixel_size: 96,
            margin_bottom: 6,
        }));
        headerBox.append(new Gtk.Label({
            label: this.metadata.name,
            css_classes: ['title-1'],
            wrap: true,
            justify: Gtk.Justification.CENTER,
        }));
        headerBox.append(new Gtk.Label({
            label: 'r3nhick',
            css_classes: ['title-5'],
            margin_top: 4,
        }));

        const version = this.metadata['version-name'] ?? String(this.metadata.version ?? '');
        headerBox.append(new Gtk.Label({
            label: _('Version %s').format(version),
            css_classes: ['dim-label'],
            margin_top: 4,
        }));

        const headerRow = new Adw.ActionRow({activatable: false});
        headerRow.set_child(headerBox);
        group.add(headerRow);

        group.add(this._aboutLinkRow(
            _('Report an Issue'),
            'desktop-widgets-bug-symbolic',
            'https://github.com/r3nhick/desktop-widgets/issues'
        ));
        group.add(this._aboutLinkRow(
            _('View sources on GitHub'),
            'folder-publicshare-symbolic',
            'https://github.com/r3nhick/desktop-widgets'
        ));
        group.add(this._aboutLinkRow(
            _('License'),
            'text-x-generic-symbolic',
            'https://github.com/r3nhick/desktop-widgets/blob/main/LICENSE',
            _('GNU General Public License, version 3 or later')
        ));

        page.add(group);
        return page;
    }

    _aboutLinkRow(title, iconName, url, subtitle) {
        const row = new Adw.ActionRow({
            title: title,
            activatable: true,
        });

        if (subtitle) {
            row.set_subtitle(subtitle);
        }

        row.add_prefix(new Gtk.Image({
            icon_name: iconName,
            valign: Gtk.Align.CENTER,
        }));
        row.add_suffix(new Gtk.Image({
            icon_name: 'adw-external-link-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        row.set_tooltip_text(url);
        row.connect('activated', () => {
            Gio.AppInfo.launch_default_for_uri_async(url, null, null, null);
        });

        return row;
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

        settings.set_string('layout-json', layoutJson(widgets));
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