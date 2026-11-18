'use strict';

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import cairo from 'gi://cairo';

import {ExtensionPreferences, gettext as _}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {clearLayout, layoutJson, writeLayout} from './layoutDoc.js';
import {openWidgetPicker} from './prefs/widgetPickerDialog.js';
import {settingsIconPath} from './paths.js';
import {WIDGET_TYPE_LABELS} from './lib/widgetTypes.js';

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
    {type: 'pomodoro'},
    {type: 'lava'},
    {type: 'stopwatch'},
    {type: 'folder'},
    {type: 'timer'},
];

const widgetTypeLabel = (type) => _(WIDGET_TYPE_LABELS[type] ?? type);

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
    pomodoro: 'small',
    lava: 'medium',
    stopwatch: 'medium',
    folder: 'medium',
    timer: 'medium',
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
    /**
     * Extension icons have no `-symbolic` suffix: for such files GTK
     * takes the path outline and fills it solid, which turns the line
     * lucide icons into blobs (fill="none" is ignored).
     * That is why every icon has two color variants; we pick the right one
     * and repaint all registered spots when the theme changes.
     */
    fillPreferencesWindow(window) {
        this._window = window;
        this._pages = [];
        // Handlers and one-shot sources registered while building the pages
        // close over destroyed widgets once the window closes. Everything is
        // tracked here and released in _releasePageHandlers() on close-request.
        this._trackedPageSignals = [];
        this._trackedPageSources = [];

        window.set_default_size(900, 700);
        window.set_title(_('Desktop Widgets'));
        window.set_search_enabled(false);

        // Enlarge the sidebar icons via CSS.
        const cssProvider = new Gtk.CssProvider();
        cssProvider.load_from_data(
            'navigation-sidebar row image { min-width: 32px; min-height: 32px; -gtk-icon-size: 32px; }',
            -1
        );
        Gtk.StyleContext.add_provider_for_display(
            window.get_display(),
            cssProvider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        const settings = this.getSettings();

        // Page builders throughout this file call settings.connect(...) with
        // callbacks that read exposed GTK widgets. The pages die with the
        // window, but the GSettings handlers stay connected — they fire on
        // destroyed widgets later (fresh JS errors in the journal and stale
        // schema writes). Track every connect so close-request can release
        // them, and keep our tracking consistent when page code disconnects
        // explicitly (the folder and app-launcher pages do their own cleanup).
        const trackedConnect = settings.connect.bind(settings);
        const trackedDisconnect = settings.disconnect.bind(settings);
        settings.connect = (signal, callback) => {
            const id = trackedConnect(signal, (source, ...args) => callback(source, ...args));
            this._trackedPageSignals.push([settings, id]);
            return id;
        };
        settings.disconnect = (id) => {
            const index = this._trackedPageSignals.findIndex(entry => entry[1] === id);
            if (index !== -1) {
                this._trackedPageSignals.splice(index, 1);
            }
            trackedDisconnect(id);
        };

        // Never leave a slider "grabbed" state behind when the window closes.
        window.connect('close-request', () => {
            settings.set_boolean('drag-active', false);
            return false;
        });

        // Check if widget picker should be opened automatically
        if (settings.get_boolean('open-widget-picker')) {
            settings.set_boolean('open-widget-picker', false);
            // Open widget picker after window is shown
            this._trackSource(GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                openWidgetPicker(window, this.path, _, (widgetType) => {
                    this._addWidget(settings, widgetType);
                });
                return GLib.SOURCE_REMOVE;
            }));
        }

        this._switchToSidebar(window);

        // General page
        const generalPage = new Adw.PreferencesPage();
        generalPage.set_title(_('General'));
        generalPage._dwId = 'general';
        generalPage.set_icon_name('preferences-system-symbolic');
        this._buildGeneralPage(generalPage, settings);
        this._addSidebarPage(generalPage);

        // Every per-widget page lives under one collapsible sidebar section.
        this._sidebarWidgetGroup = this._addSidebarGroup(_('Widget settings'), 'view-grid-symbolic');

        // Photos page
        const photosPage = this._createPhotosPage(settings);
        photosPage.set_title(_('Photos Widget'));
        photosPage._dwId = 'photos-widget';
        photosPage.set_icon_name('image-x-generic-symbolic');
        this._addSidebarPage(photosPage, this._sidebarWidgetGroup);

        // Battery page
        const batteryPage = this._createBatteryPage(settings);
        batteryPage.set_title(_('Battery Widget'));
        batteryPage._dwId = 'battery-widget';
        batteryPage.set_icon_name('battery-symbolic');
        this._addSidebarPage(batteryPage, this._sidebarWidgetGroup);

        // Screen Time page
        const screentimePage = this._createScreentimePage(settings);
        screentimePage.set_title(_('Screen Time Widget'));
        screentimePage._dwId = 'screen-time-widget';
        screentimePage.set_icon_name('alarm-symbolic');
        this._addSidebarPage(screentimePage, this._sidebarWidgetGroup);

        // Music page
        const musicPage = this._createMusicPage(settings);
        musicPage.set_title(_('Music Widget'));
        musicPage._dwId = 'music-widget';
        musicPage.set_icon_name('folder-music-symbolic');
        this._addSidebarPage(musicPage, this._sidebarWidgetGroup);

        // Calendar page
        const calendarPage = this._createCalendarPage(settings);
        calendarPage.set_title(_('Calendar Widget'));
        calendarPage._dwId = 'calendar-widget';
        calendarPage.set_icon_name('x-office-calendar-symbolic');
        this._addSidebarPage(calendarPage, this._sidebarWidgetGroup);

        // Weather page
        const weatherPage = this._createWeatherPage(settings);
        weatherPage.set_title(_('Weather Widget'));
        weatherPage._dwId = 'weather-widget';
        weatherPage.set_icon_name('weather-clear-symbolic');
        this._addSidebarPage(weatherPage, this._sidebarWidgetGroup);

        // Analog Clock page
        const analogClockPage = this._createAnalogClockPage(settings);
        analogClockPage.set_title(_('Analog Clock Widget'));
        analogClockPage._dwId = 'analog-clock-widget';
        analogClockPage.set_icon_name('preferences-system-time-symbolic');
        this._addSidebarPage(analogClockPage, this._sidebarWidgetGroup);

        // Digital Clock page
        const digitalClockPage = this._createDigitalClockPage(settings);
        digitalClockPage.set_title(_('Digital Clock Widget'));
        digitalClockPage._dwId = 'digital-clock-widget';
        digitalClockPage.set_icon_name('preferences-system-time-symbolic');
        this._addSidebarPage(digitalClockPage, this._sidebarWidgetGroup);

        // Binary Clock page
        const binaryClockPage = this._createBinaryClockPage(settings);
        binaryClockPage.set_title(_('Binary Clock Widget'));
        binaryClockPage._dwId = 'binary-clock-widget';
        binaryClockPage.set_icon_name('preferences-system-time-symbolic');
        this._addSidebarPage(binaryClockPage, this._sidebarWidgetGroup);

        // GitHub page
        const githubPage = this._createGithubPage(settings);
        githubPage.set_title(_('GitHub Widget'));
        githubPage._dwId = 'github-widget';
        githubPage.set_icon_name('network-server-symbolic');
        this._addSidebarPage(githubPage, this._sidebarWidgetGroup);

        // App Launcher page
        const appLauncherPage = this._createAppLauncherPage(settings);
        appLauncherPage.set_title(_('App Launcher Widget'));
        appLauncherPage._dwId = 'app-launcher-widget';
        appLauncherPage.set_icon_name('view-app-grid-symbolic');
        this._addSidebarPage(appLauncherPage, this._sidebarWidgetGroup);

        // Folder Launcher page
        const folderLauncherPage = this._createFolderLauncherPage(settings);
        folderLauncherPage.set_title(_('Folder Launcher Widget'));
        folderLauncherPage._dwId = 'folder-launcher-widget';
        folderLauncherPage.set_icon_name('folder-symbolic');
        this._addSidebarPage(folderLauncherPage, this._sidebarWidgetGroup);

        // Notes page
        const notesPage = this._createNotesPage(settings);
        notesPage.set_title(_('Notes Widget'));
        notesPage._dwId = 'notes-widget';
        notesPage.set_icon_name('text-x-generic-symbolic');
        this._addSidebarPage(notesPage, this._sidebarWidgetGroup);

        // Pomodoro page
        const pomodoroPage = this._createPomodoroPage(settings);
        pomodoroPage.set_title(_('Pomodoro Widget'));
        pomodoroPage._dwId = 'pomodoro-widget';
        pomodoroPage.set_icon_name('alarm-symbolic');
        this._addSidebarPage(pomodoroPage, this._sidebarWidgetGroup);

        // System Monitor page
        const systemMonitorPage = this._createSystemMonitorPage(settings);
        systemMonitorPage.set_title(_('System Monitor Widget'));
        systemMonitorPage._dwId = 'system-monitor-widget';
        systemMonitorPage.set_icon_name('computer-symbolic');
        this._addSidebarPage(systemMonitorPage, this._sidebarWidgetGroup);

        // Lava page
        const lavaPage = this._createLavaPage(settings);
        lavaPage.set_title(_('Lava Lamp Widget'));
        lavaPage._dwId = 'lava-lamp-widget';
        lavaPage.set_icon_name('weather-clear-symbolic');
        this._addSidebarPage(lavaPage, this._sidebarWidgetGroup);

        // Appearance page
        const appearancePage = this._createAppearancePage(settings);
        appearancePage.set_title(_('Appearance'));
        appearancePage._dwId = 'appearance';
        appearancePage.set_icon_name('applications-graphics-symbolic');
        this._addSidebarPage(appearancePage);

        // About page
        const aboutPage = this._createAboutPage(settings, window);
        aboutPage.set_title(_('About'));
        aboutPage._dwId = 'about';
        aboutPage.set_icon_name('help-about-symbolic');
        this._addSidebarPage(aboutPage);

        // Deep link from a widget's context menu: activate the widget's own
        // settings page right after the window is shown; an unknown page id
        // falls back to Appearance (the 'open-widget-picker' flag uses the
        // same set-then-read-through-gsettings handoff).
        const openPage = settings.get_string('open-prefs-page');
        if (openPage) {
            settings.set_string('open-prefs-page', '');
            this._trackSource(GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                const row = this._sidebarRows.get(openPage)
                    ?? this._sidebarRows.get('appearance');
                if (row?._group)
                    this._setSidebarGroupExpanded(row._group, true);
                row?.emit('activate');
                return GLib.SOURCE_REMOVE;
            }));
        }

        // Handle window close: pages are destroyed with the window, but the
        // handlers/sources they registered while being built live on —release
        // everything tracked (GSettings handlers, debounces, one-shot timers).
        window.connect('close-request', () => {
            for (const page of this._pages)
                page?.destroy?.();

            this._pages = [];

            this._releasePageHandlers();
            return false;
        });
    }

    /** Registers one one-shot GLib source so close-request can cancel it. */
    _trackSource(sourceId) {
        this._trackedPageSources.push(sourceId);
    }

    /** Registers one signal so close-request can disconnect it later. */
    _trackSignal(proxy, id) {
        this._trackedPageSignals.push([proxy, id]);
    }

    _releasePageHandlers() {
        // One-shot sources may already have fired: removing those again
        // logs a GLib-CRITICAL, so only still-pending ones are removed.
        const context = GLib.MainContext.default();
        for (const sourceId of this._trackedPageSources) {
            if (sourceId && context.find_source_by_id(sourceId))
                GLib.source_remove(sourceId);
        }
        this._trackedPageSources = [];

        for (const [proxy, id] of this._trackedPageSignals) {
            try {
                proxy.disconnect(id);
            } catch (error) {
                // Peer already gone.
            }
        }
        this._trackedPageSignals = [];

        for (const key in (this._debounceTimers ?? {})) {
            const id = this._debounceTimers[key];
            if (id && context.find_source_by_id(id)) {
                GLib.source_remove(id);
            }
        }
        this._debounceTimers = {};
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
        this._sidebarRows = new Map();
        this._sidebarListBox.add_css_class('navigation-sidebar');
        const sidebarScrolledWindow = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vexpand: true,
            hexpand: true,
        });
        sidebarScrolledWindow.set_child(this._sidebarListBox);
        sidebarBin.set_child(sidebarScrolledWindow);
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
            if (row._isGroup) {
                this._setSidebarGroupExpanded(row, !row._expanded);
                return;
            }
            splitView.set_show_content(true);
            splitViewContent.set_title(row._title);
            this._stack.set_visible_child_name(row._id);
        });
    }

    // Collapsible section header in the sidebar ("Widget settings ⌄"):
    // activating it shows/hides the page rows that belong to it.
    _addSidebarGroup(title, iconName) {
        const row = new Gtk.ListBoxRow({activatable: true, selectable: false});
        row._isGroup = true;
        row._expanded = false;
        row._members = [];

        const box = new Gtk.Box({
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 6,
            margin_end: 6,
        });
        box.append(new Gtk.Image({icon_name: iconName}));
        box.append(new Gtk.Label({label: title, xalign: 0, hexpand: true}));
        row._arrow = new Gtk.Image({icon_name: 'pan-down-symbolic'});
        box.append(row._arrow);
        row.set_child(box);
        try {
            row.update_property([Gtk.AccessibleProperty.LABEL], [title]);
            row.update_state([Gtk.AccessibleState.EXPANDED], [false]);
        } catch (_e) {
            // Accessibility metadata only — never break the window over it.
        }

        this._sidebarListBox.append(row);
        return row;
    }

    _setSidebarGroupExpanded(group, expanded) {
        group._expanded = expanded;
        group._arrow.set_from_icon_name(expanded ? 'pan-up-symbolic' : 'pan-down-symbolic');
        try {
            group.update_state([Gtk.AccessibleState.EXPANDED], [expanded]);
        } catch (_e) {}
        for (const member of group._members)
            member.set_visible(expanded);
    }

    _addSidebarPage(page, group = null) {
        const row = new Gtk.ListBoxRow();
        row._title = page.get_title();
        // Stable id from the ENGLISH title (set next to each set_title):
        // the translated title made deep links (widget context menu, update
        // notification) miss their page in every non-English locale.
        row._id = page._dwId ?? row._title.toLowerCase().replace(/\s+/g, '-');

        const rowIcon = new Gtk.Image({
            icon_name: page.get_icon_name(),
        });
        
        // Keep the page → rowIcon mapping so the icons stay in sync
        page._sidebarIcon = rowIcon;
        
        const rowLabel = new Gtk.Label({
            label: row._title,
            xalign: 0,
        });
        const box = new Gtk.Box({
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            // Rows inside a sidebar section are indented under its header.
            margin_start: group ? 24 : 6,
            margin_end: 6,
        });
        box.append(rowIcon);
        box.append(rowLabel);
        row.set_child(box);
        row.set_activatable(true);

        this._stack.add_named(page, row._id);
        this._sidebarListBox.append(row);
        this._sidebarRows.set(row._id, row);

        if (group) {
            row._group = group;
            group._members.push(row);
            row.set_visible(group._expanded);
        }

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

        const placementGridRow = new Adw.SwitchRow({
            title: _('Show placement grid'),
            subtitle: _('While dragging a widget in edit mode, show the free 1×1 cells and drop it onto the highlighted ones'),
        });
        placementGridRow.set_active(settings.get_boolean('show-placement-grid'));
        settings.bind('show-placement-grid', placementGridRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        widgetsGroup.add(placementGridRow);

        const pauseAnimationsRow = new Adw.SwitchRow({
            title: _('Pause animations in fullscreen'),
            subtitle: _('Automatically pause widget animations when a window is fullscreen to save resources'),
        });
        pauseAnimationsRow.set_active(settings.get_boolean('pause-animations-fullscreen'));
        settings.bind('pause-animations-fullscreen', pauseAnimationsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        widgetsGroup.add(pauseAnimationsRow);

        const showPanelIconRow = new Adw.SwitchRow({
            title: _('Show panel icon'),
            subtitle: _('Display icon in top panel for quick access to edit mode'),
        });
        showPanelIconRow.set_active(settings.get_boolean('show-panel-icon'));
        settings.bind('show-panel-icon', showPanelIconRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        widgetsGroup.add(showPanelIconRow);

        // Widget theme settings expandable row
        const themeExpanderRow = new Adw.ExpanderRow({
            title: _('Widget theme settings'),
            subtitle: _('Configure custom theme for widgets'),
            show_enable_switch: true,
        });
        
        // Bind the enable switch to settings
        settings.bind('use-custom-widget-theme', themeExpanderRow, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
        
        themeExpanderRow.connect('notify::enable-expansion', () => {
            const enabled = themeExpanderRow.enable_expansion;
            if (settings.get_boolean('use-custom-widget-theme') !== enabled) {
                settings.set_boolean('use-custom-widget-theme', enabled);
            }
        });

        // Theme switchers are segmented pills (the Focus/Break look): a
        // linked box of toggle buttons where the active segment carries the
        // accent fill. Adw.ToggleGroup renders flat inside action rows, so
        // the manual linked-toggles pill is used instead.
        const makeThemeSwitcher = (items, getActiveName, onActivate) => {
            const box = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                css_classes: ['linked'],
                valign: Gtk.Align.CENTER,
            });

            const buttons = [];
            const sync = () => {
                const active = getActiveName();
                for (const [btn, name] of buttons) {
                    const shouldBe = name === active;
                    if (btn.active !== shouldBe) {
                        btn.set_active(shouldBe);
                    }
                }
            };

            for (const [name, label] of items) {
                const btn = new Gtk.ToggleButton({ label });
                btn.connect('toggled', () => {
                    if (!btn.active) {
                        // Clicking the already-active segment un-checks it —
                        // keep that segment highlighted instead of leaving
                        // the pill black (image-2 bug).
                        if (getActiveName() === name) {
                            btn.set_active(true);
                        }
                        return;
                    }
                    if (getActiveName() !== name) {
                        onActivate(name);
                    }
                    sync();
                });
                buttons.push([btn, name]);
                box.append(btn);
            }

            sync();
            box.syncTo = sync;
            return box;
        };

        // Widget theme switcher (Custom | Dark | Light)
        const themeGeneralSwitcher = makeThemeSwitcher(
            [['custom', _('Custom')], ['dark', _('Dark')], ['light', _('Light')]],
            () => {
                if (settings.get_boolean('use-custom-widget-theme') && settings.get_boolean('use-same-theme-for-both')) {
                    return settings.get_string('widget-theme-unified') === 'dark' ? 'dark' : 'light';
                }
                return 'custom';
            },
            (wants) => {
                if (wants === 'custom') {
                    settings.set_boolean('use-same-theme-for-both', false);
                } else {
                    settings.set_boolean('use-same-theme-for-both', true);
                    if (settings.get_string('widget-theme-unified') !== wants) {
                        settings.set_string('widget-theme-unified', wants);
                    }
                }
            }
        );

        const themeGeneralRow = new Adw.ActionRow({
            title: _('Widget theme'),
            subtitle: _('Theme for widgets'),
        });
        themeGeneralRow.add_suffix(themeGeneralSwitcher);
        themeExpanderRow.add_row(themeGeneralRow);

        // Theme for light system mode
        const themeLightSwitcher = makeThemeSwitcher(
            [['dark', _('Dark')], ['light', _('Light')]],
            () => (settings.get_string('widget-theme-for-light') === 'light' ? 'light' : 'dark'),
            (wants) => {
                if (settings.get_string('widget-theme-for-light') !== wants) {
                    settings.set_string('widget-theme-for-light', wants);
                }
            }
        );

        const themeLightRow = new Adw.ActionRow({
            title: _('For light system theme'),
        });
        themeLightRow.add_suffix(themeLightSwitcher);
        themeExpanderRow.add_row(themeLightRow);

        // Theme for dark system mode
        const themeDarkSwitcher = makeThemeSwitcher(
            [['dark', _('Dark')], ['light', _('Light')]],
            () => (settings.get_string('widget-theme-for-dark') === 'light' ? 'light' : 'dark'),
            (wants) => {
                if (settings.get_string('widget-theme-for-dark') !== wants) {
                    settings.set_string('widget-theme-for-dark', wants);
                }
            }
        );

        const themeDarkRow = new Adw.ActionRow({
            title: _('For dark system theme'),
        });
        themeDarkRow.add_suffix(themeDarkSwitcher);
        themeExpanderRow.add_row(themeDarkRow);

        widgetsGroup.add(themeExpanderRow);

        // Page indicator shape for the swiping widgets (calendar 1x1, system
        // monitor): round dots or dashes — the same segmented pill look as
        // the theme switchers.
        const indicatorSwitcher = makeThemeSwitcher(
            [['dot', _('Dot')], ['dash', _('Dash')]],
            () => (settings.get_int('page-indicator-style') === 0 ? 'dot' : 'dash'),
            (wants) => {
                settings.set_int('page-indicator-style', wants === 'dash' ? 1 : 0);
            }
        );
        settings.connect('changed::page-indicator-style', () => indicatorSwitcher.syncTo());

        const indicatorRow = new Adw.ActionRow({
            title: _('Page indicator'),
            subtitle: _('Swipe-page markers in the calendar and system monitor'),
        });
        indicatorRow.add_suffix(indicatorSwitcher);
        widgetsGroup.add(indicatorRow);

        // Update theme rows from settings (switcher pills and visibility).
        const updateGeneralDropdown = () => {
            themeGeneralSwitcher.syncTo();
        };

        settings.connect('changed::widget-theme-for-light', () => themeLightSwitcher.syncTo());

        settings.connect('changed::widget-theme-for-dark', () => themeDarkSwitcher.syncTo());

        // Update visibility of theme rows based on settings
        const updateThemeRowsVisibility = () => {
            const customEnabled = settings.get_boolean('use-custom-widget-theme');
            const sameForBoth = settings.get_boolean('use-same-theme-for-both');
            
            themeLightRow.visible = !sameForBoth;
            themeDarkRow.visible = !sameForBoth;
            updateGeneralDropdown();
        };
        
        updateThemeRowsVisibility();
        settings.connect('changed::use-custom-widget-theme', updateThemeRowsVisibility);
        settings.connect('changed::use-same-theme-for-both', updateThemeRowsVisibility);
        settings.connect('changed::widget-theme-unified', updateGeneralDropdown);

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

        // Old dropdown approach
        const dropdownRow = new Adw.ActionRow({
            title: _('Quick add'),
            subtitle: _('Select widget type from dropdown'),
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

        dropdownRow.add_suffix(addBox);
        addGroup.add(dropdownRow);

        // New dialog approach
        const galleryRow = new Adw.ActionRow({
            title: _('Widget gallery'),
            subtitle: _('Browse all widgets with icons and search'),
            activatable: true,
        });

        const chevron = new Gtk.Image({
            icon_name: 'go-next-symbolic',
            valign: Gtk.Align.CENTER,
        });
        galleryRow.add_suffix(chevron);

        galleryRow.connect('activated', () => {
            openWidgetPicker(this._window, this.path, _, (widgetType) => {
                this._addWidget(settings, widgetType);
            });
        });

        addGroup.add(galleryRow);

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
		    let name = presetCombo.get_selected_item()?.get_string();
		    if (!name) {
		        const names = this._presetNames();
		        name = names.length ? names[0] : null;
		    };
		    if (name) {
		        this._restorePreset(settings, name);
		    } else {
		        this._showError(_('No saved layout selected'), '');
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

        // Accent pass-through for the charge rings (system or the custom
        // accent color from the Appearance page).
        const useAccentRow = new Adw.SwitchRow({
            title: _('Use accent color'),
            subtitle: _('Charge rings use the accent color instead of the red/orange/green scale'),
        });
        useAccentRow.set_active(settings.get_boolean('battery-use-accent-color'));
        useAccentRow.connect('notify::active', () => {
            settings.set_boolean('battery-use-accent-color', useAccentRow.get_active());
        });

        page.add(group);
        group.add(useAccentRow);
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

        const navButtonsRow = new Adw.SwitchRow({
            title: _('Show navigation buttons'),
            subtitle: _('Previous/next day arrows on the screen time widget.'),
        });
        settings.bind('screentime-show-nav-buttons', navButtonsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(navButtonsRow);

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

        const HOUR_FORMAT_LABELS = [_('24-hour (14:30)'), _('12-hour (2:30 PM)')];
        const HOUR_FORMAT_VALUES = ['24', '12'];
        const hourFormatModel = Gtk.StringList.new(HOUR_FORMAT_LABELS);
        const hourFormatRow = new Adw.ComboRow({
            title: _('Time format'),
            subtitle: _('How event times appear in the calendar'),
            model: hourFormatModel,
        });
        hourFormatRow.set_selected(Math.max(0, HOUR_FORMAT_VALUES.indexOf(settings.get_string('calendar-hour-format'))));
        hourFormatRow.connect('notify::selected', () => {
            settings.set_string('calendar-hour-format', HOUR_FORMAT_VALUES[hourFormatRow.selected] ?? '24');
        });
        group.add(hourFormatRow);

        // First day of the week: the reference widget's enum (locale auto /
        // Sunday / Monday). 0 keeps the locale/GNOME-derived start.
        const FIRST_DAY_LABELS = [
            _('From the locale'),
            _('Sunday'),
            _('Monday'),
        ];
        const firstDayModel = Gtk.StringList.new(FIRST_DAY_LABELS);
        const firstDayRow = new Adw.ComboRow({
            title: _('First day of the week'),
            subtitle: _('Which day starts the calendar weeks'),
            model: firstDayModel,
        });
        firstDayRow.set_selected(settings.get_int('calendar-first-day') ?? 0);
        firstDayRow.connect('notify::selected', () => {
            settings.set_int('calendar-first-day', firstDayRow.selected);
        });
        group.add(firstDayRow);

        // How far ahead the events list looks (reference widget's lookahead
        // idea, plus a "today and tomorrow only" option: 0 = today and
        // tomorrow, 1 = 7, 2 = 14, 3 = 30, 4 = 60 days).
        const LOOKAHEAD_LABELS = [
            _('Today and tomorrow'),
            _('7 days'),
            _('14 days'),
            _('30 days'),
            _('60 days'),
        ];
        const lookaheadModel = Gtk.StringList.new(LOOKAHEAD_LABELS);
        const lookaheadRow = new Adw.ComboRow({
            title: _('Show events for the next'),
            subtitle: _('How far ahead the events list looks'),
            model: lookaheadModel,
        });
        lookaheadRow.set_selected(Math.max(0, Math.min(4, settings.get_int('calendar-lookahead') ?? 3)));
        lookaheadRow.connect('notify::selected', () => {
            settings.set_int('calendar-lookahead', lookaheadRow.selected);
        });
        group.add(lookaheadRow);

        const accentRow = new Adw.SwitchRow({
            title: _('Use accent color'),
            subtitle: _('Use system or custom accent color from Appearance settings. When disabled, uses neutral gray.'),
        });
        accentRow.set_active(settings.get_boolean('calendar-use-accent-color'));
        accentRow.connect('notify::active', () => {
            settings.set_boolean('calendar-use-accent-color', accentRow.get_active());
        });
        group.add(accentRow);

        const pageDotsRow = new Adw.SwitchRow({
            title: _('Show page dots'),
            subtitle: _('Two page-indicator dots at the bottom of the 1x1 calendar'),
        });
        pageDotsRow.set_active(settings.get_boolean('calendar-show-page-dots'));
        pageDotsRow.connect('notify::active', () => {
            settings.set_boolean('calendar-show-page-dots', pageDotsRow.get_active());
        });
        group.add(pageDotsRow);

        const hideDateRow = new Adw.SwitchRow({
            title: _('Hide the date when there are many events'),
            subtitle: _('2x1 calendar: the weekday and day number make room when the events don’t fit below them'),
        });
        settings.bind('calendar-hide-date-many-events', hideDateRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(hideDateRow);

        // Page indicator color: accent when on, neutral theme text when off
        // (white on the dark theme, black on the light one).
        const pageIndicatorAccentRow = new Adw.SwitchRow({
            title: _('Use accent color for page indicator'),
            subtitle: _('Accent color for the page markers. When off, they follow the theme text color.'),
        });
        pageIndicatorAccentRow.set_active(settings.get_boolean('calendar-page-indicator-accent'));
        pageIndicatorAccentRow.connect('notify::active', () => {
            settings.set_boolean('calendar-page-indicator-accent', pageIndicatorAccentRow.get_active());
        });
        group.add(pageIndicatorAccentRow);

        page.add(group);
        return page;
    }

    _createWeatherPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Weather Widget'),
            description: _('Preferences for the weather widget on your desktop.'),
            margin_top: 12,
        });

        const accentRow = new Adw.SwitchRow({
            title: _('Use accent color'),
            subtitle: _('Use system or custom accent color from Appearance settings. When disabled, uses neutral gray.'),
        });
        accentRow.set_active(settings.get_boolean('weather-use-accent-color'));
        accentRow.connect('notify::active', () => {
            settings.set_boolean('weather-use-accent-color', accentRow.get_active());
        });
        group.add(accentRow);

        // 1x1 weather swipe pages (weather ⇄ hourly): page indicators.
        const pageDotsRow = new Adw.SwitchRow({
            title: _('Show page dots'),
            subtitle: _('Two page-indicator dots at the bottom of the 1x1 weather (weather/hourly swipe pages)'),
        });
        pageDotsRow.set_active(settings.get_boolean('weather-show-page-dots'));
        pageDotsRow.connect('notify::active', () => {
            settings.set_boolean('weather-show-page-dots', pageDotsRow.get_active());
        });
        group.add(pageDotsRow);

        const pageIndicatorAccentRow = new Adw.SwitchRow({
            title: _('Use accent color for page indicator'),
            subtitle: _('Accent color for the page markers. When off, they follow the theme text color.'),
        });
        pageIndicatorAccentRow.set_active(settings.get_boolean('weather-page-indicator-accent'));
        pageIndicatorAccentRow.connect('notify::active', () => {
            settings.set_boolean('weather-page-indicator-accent', pageIndicatorAccentRow.get_active());
        });
        group.add(pageIndicatorAccentRow);

        page.add(group);
        return page;
    }

    _createAnalogClockPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Analog Clock Widget'),
            description: _('Appearance of the analog clock on your desktop.'),
            margin_top: 12,
        });

        // Smooth second hand (reference clock-analog parity): ON sweeps the
        // hand continuously (ms fraction), OFF keeps the 1s step.
        const smoothRow = new Adw.SwitchRow({
            title: _('Smooth second hand'),
            subtitle: _('Sweep the second hand continuously; off steps once per second'),
        });
        smoothRow.set_active(settings.get_boolean('clock-smooth-seconds'));
        group.add(smoothRow);
        smoothRow.connect('notify::active', () => {
            settings.set_boolean('clock-smooth-seconds', smoothRow.get_active());
        });

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

        // Smooth second ring toggle (reference clock-digital parity): OFF
        // steps the ring once per second instead of animating every frame.
        const smoothSecondsRow = new Adw.SwitchRow({
            title: _('Smooth second ring'),
            subtitle: _('Animate the ring every frame; off steps it once per second'),
        });
        smoothSecondsRow.set_active(settings.get_boolean('digitalclock-smooth-seconds'));
        group.add(smoothSecondsRow);
        smoothSecondsRow.connect('notify::active', () => {
            settings.set_boolean('digitalclock-smooth-seconds', smoothSecondsRow.get_active());
        });

        page.add(group);
        return page;
    }

    _createBinaryClockPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Binary Clock Widget'),
            description: _('Appearance of the binary clock on your desktop.'),
            margin_top: 12,
        });

        // The lit dots take the accent color (system or the custom one
        // from Appearance settings), or fall back to the neutral look.
        const accentRow = new Adw.SwitchRow({
            title: _('Use accent color'),
            subtitle: _('Use system or custom accent color from Appearance settings. When disabled, uses neutral color (white on dark, black on light).'),
        });
        accentRow.set_active(settings.get_boolean('binaryclock-use-accent-color'));
        accentRow.connect('notify::active', () => {
            settings.set_boolean('binaryclock-use-accent-color', accentRow.get_active());
        });
        group.add(accentRow);

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
            show_apply_button: false,
        });
        usernameRow.set_tooltip_text(_('Applied to all GitHub widgets. Empty to set a username per widget'));
        group.add(usernameRow);

        // Idempotent apply: the checkmark button (accent-color style) and
        // plain Enter both go through this.
        const applyUsername = () => {
            const value = usernameRow.get_text().trim().replace(/^@/, '');

            if (value !== settings.get_string('github-username')) {
                settings.set_string('github-username', value);
            };
        };

        const applyUsernameRow = () => {
            applyUsername();

            // Brief green pulse to confirm the value was committed. Tracked
            // so a closed window cannot let it touch the destroyed button.
            applyUsernameButton.get_style_context().add_class('suggested-action');
            this._trackSource(GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                applyUsernameButton.get_style_context().remove_class('suggested-action');
                return GLib.SOURCE_REMOVE;
            }));
        };

        const applyUsernameButton = new Gtk.Button({
            icon_name: 'object-select-symbolic',
            valign: Gtk.Align.CENTER,
            focusable: false,
        });
        applyUsernameButton.set_tooltip_text(_('Apply username'));
        applyUsernameButton.connect('clicked', applyUsernameRow);
        usernameRow.add_suffix(applyUsernameButton);

        // Enter (main + keypad) applies the username too.
        const usernameKeyController = new Gtk.EventControllerKey();
        usernameKeyController.connect('key-pressed', (_ctrl, keyval) => {
            if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter || keyval === Gdk.KEY_ISO_Enter) {
                applyUsernameRow();
                return false;
            };

            return false;
        });
        usernameRow.add_controller(usernameKeyController);

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

    _createPomodoroPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Pomodoro Widget'),
            description: _('Configure the Pomodoro timer durations and work sessions.'),
            margin_top: 12,
        });

        const workMinutesRow = new Adw.SpinRow({
            title: _('Work duration'),
            subtitle: _('Length of the focus/work phase in minutes'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 90,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('pomodoro-work-minutes'),
            }),
        });
        group.add(workMinutesRow);
        workMinutesRow.connect('notify::value', () => {
            settings.set_int('pomodoro-work-minutes', workMinutesRow.get_value());
        });

        const shortBreakRow = new Adw.SpinRow({
            title: _('Short break duration'),
            subtitle: _('Length of the short break in minutes'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 30,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('pomodoro-short-break-minutes'),
            }),
        });
        group.add(shortBreakRow);
        shortBreakRow.connect('notify::value', () => {
            settings.set_int('pomodoro-short-break-minutes', shortBreakRow.get_value());
        });

        const longBreakRow = new Adw.SpinRow({
            title: _('Long break duration'),
            subtitle: _('Length of the long break in minutes'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('pomodoro-long-break-minutes'),
            }),
        });
        group.add(longBreakRow);
        longBreakRow.connect('notify::value', () => {
            settings.set_int('pomodoro-long-break-minutes', longBreakRow.get_value());
        });

        const sessionsRow = new Adw.SpinRow({
            title: _('Sessions before long break'),
            subtitle: _('Number of completed work sessions before a long break'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 8,
                step_increment: 1,
                page_increment: 1,
                value: settings.get_int('pomodoro-sessions-before-long-break'),
            }),
        });
        group.add(sessionsRow);
        sessionsRow.connect('notify::value', () => {
            settings.set_int('pomodoro-sessions-before-long-break', sessionsRow.get_value());
        });

        page.add(group);
        return page;
    }

    _createSystemMonitorPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('System Monitor Widget'),
            description: _('Preferences for the CPU, RAM, GPU and network widget.'),
            margin_top: 12,
        });

        // Swipe-page dashes at the bottom of the 1x1 and 2x1 sizes.
        const pageDashesRow = new Adw.SwitchRow({
            title: _('Show page dashes'),
            subtitle: _('Swipe-page dashes at the bottom of the system monitor'),
        });
        pageDashesRow.set_active(settings.get_boolean('system-show-page-dashes'));
        pageDashesRow.connect('notify::active', () => {
            settings.set_boolean('system-show-page-dashes', pageDashesRow.get_active());
        });
        group.add(pageDashesRow);

        // Page dash color: accent when on, neutral theme text when off
        // (white on the dark theme, black on the light one).
        const pageIndicatorAccentRow = new Adw.SwitchRow({
            title: _('Use accent color for page indicator'),
            subtitle: _('Accent color for the page dashes. When off, they follow the theme text color.'),
        });
        pageIndicatorAccentRow.set_active(settings.get_boolean('system-page-indicator-accent'));
        pageIndicatorAccentRow.connect('notify::active', () => {
            settings.set_boolean('system-page-indicator-accent', pageIndicatorAccentRow.get_active());
        });
        group.add(pageIndicatorAccentRow);

        page.add(group);
        return page;
    }

    _createLavaPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Lava Lamp Widget'),
            description: _('Configure the appearance of animated lava balls.'),
            margin_top: 12,
        });

        const useAccentRow = new Adw.SwitchRow({
            title: _('Use accent color'),
            subtitle: _('Use system or custom accent color from Appearance settings. When disabled, uses neutral gray.'),
        });
        useAccentRow.set_active(settings.get_boolean('lava-use-accent-color'));
        group.add(useAccentRow);
        useAccentRow.connect('notify::active', () => {
            settings.set_boolean('lava-use-accent-color', useAccentRow.get_active());
        });

        page.add(group);
        return page;
    }

    _createFolderLauncherPage(settings) {
        const page = new Adw.PreferencesPage();

        // Global settings group
        const globalGroup = new Adw.PreferencesGroup({
            title: _('Global Settings'),
            description: _('Settings that apply to all Folder Launcher widgets.'),
            margin_top: 12,
        });

        // Show folder names toggle
        const showNamesRow = new Adw.SwitchRow({
            title: _('Show folder names'),
            subtitle: _('Display folder names below icons'),
        });
        showNamesRow.set_active(settings.get_boolean('folder-show-names'));
        showNamesRow.connect('notify::active', () => {
            settings.set_boolean('folder-show-names', showNamesRow.get_active());
        });
        globalGroup.add(showNamesRow);

        // File manager picker
        const fileManagerRow = new Adw.ComboRow({
            title: _('File Manager'),
            subtitle: _('Application to open folders with'),
        });

        const fileManagers = this._getFileManagers();
        const fileManagerModel = new Gtk.StringList();
        for (const fm of fileManagers) {
            fileManagerModel.append(fm.name);
        }
        fileManagerRow.set_model(fileManagerModel);

        const currentFM = settings.get_string('folder-file-manager');
        const currentIndex = fileManagers.findIndex(fm => fm.id === currentFM);
        fileManagerRow.set_selected(currentIndex >= 0 ? currentIndex : 0);

        fileManagerRow.connect('notify::selected', () => {
            const index = fileManagerRow.get_selected();
            if (index >= 0 && index < fileManagers.length) {
                settings.set_string('folder-file-manager', fileManagers[index].id);
            }
        });
        globalGroup.add(fileManagerRow);

        page.add(globalGroup);

        // Per-widget folders configuration
        const groups = [];

        const rebuild = () => {
            for (const group of groups) {
                if (group.get_parent())
                    page.remove(group);
            }
            groups.length = 0;

            const widgets = layoutWidgets(settings);
            const folderWidgets = widgets.filter(w => w.type === 'folder');

            if (folderWidgets.length === 0) {
                const group = new Adw.PreferencesGroup({
                    title: _('Folder Launcher Widgets'),
                    description: _('Manage folders for each widget. Changes apply instantly.'),
                    margin_top: 12,
                });

                group.add(new Adw.ActionRow({
                    title: _('No Folder Launcher widgets found'),
                    subtitle: _('Add a Folder Launcher widget from the General page first'),
                }));
                groups.push(group);
                page.add(group);
                return;
            }

            for (const widget of folderWidgets) {
                const group = this._buildFolderLauncherWidgetGroup(widget);
                groups.push(group);
                page.add(group);
            }
        };

        rebuild();

        const signalId = settings.connect('changed::layout-json', rebuild);
        page.connect('destroy', () => settings.disconnect(signalId));

        return page;
    }

    _getFileManagers() {
        const fileManagers = [
            { id: 'org.gnome.Nautilus.desktop', name: 'Files (Nautilus)' },
            { id: 'nemo.desktop', name: 'Nemo' },
            { id: 'thunar.desktop', name: 'Thunar' },
            { id: 'dolphin.desktop', name: 'Dolphin' },
            { id: 'pcmanfm.desktop', name: 'PCManFM' },
        ];

        // Filter to only installed file managers
        return fileManagers.filter(fm => {
            try {
                const appInfo = Gio.DesktopAppInfo.new(fm.id);
                return appInfo !== null;
            } catch (e) {
                return false;
            }
        });
    }

    _buildFolderLauncherWidgetGroup(widget) {
        const widgetGroup = new Adw.PreferencesGroup({
            title: `${_('Widget')}: ${widget.id}`,
            margin_top: 12,
        });

        const foldersExpander = new Adw.ExpanderRow({
            title: _('Pinned Folders'),
            subtitle: _('Folders shown on this widget, in grid order'),
        });

        const dataFilePath = this._folderLauncherFilePath(widget.id);
        const selectedFolders = this._loadFolderLauncherFolders(dataFilePath);

        // Defaults only apply when the widget was never saved
        if (selectedFolders.length === 0
            && !GLib.file_test(dataFilePath, GLib.FileTest.EXISTS)) {
            selectedFolders.push(
                { path: GLib.get_home_dir(), name: _('Home') },
                { path: GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) || GLib.get_home_dir(), name: _('Documents') },
                { path: GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) || GLib.get_home_dir(), name: _('Downloads') },
                { path: GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir(), name: _('Pictures') }
            );
        }

        const saveFolders = () => {
            const data = { folders: selectedFolders };
            try {
                GLib.file_set_contents(dataFilePath, JSON.stringify(data, null, 2));
            } catch (e) {
                console.error('Failed to save folders:', e);
            }
        };

        const reorderFolder = (index, delta) => {
            const to = index + delta;
            if (index < 0 || to < 0 || to >= selectedFolders.length) return;
            [selectedFolders[index], selectedFolders[to]] = [selectedFolders[to], selectedFolders[index]];
            saveFolders();
            renderPinnedFolders();
        };

        let builtRows = [];

        const renderPinnedFolders = () => {
            for (const row of builtRows) {
                if (row && row.get_parent())
                    foldersExpander.remove(row);
            }
            builtRows.length = 0;

            foldersExpander.set_subtitle(`${_('Folders')}: ${selectedFolders.length}`);
            const lastIndex = selectedFolders.length - 1;

            for (let index = 0; index < selectedFolders.length; index++) {
                const folder = selectedFolders[index];
                const folderRow = new Adw.ActionRow({
                    title: folder.name || GLib.path_get_basename(folder.path),
                    subtitle: folder.path,
                });

                const icon = new Gtk.Image({
                    icon_name: 'folder-symbolic',
                    pixel_size: 32,
                });
                folderRow.add_prefix(icon);

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
                    upButton.connect('clicked', () => reorderFolder(index, -1));
                    reorderBox.append(upButton);
                }

                if (index < lastIndex) {
                    const downButton = new Gtk.Button({
                        icon_name: 'go-down-symbolic',
                        valign: Gtk.Align.CENTER,
                        css_classes: ['flat'],
                        tooltip_text: _('Move down'),
                    });
                    downButton.connect('clicked', () => reorderFolder(index, 1));
                    reorderBox.append(downButton);
                }

                folderRow.add_suffix(reorderBox);

                const removeButton = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat', 'error'],
                    tooltip_text: _('Remove'),
                });
                removeButton.connect('clicked', () => {
                    selectedFolders.splice(index, 1);
                    saveFolders();
                    renderPinnedFolders();
                });
                folderRow.add_suffix(removeButton);

                foldersExpander.add_row(folderRow);
                builtRows.push(folderRow);
            }
        };

        renderPinnedFolders();

        // Add folder button
        const addButton = new Gtk.Button({
            label: _('Add Folder'),
            css_classes: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        addButton.connect('clicked', () => {
            this._openFolderChooser((folderPath, folderName) => {
                selectedFolders.push({ path: folderPath, name: folderName });
                saveFolders();
                renderPinnedFolders();
            });
        });
        foldersExpander.add_action(addButton);

        widgetGroup.add(foldersExpander);
        return widgetGroup;
    }

    _folderLauncherFilePath(widgetId) {
        const dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'desktop-widgets@r3nhick', 'folder']);
        GLib.mkdir_with_parents(dataDir, 0o755);
        return GLib.build_filenamev([dataDir, `folder-${widgetId}.json`]);
    }

    _loadFolderLauncherFolders(dataFilePath) {
        const folders = [];
        try {
            if (GLib.file_test(dataFilePath, GLib.FileTest.EXISTS)) {
                const [success, contents] = GLib.file_get_contents(dataFilePath);
                if (success) {
                    const data = JSON.parse(new TextDecoder().decode(contents));
                    if (Array.isArray(data.folders)) {
                        for (const folder of data.folders) {
                            if (!folder.path) continue;
                            folders.push(folder);
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Failed to load folders:', e);
        }
        return folders;
    }

    _openFolderChooser(callback) {
        const chooser = new Gtk.FileChooserNative({
            title: _('Select Folder'),
            action: Gtk.FileChooserAction.SELECT_FOLDER,
            transient_for: this._window,
            accept_label: _('Select'),
            cancel_label: _('Cancel'),
        });

        chooser.connect('response', (dialog, response) => {
            if (response === Gtk.ResponseType.ACCEPT) {
                const file = dialog.get_file();
                if (file) {
                    const folderPath = file.get_path();
                    const folderName = GLib.path_get_basename(folderPath);
                    callback(folderPath, folderName);
                }
            }
        });

        chooser.show();
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

        // Layout: [style cards] → [Widget Styling] → [Glass params] →
        // [Solid params]. The glass/solid groups are toggled by the selected
        // card and sit at the bottom of the page, below the shared styling.
        const styleGroup = new Adw.PreferencesGroup({
            title: _('Widget Style'),
            margin_top: 12,
        });

        const glassGroup = new Adw.PreferencesGroup({
            title: _('Glass'),
            description: _('Live blurred wallpaper backdrop, refraction and highlights.'),
        });

        const solidGroup = new Adw.PreferencesGroup({
            title: _('Solid'),
            description: _('Classic opaque background with a border.'),
        });

        const group = new Adw.PreferencesGroup({
            title: _('Widget Styling'),
            description: _('Shared options for both styles.'),
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
        // Shared with the Glass style too: both widget frames use these keys.
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
            _('Choose background color (also used as the glass tint in Glass style)'),
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

        // Style mode: two preview cards side by side (Glass | Solid) instead
        // of a dropdown — the selected one is outlined with the accent color,
        // and the settings section switches to that style.
        const cardCss = new Gtk.CssProvider();
        cardCss.load_from_string(`
            .dw-style-card {
                padding: 8px;
                border-radius: 14px;
                border: 2px solid transparent;
            }
            .dw-style-card:checked {
                border-color: @accent_bg_color;
                background-color: color-mix(in srgb, @accent_bg_color 12%, transparent);
            }
        `);

        // Preview = an EMPTY 2×1 widget in each style (no fake wallpaper or
        // content bars — those read like a photo). Corners follow the
        // Border Radius setting, scaled to the preview size.
        const drawStylePreview = (cr, width, height, kind) => {
            const R = (x, y, w, h, r) => {
                r = Math.max(0, Math.min(r, w / 2, h / 2));
                cr.newPath();
                if (r <= 0) {
                    cr.rectangle(x, y, w, h);
                    return;
                }
                cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
                cr.arc(x + w - r, y + r, r, 1.5 * Math.PI, 2 * Math.PI);
                cr.arc(x + w - r, y + h - r, r, 0, 0.5 * Math.PI);
                cr.arc(x + r, y + h - r, r, 0.5 * Math.PI, Math.PI);
                cr.closePath();
            };

            // 2×1 widget proportions (395×190), centered in the preview.
            const paneH = height - 4;
            const paneW = Math.min(width - 4, Math.round(paneH * 395 / 190));
            const paneX = Math.round((width - paneW) / 2) + 0.5;
            const paneY = 2.5;
            const radius = settings.get_int('style-border-radius') * (paneH / 190);

            R(paneX, paneY, paneW, paneH, radius);
            if (kind === 'glass') {
                // Liquid glass: what is behind the pane shows only THROUGH it
                // (soft color blobs, magnified at the center and bent at the
                // rim), a bright specular rim at the top-left, a softer one
                // at the bottom-right, and a glossy sheen on top.
                const cy = paneY + paneH / 2;
                cr.save();
                R(paneX, paneY, paneW, paneH, radius);
                cr.clip();

                // Backdrop seen through the glass.
                const blob = (x, y, r, rgb, a) => {
                    const g = new cairo.RadialGradient(x, y, 0, x, y, r);
                    g.addColorStopRGBA(0, ...rgb, a);
                    g.addColorStopRGBA(1, ...rgb, 0);
                    cr.setSource(g);
                    cr.rectangle(paneX, paneY, paneW, paneH);
                    cr.fill();
                };
                cr.setSourceRGBA(1, 1, 1, 0.06);
                cr.paint();
                blob(paneX + paneW * 0.28, paneY + paneH * 0.70, paneH * 0.75, [0.35, 0.62, 1.0], 0.55);
                blob(paneX + paneW * 0.78, paneY + paneH * 0.30, paneH * 0.70, [1.0, 0.55, 0.75], 0.45);
                blob(paneX + paneW * 0.55, paneY + paneH * 0.95, paneH * 0.55, [0.55, 1.0, 0.85], 0.30);

                // Refraction band: the edge bends light — a bright inner
                // ring fading toward the center, with a faint color fringe.
                for (let i = 0; i < 5; i++) {
                    const inset = 1.5 + i * 1.6;
                    R(paneX + inset, paneY + inset, paneW - inset * 2, paneH - inset * 2, Math.max(0, radius - inset));
                    cr.setLineWidth(1.6);
                    cr.setSourceRGBA(1, 1, 1, 0.16 * (1 - i / 5));
                    cr.stroke();
                }
                R(paneX + 2.2, paneY + 2.2, paneW - 4.4, paneH - 4.4, Math.max(0, radius - 2.2));
                cr.setLineWidth(1);
                cr.setSourceRGBA(0.55, 0.85, 1.0, 0.22);
                cr.stroke();

                // Glossy sheen across the top.
                const sheen = new cairo.LinearGradient(0, paneY, 0, cy);
                sheen.addColorStopRGBA(0, 1, 1, 1, 0.30);
                sheen.addColorStopRGBA(1, 1, 1, 1, 0);
                cr.setSource(sheen);
                cr.rectangle(paneX, paneY, paneW, paneH / 2);
                cr.fill();
                cr.restore();

                // Specular rim: strong top-left, softer bottom-right.
                const rim = new cairo.LinearGradient(paneX, paneY, paneX + paneW, paneY + paneH);
                rim.addColorStopRGBA(0, 1, 1, 1, 0.95);
                rim.addColorStopRGBA(0.35, 1, 1, 1, 0.25);
                rim.addColorStopRGBA(0.65, 1, 1, 1, 0.15);
                rim.addColorStopRGBA(1, 1, 1, 1, 0.70);
                R(paneX, paneY, paneW, paneH, radius);
                cr.setSource(rim);
                cr.setLineWidth(1.2);
                cr.stroke();
            } else {
                cr.setSourceRGB(0.14, 0.14, 0.15);
                cr.fillPreserve();
                cr.setSourceRGBA(1, 1, 1, 0.16);
                cr.setLineWidth(1);
                cr.stroke();
            }
        };

        const makeStyleCard = (kind, title, subtitle) => {
            const card = new Gtk.ToggleButton({
                css_classes: ['card', 'dw-style-card'],
                hexpand: true,
            });
            card.get_style_context().add_provider(cardCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1);

            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 6,
                margin_start: 6,
                margin_end: 6,
                margin_top: 4,
                margin_bottom: 4,
            });

            const preview = new Gtk.DrawingArea({
                height_request: 56,
            });
            preview.set_draw_func((_widget, cr, width, height) => {
                drawStylePreview(cr, width, height, kind);
            });
            this._trackSignal(settings, settings.connect('changed::style-border-radius', () => preview.queue_draw()));
            box.append(preview);

            const nameLabel = new Gtk.Label({
                use_markup: true,
                label: `<b>${title}</b>`,
            });
            box.append(nameLabel);

            const subLabel = new Gtk.Label({
                label: subtitle,
                wrap: true,
                wrap_mode: 1, // WORD
                justify: 2,   // CENTER
                css_classes: ['dim-label'],
            });
            box.append(subLabel);

            card.child = box;
            return card;
        };

        const glassCard = makeStyleCard('glass', _('Glass'),
            _('Blurred wallpaper backdrop, refraction, specular highlights'));
        const solidCard = makeStyleCard('solid', _('Solid'),
            _('Opaque background, classic desktop look'));
        solidCard.group = glassCard;

        const syncStyleVisibility = () => {
            const glass = settings.get_int('style-mode') === 0;
            glassCard.active = glass;
            solidCard.active = !glass;
            glassGroup.visible = glass;
            solidGroup.visible = !glass;
        };
        syncStyleVisibility();

        glassCard.connect('toggled', () => {
            if (glassCard.active && settings.get_int('style-mode') !== 0) {
                settings.set_int('style-mode', 0);
            };
        });
        solidCard.connect('toggled', () => {
            if (solidCard.active && settings.get_int('style-mode') !== 1) {
                settings.set_int('style-mode', 1);
            };
        });
        // Reset Style (and any external change) re-syncs the cards too.
        settings.connect('changed::style-mode', syncStyleVisibility);

        const cardsRow = new Adw.PreferencesRow({
            activatable: false,
        });
        cardsRow.child = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            homogeneous: true,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8,
        });
        cardsRow.child.append(glassCard);
        cardsRow.child.append(solidCard);
        styleGroup.add(cardsRow);

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

        // Helper for the integer glass parameters — slider rows like in the
        // liquidglass-widgets extension: value scale + right-aligned value
        // label instead of the +/- SpinRows. All values stay ints in the
        // schema; the title/subtitle carries any ×10/×100 scale.
        const addGlassSlider = (title, subtitle, key, lower, upper, format) => {
            const adjustment = new Gtk.Adjustment({
                lower,
                upper,
                step_increment: 1,
                page_increment: 10,
            });
            adjustment.value = settings.get_int(key);

            const scale = new Gtk.Scale({
                adjustment,
                draw_value: false,
                hexpand: true,
                valign: Gtk.Align.CENTER,
                width_request: 220,
            });
            // Signal the shell while a slider is being dragged so it can defer
            // widget re-renders until the handle is actually released (same as
            // widget opacity below). No Double writes here: the glass keys are
            // ints and the debounced set below is the only writer.
            const drag = new Gtk.GestureClick();
            drag.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
            drag.connect('pressed', () => settings.set_boolean('drag-active', true));
            drag.connect('released', () => settings.set_boolean('drag-active', false));
            drag.connect('stopped', () => settings.set_boolean('drag-active', false));
            scale.add_controller(drag);

            const value = new Gtk.Label({
                width_chars: 7,
                xalign: 1,
                css_classes: ['dim-label', 'numeric'],
            });
            value.label = format(Math.round(adjustment.value));

            const row = new Adw.ActionRow({title, subtitle});
            row.add_suffix(scale);
            row.add_suffix(value);

            scale.connect('value-changed', () => {
                const v = Math.round(scale.get_value());
                value.label = format(v);
                this._debounce(key, () => {
                    settings.set_int(key, v);
                }, 120);
            });

            // External changes (Reset Style) move the slider back.
            settings.connect(`changed::${key}`, () => {
                adjustment.value = settings.get_int(key);
                value.label = format(settings.get_int(key));
            });

            // Glass-specific rows live in the Glass group so the whole
            // section (sliders + GPU warning) hides together on Solid.
            glassGroup.add(row);
            return row;
        };

        // GPU warning: always visible above the glass controls.
        // Must be a PreferencesRow: plain widgets are added to a separate
        // box below the group's listbox, so they always render at the very
        // bottom of the group regardless of add order.
        const glassGpuWarningRow = new Adw.ActionRow({
            title: _('⚠ Warning: Glass Style increases GPU usage'),
            subtitle: _('Glass widgets render a blurred wallpaper backdrop and a shader every frame, which raises GPU load. If the desktop becomes slow or your GPU heats up, switch to Solid style.'),
        });
        // First row of the Glass group (rows render in add order), so the
        // warning is read before the sliders; it hides with the group.
        glassGroup.add(glassGpuWarningRow);

        const blurRow = addGlassSlider(
            _('Blur Radius'),
            _('Background blur radius in pixels (0–60)'),
            'blur-radius-px', 0, 60,
            v => `${v} px`);
        // Roundness removed - now uses fixed squircle shape (6.1) with border-radius
        const refractThicknessRow = addGlassSlider(
            _('Refraction Thickness'),
            _('Width of the refracting edge band in pixels (0 disables refraction)'),
            'refract-thickness', 0, 100,
            v => `${v} px`);
        const refractIORRow = addGlassSlider(
            _('Refraction IOR (×100)'),
            _('Index of refraction: 100 = no bending, 170 ≈ glass'),
            'refract-ior-x100', 100, 300,
            v => (v / 100).toFixed(2));
        const refractScaleRow = addGlassSlider(
            _('Refraction Scale'),
            _('How far the edge displaces the wallpaper (0–200)'),
            'refract-scale', 0, 200,
            v => `${v} px`);
        const chromaRow = addGlassSlider(
            _('Chromatic Aberration (%)'),
            _('Rainbow fringing along the refracting edge (0–100)'),
            'chroma-strength-pct', 0, 100,
            v => `${v}%`);
        const tintAlphaRow = addGlassSlider(
            _('Tint Opacity (%)'),
            _('How strongly the glass tint colours the backdrop (0–100)'),
            'tint-alpha-pct', 0, 100,
            v => `${v}%`);
        const specRow = addGlassSlider(
            _('Specular Highlights (%)'),
            _('Strength of the glossy edge and cursor highlights (0–100)'),
            'spec-strength-pct', 0, 100,
            v => `${v}%`);

        glassGroup.visible = settings.get_int('style-mode') === 0;
        solidGroup.visible = !glassGroup.visible;


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
        solidGroup.add(shadowSizeRow);

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
        solidGroup.add(shadowRow);

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
            // The reset only touches the CURRENT style's parameters — the
            // chosen style itself stays as-is (a Solid reset must not flip
            // to Glass).
            this._resetting = true;

            const isGlass = settings.get_int('style-mode') === 0;

            // Common settings.
            settings.set_double('style-widget-opacity', 1.0);
            settings.set_string('style-background', '');
            settings.set_string('style-border-color', '');
            settings.set_boolean('style-use-custom-accent', false);
            settings.set_string('style-accent-color', '');
            settings.set_int('appearance', 2);
            // Both widget frames (Glass and Solid) share these keys.
            settings.set_int('style-border-radius', 16);
            settings.set_int('style-border-width', 1);

            if (isGlass) {
                settings.set_int('blur-radius-px', 6);
                settings.set_int('refract-thickness', 35);
                settings.set_int('refract-ior-x100', 170);
                settings.set_int('refract-scale', 65);
                settings.set_int('chroma-strength-pct', 30);
                settings.set_int('tint-alpha-pct', 10);
                settings.set_int('spec-strength-pct', 70);
            } else {
                settings.set_int('style-shadow-size', 24);
                settings.set_string('style-shadow', '');
            }

            // Reset UI controls
            radiusRow.set_value(16);
            borderWidthRow.set_value(1);
            shadowSizeRow.set_value(24);
            opacityScale.set_value(1.0);
            customAccentRow.set_active(false);
            accentColorRow.sensitive = false;
            for (const colorRow of [bgColorRow, borderColorRow, accentColorRow, shadowRow]) {
                const rgba = new Gdk.RGBA();
                rgba.parse(colorRow._fallbackColor);
                colorRow._colorButton.set_rgba(rgba);
            }

            this._resetting = false;
        });
        group.add(resetStyleRow);

        // Shared options on top; the Glass | Solid parameter groups (toggled
        // by the cards) come last, at the bottom of the page.
        page.add(styleGroup);
        page.add(group);
        page.add(glassGroup);
        page.add(solidGroup);
        // Re-assert the section visibility after the groups are parented, so
        // Solid never flashes (or sticks with) the Glass settings.
        syncStyleVisibility();
        return page;
    }

    _createAboutPage(settings, window) {
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
        const logo = new Gtk.Image({
            icon_name: 'org.gnome.Extensions-symbolic',
            pixel_size: 128,
            margin_bottom: 6,
        });
        headerBox.append(logo);
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
        page.add(group);

        // Updates, help and the bug report — the Isle-style block.
        const helpGroup = new Adw.PreferencesGroup();
        for (const row of this._updateRows(settings, window, version))
            helpGroup.add(row);
        helpGroup.add(this._aboutLinkRow(
            _('Website'),
            'dw-share-2',
            'https://github.com/r3nhick/desktop-widgets',
            _('Features, installing and updating')
        ));
        helpGroup.add(this._aboutLinkRow(
            _('Report a problem'),
            'dw-bug',
            'https://github.com/r3nhick/desktop-widgets/issues/new',
            _('On GitHub; paste the report below in it')
        ));
        const reportRow = new Adw.ActionRow({
            title: _('Copy a bug report'),
            subtitle: _('What’s installed, your widgets and recent errors, ready to paste into a report'),
            activatable: true,
        });
        reportRow.add_suffix(new Gtk.Image({icon_name: 'edit-copy-symbolic', valign: Gtk.Align.CENTER}));
        reportRow.connect('activated', () => this._copyBugReport(settings, window, reportRow));
        helpGroup.add(reportRow);
        helpGroup.add(this._aboutLinkRow(
            _('License'),
            'dw-scale',
            'https://github.com/r3nhick/desktop-widgets/blob/main/LICENSE',
            _('GNU General Public License, version 3 or later')
        ));
        page.add(helpGroup);

        // Reset everything but the widgets themselves.
        const resetGroup = new Adw.PreferencesGroup({title: _('Settings')});
        const resetRow = new Adw.ActionRow({
            title: _('Reset all settings'),
            subtitle: _('Back to the defaults; your widgets and their places stay'),
            activatable: true,
        });
        resetRow.connect('activated', () => {
            const dialog = new Adw.AlertDialog({
                heading: _('Reset all settings?'),
                body: _('Every option goes back to its default. Your widgets, their places and their content stay.'),
            });
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('reset', _('Reset'));
            dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_default_response('cancel');
            dialog.set_close_response('cancel');
            dialog.connect('response', (_d, response) => {
                if (response !== 'reset')
                    return;
                // Not options: the widgets' layout and internal state.
                const keep = new Set(['layout-json', 'edit-mode', 'drag-active', 'open-prefs-page',
                    'open-widget-picker', 'update-latest', 'update-url', 'update-checked-at', 'update-shown']);
                for (const key of settings.settings_schema.list_keys()) {
                    if (!keep.has(key))
                        settings.reset(key);
                }
            });
            dialog.present(window);
        });
        resetGroup.add(resetRow);
        page.add(resetGroup);
        return page;
    }

    // ── Updates (About page) ──────────────────────────────────────────────
    // The status row + the opt-in switch. The shell side (lib/updates.js)
    // asks GitHub once a day and stores what it found in settings; this row
    // follows those keys. A git checkout updates in one click (git pull);
    // otherwise the row links to the download.
    _updateRows(settings, window, version) {
        const dir = this.path;
        const isGit = GLib.file_test(GLib.build_filenamev([dir, '.git']), GLib.FileTest.EXISTS);
        const repoUrl = 'https://github.com/r3nhick/desktop-widgets';

        const isNewer = (a, b) => {
            const parts = v => String(v ?? '').replace(/^v/i, '').split('.').map(p => parseInt(p, 10) || 0);
            const [x, y] = [parts(a), parts(b)];
            for (let i = 0; i < Math.max(x.length, y.length); i++) {
                if ((x[i] ?? 0) !== (y[i] ?? 0))
                    return (x[i] ?? 0) > (y[i] ?? 0);
            }
            return false;
        };
        // The version on disk: after an update it is the new one while the
        // shell still runs the old one until the next login.
        const installedVersion = () => {
            try {
                const [, bytes] = Gio.File.new_for_path(GLib.build_filenamev([dir, 'metadata.json'])).load_contents(null);
                return JSON.parse(new TextDecoder().decode(bytes))['version-name'] ?? '';
            } catch (_e) {
                return '';
            }
        };
        const checkedWhen = ms => {
            const then = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
            const now = GLib.DateTime.new_now_local();
            const days = now.get_day_of_year() - then.get_day_of_year()
                + 365 * (now.get_year() - then.get_year());
            return days <= 0 ? _('today') : days === 1 ? _('yesterday') : then.format('%e %b').trim();
        };

        // Texts may come from GitHub / git output: never markup.
        const status = new Adw.ActionRow({use_markup: false});
        const icon = new Gtk.Image({valign: Gtk.Align.CENTER});
        const spinner = new Gtk.Spinner({valign: Gtk.Align.CENTER, spinning: true, visible: false});
        status.add_prefix(icon);
        status.add_prefix(spinner);

        const button = (label, css) => new Gtk.Button({label, valign: Gtk.Align.CENTER, css_classes: css, visible: false});
        const download = button(_('Download'), []);
        download.connect('clicked', () => new Gtk.UriLauncher({
            uri: settings.get_string('update-url') || repoUrl,
        }).launch(window, null, null));
        const update = button(_('Update'), ['suggested-action']);
        const logOut = button(_('Log Out'), ['suggested-action']);
        logOut.connect('clicked', () => {
            Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
                'org.gnome.SessionManager', 'Logout', new GLib.Variant('(u)', [0]), null,
                Gio.DBusCallFlags.NONE, -1, null, (bus, res) => {
                    try {
                        bus.call_finish(res);
                    } catch (_e) {
                        GLib.spawn_async(null, ['gnome-session-quit', '--logout'], null, GLib.SpawnFlags.SEARCH_PATH, null);
                    }
                });
        });
        const suffixes = [download, update, logOut];
        for (const suffix of suffixes)
            status.add_suffix(suffix);

        const check = new Adw.SwitchRow({
            title: _('Check for new versions'),
            subtitle: _('Asks GitHub once a day; nothing else is sent'),
        });
        settings.bind('check-updates', check, 'active', Gio.SettingsBindFlags.DEFAULT);

        let updating = false;
        let failure = null;
        const show = (iconName, css, title, subtitle, buttons = []) => {
            icon.icon_name = iconName ?? '';
            icon.css_classes = css;
            icon.visible = !updating;
            spinner.visible = updating;
            status.title = title;
            status.subtitle = subtitle;
            for (const suffix of suffixes)
                suffix.visible = buttons.includes(suffix);
        };

        const sync = () => {
            const on = settings.get_boolean('check-updates');
            const latest = settings.get_string('update-latest');
            const checkedAt = Number(settings.get_int64('update-checked-at'));
            const installed = installedVersion();

            if (updating) {
                show(null, [], _('Updating to Desktop Widgets %s…').format(latest), _('Downloading from GitHub'));
            } else if (failure) {
                update.label = _('Try Again');
                show('dialog-warning-symbolic', ['warning'], _('Couldn’t update'), failure, [download, update]);
            } else if (installed && isNewer(installed, version)) {
                show('object-select-symbolic', ['success'], _('Desktop Widgets %s is installed').format(installed),
                    _('Log out and back in to finish'), [logOut]);
            } else if (!on) {
                show('software-update-available-symbolic', ['dim-label'], _('Not checking for new versions'),
                    _('Turn it on below to hear when one is out'));
            } else if (latest && isNewer(latest, version)) {
                update.label = _('Update');
                show('software-update-available-symbolic', ['accent'], _('Desktop Widgets %s is out').format(latest),
                    isGit ? _('Your widgets and settings stay') : _('Download it from GitHub'),
                    isGit ? [update] : [download]);
            } else if (checkedAt > 0 && latest) {
                show('object-select-symbolic', ['success'], _('You’re up to date'),
                    _('Checked %s').format(checkedWhen(checkedAt)));
            } else {
                show('software-update-available-symbolic', ['dim-label'], _('Not checked yet'),
                    _('Desktop Widgets asks GitHub once a day'));
            }
        };

        // One-click update for a git checkout: fast-forward only, so local
        // edits are never overwritten (git refuses and says why).
        update.connect('clicked', () => {
            if (updating || !isGit)
                return;
            updating = true;
            failure = null;
            sync();
            const run = (argv, done) => {
                try {
                    const proc = Gio.Subprocess.new(argv,
                        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
                    proc.communicate_utf8_async(null, null, (p, res) => {
                        let out = '';
                        try {
                            [, out] = p.communicate_utf8_finish(res);
                        } catch (e) {
                            out = String(e.message ?? e);
                        }
                        done(p.get_successful(), (out ?? '').trim());
                    });
                } catch (e) {
                    done(false, String(e.message ?? e));
                }
            };
            run(['git', '-C', dir, 'pull', '--ff-only'], (ok, out) => {
                if (!ok) {
                    updating = false;
                    const line = out.split('\n').filter(l => l.trim()).pop() ?? '';
                    failure = /local changes|would be overwritten|uncommitted/i.test(out)
                        ? _('This copy has local changes; git didn’t overwrite them. Commit or stash them, or download instead')
                        : /could not resolve|unable to access|network/i.test(out)
                            ? _('GitHub couldn’t be reached; try again later')
                            : (line || _('git pull failed'));
                    sync();
                    return;
                }
                // git succeeded but the files on disk are still not newer
                // (already at GitHub's commit, or a local edit of
                // metadata.json): say so instead of silently falling back
                // to «is out» as if nothing had happened.
                if (!isNewer(installedVersion(), version)) {
                    updating = false;
                    failure = /up to date/i.test(out)
                        ? _('This copy already matches GitHub; nothing new was downloaded. Check metadata.json for local edits')
                        : _('git finished, but the version on disk didn’t change');
                    sync();
                    return;
                }
                // New keys may come with the update: compile the schema.
                run(['glib-compile-schemas', GLib.build_filenamev([dir, 'schemas'])], () => {
                    updating = false;
                    sync();
                });
            });
        });

        const ids = ['check-updates', 'update-latest', 'update-checked-at'].map(key =>
            settings.connect(`changed::${key}`, () => sync()));
        for (const id of ids)
            this._trackSignal(settings, id);
        sync();
        return [status, check];
    }

    // Builds a plain-text report (versions, system, widgets, changed
    // settings, recent errors) and puts it on the clipboard. Personal values
    // (user names, places, paths) are left out.
    async _copyBugReport(settings, window, row) {
        const original = row.subtitle;
        const lines = [];
        const version = this.metadata['version-name'] ?? String(this.metadata.version ?? '');
        lines.push(`Desktop Widgets ${version} (version ${this.metadata.version ?? '?'})`);
        try {
            const Config = await import('resource:///org/gnome/Shell/Extensions/js/misc/config.js');
            lines.push(`GNOME Shell ${Config.PACKAGE_VERSION}`);
        } catch (_e) {
            lines.push('GNOME Shell: unknown');
        }
        try {
            const [, bytes] = Gio.File.new_for_path('/etc/os-release').load_contents(null);
            const pretty = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(new TextDecoder().decode(bytes))?.[1];
            if (pretty)
                lines.push(`OS: ${pretty}`);
        } catch (_e) {}
        lines.push(`Session: ${GLib.getenv('XDG_SESSION_TYPE') ?? '?'}, desktop: ${GLib.getenv('XDG_CURRENT_DESKTOP') ?? '?'}`);
        lines.push(`Install: ${GLib.file_test(GLib.build_filenamev([this.path, '.git']), GLib.FileTest.EXISTS) ? 'git checkout' : 'package'}`);
        lines.push(`Style: ${settings.get_int('style-mode') === 0 ? 'Glass' : 'Solid'}`);

        try {
            const doc = JSON.parse(settings.get_string('layout-json') || '{}');
            const widgets = (doc.widgets ?? []).map(w => `${w.type}${w.size ? ` (${w.size})` : ''}`);
            lines.push(`Widgets (${widgets.length}): ${widgets.join(', ') || 'none'}`);
        } catch (_e) {
            lines.push('Widgets: layout unreadable');
        }

        const personal = /username|location|photo|path|custom-app|file-manager|binding|theme-|layout|update-/;
        const changed = settings.settings_schema.list_keys()
            .filter(key => settings.get_user_value(key) !== null && !personal.test(key))
            .sort()
            .map(key => `  ${key} = ${settings.get_value(key).print(false)}`);
        lines.push(changed.length ? `Changed settings:\n${changed.join('\n')}` : 'Changed settings: none');

        // Recent errors of this extension from the user's journal.
        const journal = await new Promise(resolve => {
            try {
                const proc = Gio.Subprocess.new(
                    ['journalctl', '--user', '-b', '--no-pager', '-o', 'short-monotonic', '-n', '3000'],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        const [, out] = p.communicate_utf8_finish(res);
                        resolve(out ?? '');
                    } catch (_e) {
                        resolve('');
                    }
                });
            } catch (_e) {
                resolve('');
            }
        });
        const recent = journal.split('\n')
            .filter(l => /desktop-widgets/i.test(l) && /(error|warn|exception|failed|critical)/i.test(l))
            .slice(-30)
            // Strip the home folder from paths.
            .map(l => l.split(GLib.get_home_dir()).join('~'));
        lines.push(recent.length ? `Recent errors:\n${recent.join('\n')}` : 'Recent errors: none found');

        window.get_display().get_clipboard().set(lines.join('\n'));
        row.subtitle = _('Copied — paste it into the report on GitHub');
        this._trackSource(GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
            row.subtitle = original;
            return GLib.SOURCE_REMOVE;
        }));
    }

    /**
     * A link row on the About page.
     * `iconName` is the base name of our icon (no theme suffix), from
     * `icons/settings/`. GTK does not look these up in the icon theme (no -symbolic),
     * so we load the file directly and pick -light/-dark by theme.
     */
    _aboutLinkRow(title, iconName, url, subtitle) {
        const row = new Adw.ActionRow({
            title: title,
            activatable: true,
        });

        if (subtitle) {
            row.set_subtitle(subtitle);
        }

        const icon = new Gtk.Image({
            valign: Gtk.Align.CENTER,
        });
        const applyIcon = () => {
            const dark = Adw.StyleManager.get_default().dark;
            const file = settingsIconPath(`${iconName}-${dark ? 'dark' : 'light'}`);

            if (file && Gio.File.new_for_path(file).query_exists(null))
                icon.set_from_file(file);
            else
                icon.set_from_icon_name(iconName); // fallback for third-party icons
        };
        applyIcon();
        // Theme flips after the window closes would call set_from_file on a
        // destroyed Gtk.Image: tracked like every other page signal.
        const applyIconId = Adw.StyleManager.get_default().connect('notify::dark', applyIcon);
        this._trackSignal(Adw.StyleManager.get_default(), applyIconId);
        row.add_prefix(icon);

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