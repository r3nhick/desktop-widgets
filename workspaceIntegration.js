import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { warn } from './logger.js';

let WorkspaceAnimationMonitorGroup = null;
let animationModulePromise = null;

async function loadWorkspaceAnimationModule() {
  if (animationModulePromise === null) {
    animationModulePromise = import('resource:///org/gnome/shell/ui/workspaceAnimation.js')
      .then(workspaceAnimationModule => {
        WorkspaceAnimationMonitorGroup = workspaceAnimationModule.MonitorGroup ?? null;
        return WorkspaceAnimationMonitorGroup;
      })
      .catch(error => {
        warn('workspace-animation-import', `Workspace animation module unavailable: ${error.message}`);
        WorkspaceAnimationMonitorGroup = null;
        return null;
      });
  };

  return animationModulePromise;
};

function animateMonitorGroups() {
  return WorkspaceAnimationMonitorGroup
    ? Main.uiGroup.get_children().filter(child => child instanceof WorkspaceAnimationMonitorGroup)
    : [];
};

function destroyActor(actor) {
  if (!actor) {
    return;
  };

  actor.destroy();
};

export class WorkspaceIntegration {
  constructor() {
    this._enabled = false;
    this._source = null;
    this._signals = [];
    this._overviewClones = new Map();
    this._overviewSyncId = 0;
    this._workspaceAnimationClones = new Set();
  };

  enable(source) {
    this._enabled = true;
    this.setSource(source);

    this._signals.push([
      Main.uiGroup,
      Main.uiGroup.connect('child-added', (_group, child) => {
        if (WorkspaceAnimationMonitorGroup && child instanceof WorkspaceAnimationMonitorGroup) {
          this._addWorkspaceAnimationMonitorGroup(child)
        };
      }),
    ]);

    this._signals.push([
      Main.overview,
      Main.overview.connect('showing', () => {
        this._syncOverviewPreviews();
        this.queueSync();
      }),
    ]);

    this._signals.push([
      Main.overview,
      Main.overview.connect('shown', () => {
        this._syncOverviewPreviews();
      }),
    ]);

    this._signals.push([
      Main.overview,
      Main.overview.connect('hidden', () => {
        this._clearOverviewClones();
      }),
    ]);

    this._signals.push([
      global.workspace_manager,
      global.workspace_manager.connect('notify::n-workspaces', () => {
        this.queueSync();
      }),
    ]);

    this._signals.push([
      global.workspace_manager,
      global.workspace_manager.connect('workspaces-reordered', () => {
        this.queueSync();
      }),
    ]);

    if (Main.overview.visible || Main.overview.visibleTarget) {
      this.queueSync();
    };

    loadWorkspaceAnimationModule().then(() => this._beginAnimationTracking());
  };

  _beginAnimationTracking() {
    if (!this._enabled || !WorkspaceAnimationMonitorGroup) {
      return;
    };

    for (const child of animateMonitorGroups()) {
      this._addWorkspaceAnimationMonitorGroup(child);
    };
  };

  destroy() {
    this._enabled = false;
    this._cancelSync();
    this._clearOverviewClones();
    this._clearWorkspaceAnimationClones();

    for (const [actor, id] of this._signals) {
      actor.disconnect(id);
    };

    this._signals = [];
    this._source = null;
  };

  setSource(source) {
    if (source === this._source) {
      return;
    };

    this._clearOverviewClones();
    this._clearWorkspaceAnimationClones();
    this._source = source;

    if (this._enabled && source && (Main.overview.visible || Main.overview.visibleTarget)) {
      this.queueSync();
    };
  };

  queueSync() {
    if (!this._enabled || this._overviewSyncId || (!Main.overview.visible && !Main.overview.visibleTarget)) {
      return;
    };

    this._overviewSyncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._overviewSyncId = 0;

      if (this._enabled && (Main.overview.visible || Main.overview.visibleTarget)) {
        this._syncOverviewPreviews();
      };

      return GLib.SOURCE_REMOVE;
    });

    GLib.Source.set_name_by_id(this._overviewSyncId, '[widgets] sync overview previews');
  };

  _cancelSync() {
    if (!this._overviewSyncId) {
      return;
    };

    GLib.source_remove(this._overviewSyncId);
    this._overviewSyncId = 0;
  };

  _clearOverviewClones() {
    for (const { clone } of [...this._overviewClones.values()]) {
      destroyActor(clone);
    };

    this._overviewClones.clear();
  };

  _clearWorkspaceAnimationClones() {
    for (const clone of [...this._workspaceAnimationClones]) {
      destroyActor(clone);
    };

    this._workspaceAnimationClones.clear();
  };

  _addWorkspaceAnimationClone(workspaceBackground) {
    try {
      const monitor = workspaceBackground?._monitor;

      if (!this._source || monitor?.index !== Main.layoutManager.primaryIndex) {
        return;
      };

      const backgroundGroup = workspaceBackground.get_first_child();

      if (!backgroundGroup) {
        return;
      };

      const clone = new Clutter.Clone({
        source: this._source,
        reactive: false,
        x: 0,
        y: 0,
        width: monitor.width,
        height: monitor.height
      });

      backgroundGroup.add_child(clone);
      backgroundGroup.connectObject('child-added', (_actor, child) => {
        if (child !== clone && clone.get_parent() === backgroundGroup) {
          backgroundGroup.set_child_above_sibling(clone, null);
        };
      }, clone);

      clone.connect('destroy', () => this._workspaceAnimationClones.delete(clone));

      this._workspaceAnimationClones.add(clone);
      backgroundGroup.set_child_above_sibling(clone, null);
    } catch (error) {
      warn('workspace-animation-clone', `Could not clone layer into animation group: ${error.message}`);
    };
  };

  _addWorkspaceAnimationMonitorGroup(monitorGroup) {
    try {
      if (monitorGroup.index !== Main.layoutManager.primaryIndex) {
        return;
      };

      for (const workspaceGroup of monitorGroup._workspaceGroups ?? []) {
        this._addWorkspaceAnimationClone(workspaceGroup._background);
      };
    } catch (error) {
      warn('workspace-animation-group', `Could not track workspace animation group: ${error.message}`);
    };
  };

  _overviewPreviewTargets() {
    const monitor = Main.layoutManager.primaryMonitor;
    const primaryIndex = Main.layoutManager.primaryIndex;
    const controls = Main.overview._overview?.controls;
    const targets = new Map();

    if (!monitor || !controls || !this._source) {
      return targets;
    };

    const workspaceView = controls._workspacesDisplay?._workspacesViews?.[primaryIndex];

    for (const workspace of workspaceView?._workspaces ?? []) {
      const container = workspace._background?._backgroundGroup;

      if (workspace.monitorIndex === primaryIndex && container) {
        targets.set(container, {
          fillContainer: true,
          aboveSiblings: true,
        });
      };
    };

    for (const thumbnail of controls._thumbnailsBox?._thumbnails ?? []) {
      const container = thumbnail._contents;

      if (thumbnail.monitorIndex === primaryIndex && container) {
        targets.set(container, {
          fillContainer: false,
          x: monitor.x,
          y: monitor.y,
          width: monitor.width,
          height: monitor.height,
          aboveSiblings: false,
        });
      };
    };

    return targets;
  };

  _restackOverviewClone(container, clone, aboveSiblings) {
    if (clone.get_parent() !== container) {
      return;
    };

    if (aboveSiblings) {
      container.set_child_above_sibling(clone, null);
    } else {
      container.set_child_below_sibling(clone, null);
    };
  };

  _addOverviewClone(container, target) {
    const clone = new Clutter.Clone({
      source: this._source,
      reactive: false,
      x_expand: target.fillContainer,
      y_expand: target.fillContainer,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.FILL,
    });

    const record = { clone, aboveSiblings: target.aboveSiblings };

    if (target.fillContainer) {
      clone.set_size(0, 0);
    } else {
      clone.set_position(target.x, target.y);
      clone.set_size(target.width, target.height);
    }

    container.add_child(clone);

    container.connectObject('child-added', (_actor, child) => {
      if (child !== clone) {
        this._restackOverviewClone(container, clone, record.aboveSiblings);
      };
    }, clone);

    clone.connect('destroy', () => {
      if (this._overviewClones.get(container)?.clone === clone) {
        this._overviewClones.delete(container);
      };
    });

    this._overviewClones.set(container, record);
    this._restackOverviewClone(container, clone, record.aboveSiblings);
  };

  _syncOverviewPreviews() {
    const targets = this._overviewPreviewTargets();

    for (const [container, record] of [...this._overviewClones]) {
      if (!targets.has(container) || record.clone.source !== this._source) {
        destroyActor(record.clone);
      };
    };

    for (const [container, target] of targets) {
      const record = this._overviewClones.get(container);

      if (!record) {
        this._addOverviewClone(container, target);
        continue;
      };

      record.aboveSiblings = target.aboveSiblings;

      if (target.fillContainer) {
        record.clone.set_size(0, 0);
      } else {
        record.clone.set_position(target.x, target.y);
        record.clone.set_size(target.width, target.height);
      };

      this._restackOverviewClone(container, record.clone, record.aboveSiblings);
    };
  };
};
