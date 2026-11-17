// Update check (shell side), modelled on Isle's About page: when the user
// turns "Check for new versions" on, GitHub is asked once a day whether a
// newer Desktop Widgets is out. Nothing else is sent — only an anonymous GET
// for public release metadata. A newer version is announced once with a
// notification; Settings → About shows the details and how to update.
//
// Source of truth: the latest GitHub release; while the repository has no
// releases yet, the version-name in metadata.json on the main branch.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const REPO = 'r3nhick/desktop-widgets';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const MAIN_METADATA = `https://raw.githubusercontent.com/${REPO}/main/metadata.json`;
const REPO_URL = `https://github.com/${REPO}`;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
// How often the shell looks whether a day has passed (cheap: no network).
const WAKE_SECONDS = 60 * 60;

/** Whether version `a` ("2.1.0") is newer than `b`, number by number. */
export function isNewer(a, b) {
    const parts = v => String(v ?? '').replace(/^v/i, '').split('.').map(p => parseInt(p, 10) || 0);
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0))
            return (x[i] ?? 0) > (y[i] ?? 0);
    }
    return false;
}

export class UpdateChecker {
    constructor(extension, settings) {
        this._extension = extension;
        this._settings = settings;
        this._current = extension.metadata['version-name'] ?? String(extension.metadata.version ?? '');
        this._session = null;
        this._cancellable = null;
        this._wakeId = 0;
        this._busy = false;
        this._settingsId = settings.connect('changed::check-updates', () => this._sync(true));
        this._sync(false);
    }

    destroy() {
        this._settings.disconnect(this._settingsId);
        this._stop();
        this._session = null;
    }

    _stop() {
        if (this._wakeId) {
            GLib.Source.remove(this._wakeId);
            this._wakeId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        this._busy = false;
    }

    _sync(justSwitched) {
        if (!this._settings.get_boolean('check-updates')) {
            this._stop();
            return;
        }
        if (!this._wakeId) {
            this._wakeId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, WAKE_SECONDS, () => {
                this._maybeCheck(false);
                return GLib.SOURCE_CONTINUE;
            });
        }
        // Switched on just now: look right away. Otherwise only when due.
        this._maybeCheck(justSwitched);
    }

    _maybeCheck(force) {
        if (this._busy)
            return;
        const last = Number(this._settings.get_int64('update-checked-at'));
        if (!force && Date.now() - last < CHECK_EVERY_MS)
            return;
        this._check();
    }

    _getJson(url, callback) {
        this._session ??= new Soup.Session({user_agent: `desktop-widgets/${this._current} (GNOME Shell extension)`});
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('Accept', 'application/vnd.github+json');
        this._session.send_and_read_async(message, GLib.PRIORITY_LOW, this._cancellable, (session, result) => {
            let status = 0;
            let data = null;
            try {
                const bytes = session.send_and_read_finish(result);
                status = message.get_status();
                if (status === 200)
                    data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            } catch (e) {
                if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
            }
            callback(status, data);
        });
    }

    _check() {
        this._busy = true;
        this._cancellable = new Gio.Cancellable();
        // 1) The latest release, if the repository has any.
        this._getJson(RELEASE_API, (status, release) => {
            const tag = release?.tag_name ? String(release.tag_name).replace(/^v/i, '') : '';
            if (status === 200 && tag) {
                this._found(tag, release.html_url || `${REPO_URL}/releases/latest`);
                return;
            }
            // 2) No releases yet (404): the version on the main branch.
            this._getJson(MAIN_METADATA, (status2, metadata) => {
                const version = metadata?.['version-name'] ?? '';
                if (status2 === 200 && version)
                    this._found(String(version), REPO_URL);
                else
                    this._busy = false; // offline / rate-limited: try again next wake
            });
        });
    }

    _found(latest, url) {
        this._busy = false;
        this._settings.set_string('update-latest', latest);
        this._settings.set_string('update-url', url);
        this._settings.set_int64('update-checked-at', Date.now());

        if (!isNewer(latest, this._current) || this._settings.get_string('update-shown') === latest)
            return;
        this._settings.set_string('update-shown', latest);
        this._notify(latest);
    }

    _notify(latest) {
        try {
            const source = MessageTray.getSystemSource();
            const notification = new MessageTray.Notification({
                source,
                title: _('Desktop Widgets %s is out').format(latest),
                body: _('Open Settings → About to see how to update.'),
                iconName: 'software-update-available-symbolic',
            });
            notification.addAction(_('Open Settings'), () => {
                this._settings.set_string('open-prefs-page', 'about');
                this._extension.openPreferences();
            });
            source.addNotification(notification);
        } catch (e) {
            // Older notification API: a plain banner still tells the news.
            Main.notify(_('Desktop Widgets %s is out').format(latest),
                _('Open Settings → About to see how to update.'));
        }
    }
}
