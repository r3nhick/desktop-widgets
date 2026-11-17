import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { boxLayoutProps } from '../../utils/gnomeCompat.js';
import { widgetResourcePath } from '../../paths.js';
import { loadJsonFromFileSync } from '../../utils/ported.js';
import { saveWidgetState, widgetStatePath } from '../../lib/widgetState.js';
import { attachFollowPager } from '../../lib/pager.js';
import { isActorDestroyed } from '../../utils/actorLifecycle.js';

export const type = 'system';
export const label = 'System Monitor';
export const defaultSize = 'small';
export const supportedSizes = ['small', 'medium', 'large'];

const POLL_INTERVAL_MS = 5000;
const SWIPE_THRESHOLD = 30; // same gesture distance as the calendar widget
const SPARK_SAMPLES = 40;
const SPARK_LINE_WIDTH = 2;
const SPARK_FILL_ALPHA = 0.15;
const ANIMATION_DURATION = 250;

const ROW_SPACING = 10;
const CONTAINER_PAD = 3;
const MIN_TILE = 40;

const METRIC_CPU = 0;
const METRIC_RAM = 1;
const METRIC_GPU = 2;
const METRIC_NETWORK_DOWN = 3;
const METRIC_NETWORK_UP = 4;

const VIEW_CPU_RAM = 0;
const VIEW_GPU_RAM = 1;
const VIEW_NETWORK = 2;

/*
 * Header icons are bundled Lucide SVGs (lucide.dev — cpu, memory-stick,
 * gpu, arrow-down, arrow-up), kept in icons/widgets_settings/system/.
 * St renders FileIcons verbatim, so the muted tone is baked into the SVG
 * stroke on disk in a per-(icon, tone) cache file.
 */
const LUCIDE_ICONS = {
  cpu: 'cpu',
  ram: 'memory-stick',
  gpu: 'gpu',
  networkDown: 'arrow-down',
  networkUp: 'arrow-up',
};

// Every render of every tile asked the disk (two stats + maybe a rewrite)
// for the same recolored icon; keep the resulting GIcons in memory.
const LUCIDE_ICON_CACHE = new Map();

function lucideIcon(theme, metricKey) {
  const color = String(theme?.muted ?? '#c0bfbc').trim();
  const key = `${metricKey}|${color}`;
  if (LUCIDE_ICON_CACHE.has(key))
    return LUCIDE_ICON_CACHE.get(key);
  const icon = lucideIconUncached(color, metricKey);
  if (icon)
    LUCIDE_ICON_CACHE.set(key, icon);
  return icon;
}

function lucideIconUncached(color, metricKey) {
  const name = LUCIDE_ICONS[metricKey];
  const file = widgetResourcePath('system', `${name}.svg`);

  if (!name || !file || !Gio.File.new_for_path(file).query_exists(null)) {
    return null;
  };

  const id = `${name}-${color.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const cachePath = GLib.build_filenamev([
    GLib.get_user_cache_dir(), 'desktop-widgets', 'system-icons', `${id}.svg`,
  ]);

  try {
    if (!Gio.File.new_for_path(cachePath).query_exists(null)) {
      const [ok, contents] = Gio.File.new_for_path(file).load_contents(null);

      if (ok) {
        const svg = new TextDecoder().decode(contents)
          .replace(/stroke="[^"]*"/g, `stroke="${color}"`);

        GLib.mkdir_with_parents(GLib.path_get_dirname(cachePath), 0o755);
        Gio.File.new_for_path(cachePath).replace_contents(svg, null, false, Gio.FileCreateFlags.NONE, null);
      };
    };

    return Gio.FileIcon.new(Gio.File.new_for_path(cachePath));
  } catch (_error) {
    // Fall back to the classic symbolic icon rather than nothing.
    return null;
  };
};

/*
 * Bottom strip for swiped pages: N dashes, the active one accent-lit.
 * The strip is attached to the pane WRAPPER — a plain fixed-layout Widget
 * with no padding and no clip — so the dashes escape the 16px pane inset
 * (and the body clip) and sit right against the pane's bottom edge while
 * the tile itself keeps its regular position.
 */
function attachPageDashes({paneRoot, sizeForWidget, widget, count, color, visible = true, style = 'dash'}) {
  // Round dots (calendar's classic look) or dashes, per page-indicator-style.
  const dashWidth = style === 'dot' ? 5 : 10;
  const dashHeight = style === 'dot' ? 5 : 3;

  // Re-render fills a fresh body but reuses the same wrapper — an old
  // overlay has to go first, or dashes pile up. Runs even when the dashes
  // are disabled, so a stale strip never survives a re-render.
  let child = paneRoot?.get_first_child?.();

  while (child) {
    const next = child.get_next_sibling();

    if (child.get_name?.() === 'widget-system-page-dashes') {
      paneRoot.remove_child(child);
    };

    child = next;
  };

  if (!paneRoot || !visible || count <= 0) {
    return {set: () => {}};
  };

  const [paneW, paneH] = sizeForWidget(widget);
  const dashes = [];
  for (let i = 0; i < count; i++) {
    dashes.push(new St.Widget({
      width: dashWidth,
      height: dashHeight,
      opacity: 72,
      reactive: false,
      style: `border-radius: 999px; background-color: ${color};`,
    }));
  };

  const row = new St.BoxLayout(boxLayoutProps({
    x_expand: true,
    x_align: Clutter.ActorAlign.CENTER,
    // 8px above the pane's inner bottom edge: nestled in the 16px inset
    // strip, snug below the tile and clear of the pane's rounded border.
    style: `spacing: 5px; margin-bottom: 8px;`,
  }));
  dashes.forEach(dash => row.add_child(dash));

  // The y-expanding filler above the row pushes it to the strip bottom.
  // The strip is a plain fixed-layout Widget: children keep their NATURAL
  // size there, so the column has to be sized to the strip explicitly —
  // otherwise it shrinks to the row's width and the dashes hug the pane's
  // left edge instead of centering.
  const column = new St.BoxLayout(boxLayoutProps({
    vertical: true,
    x_expand: true,
    y_expand: true,
  }));
  column.add_child(new St.Widget({y_expand: true, reactive: false}));
  column.add_child(row);
  column.set_size(paneW, 11);

  const strip = new St.Widget({reactive: false});
  strip.set_name('widget-system-page-dashes');
  strip.set_size(paneW, 11);
  strip.set_position(0, Math.max(0, paneH - 11));
  strip.add_child(column);

  // Resize keeps the same pane and only re-renders ~260ms later — keep the
  // strip glued to the pane's bottom edge in the meantime.
  const syncStrip = () => {
    const [w, h] = paneRoot.get_size();

    strip.set_size(w, 11);
    column.set_size(w, 11);
    strip.set_position(0, Math.max(0, h - 11));
  };
  const stripSignal = paneRoot.connect('notify::size', syncStrip);
  strip.connect('destroy', () => paneRoot.disconnect(stripSignal));

  paneRoot.add_child(strip);

  return {
    set(activeIndex) {
      dashes.forEach((dash, index) => {
        dash.style = `border-radius: 999px; background-color: ${color};`;
        dash.ease({
          opacity: index === activeIndex ? 255 : 72,
          duration: 120,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
      });
    },
  };
};

const TEXT_DECODER = new TextDecoder('utf-8');
const CPU_HWMON_NAMES = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'soc_thermal', 'acpitz'];
const GPU_HWMON_NAMES = ['amdgpu', 'radeon', 'nouveau', 'i915', 'xe'];
// Loopback plus virtual links whose traffic is already counted on the
// physical NIC (container veths, bridges, tun/tap, wireguard...).
const VIRTUAL_IFACE_RE = /^(lo|veth[^:]*|docker[^:]*|br-[^:]*|virbr[^:]*|vnet[^:]*|tap[^:]*|tun[^:]*|wg[^:]*|tailscale[^:]*):/;

class SystemMonitor {
  constructor() {
    this.subscribers = [];
    this.timerId = null;
    this.lastData = {
      cpu: 0,
      ram: 0,
      ramUsed: 0,
      gpu: 0,
      cpuTemp: 0,
      gpuTemp: 0,
      networkDown: 0,
      networkUp: 0,
      cpuSamples: [],
      ramSamples: [],
      gpuSamples: [],
      netDownSamples: [],
      netUpSamples: [],
    };
    this.prevCpuTotal = 0;
    this.prevCpuIdle = 0;
    this.prevRxBytes = 0;
    this.prevTxBytes = 0;
    this.prevTimeMs = 0;
    this.gpuPath = null;
    this.cpuTempPath = null;
    this.gpuTempPath = null;
    this.findGpuPath();
    this.findCpuTempPath();
    this.findGpuTempPath();
  }

  findGpuPath() {
    const cards = ['/sys/class/drm/card0/device/gpu_busy_percent',
                   '/sys/class/drm/card1/device/gpu_busy_percent'];
    for (const path of cards) {
      const file = Gio.File.new_for_path(path);
      if (file.query_exists(null)) {
        this.gpuPath = path;
        break;
      }
    }
  }

  // hwmonN numbering is assigned at boot in probe order, so a fixed
  // hwmon0/1/2 list often picked an NVMe, Wi-Fi or ACPI sensor instead of
  // the CPU. Look the sensor up by its driver name first.
  findHwmonByName(names) {
    try {
      const dir = Gio.File.new_for_path('/sys/class/hwmon');
      const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
      const found = new Map();
      let info;
      while ((info = en.next_file(null)) !== null) {
        const base = `/sys/class/hwmon/${info.get_name()}`;
        try {
          const [ok, bytes] = Gio.File.new_for_path(`${base}/name`).load_contents(null);
          if (!ok) continue;
          const name = TEXT_DECODER.decode(bytes).trim();
          const input = `${base}/temp1_input`;
          if (names.includes(name) && !found.has(name)
              && Gio.File.new_for_path(input).query_exists(null))
            found.set(name, input);
        } catch (_e) {}
      }
      en.close(null);
      // Respect the priority order of `names`.
      for (const name of names) {
        if (found.has(name)) return found.get(name);
      }
    } catch (_e) {}
    return null;
  }

  findCpuTempPath() {
    this.cpuTempPath = this.findHwmonByName(CPU_HWMON_NAMES);
    if (this.cpuTempPath) return;
    const paths = [
      '/sys/class/hwmon/hwmon0/temp1_input',
      '/sys/class/hwmon/hwmon1/temp1_input',
      '/sys/class/hwmon/hwmon2/temp1_input',
      '/sys/class/thermal/thermal_zone0/temp',
      '/sys/class/thermal/thermal_zone1/temp',
    ];
    for (const path of paths) {
      const file = Gio.File.new_for_path(path);
      if (file.query_exists(null)) {
        this.cpuTempPath = path;
        break;
      }
    }
  }

  findGpuTempPath() {
    this.gpuTempPath = this.findHwmonByName(GPU_HWMON_NAMES);
    if (this.gpuTempPath) return;
    const paths = [
      '/sys/class/drm/card0/device/hwmon/hwmon0/temp1_input',
      '/sys/class/drm/card0/device/hwmon/hwmon1/temp1_input',
      '/sys/class/drm/card1/device/hwmon/hwmon0/temp1_input',
      '/sys/class/drm/card1/device/hwmon/hwmon1/temp1_input',
      '/sys/class/hwmon/hwmon3/temp1_input',
      '/sys/class/hwmon/hwmon4/temp1_input',
    ];
    for (const path of paths) {
      const file = Gio.File.new_for_path(path);
      if (file.query_exists(null)) {
        this.gpuTempPath = path;
        break;
      }
    }
  }

  async readFile(path) {
    try {
      const file = Gio.File.new_for_path(path);
      const [success, contents] = await new Promise((resolve, reject) => {
        file.load_contents_async(null, (f, res) => {
          try {
            resolve(f.load_contents_finish(res));
          } catch (e) {
            reject(e);
          }
        });
      });
      if (success) {
        return TEXT_DECODER.decode(contents);
      }
    } catch (e) {
      console.error(`Error reading ${path}:`, e);
    }
    return '';
  }

  async sampleCPU() {
    const text = await this.readFile('/proc/stat');
    const match = text.match(/^cpu\s+(.+)$/m);
    if (match) {
      const parts = match[1].trim().split(/\s+/).map(Number);
      const idle = parts[3] + parts[4];
      const total = parts.reduce((a, b) => a + b, 0);

      const prevTotal = this.prevCpuTotal;
      const prevIdle = this.prevCpuIdle;
      // Always roll the reference sample forward: the old early return
      // kept the FIRST sample forever, so "CPU" showed the average load
      // since the widget appeared instead of the current load.
      this.prevCpuTotal = total;
      this.prevCpuIdle = idle;
      if (prevTotal > 0) {
        const deltaTotal = total - prevTotal;
        const deltaIdle = idle - prevIdle;
        if (deltaTotal > 0) {
          return Math.max(0, Math.min(1, 1.0 - (deltaIdle / deltaTotal)));
        }
      }
    }
    return this.lastData.cpu;
  }

  async sampleRAM() {
    const text = await this.readFile('/proc/meminfo');
    const totalMatch = text.match(/MemTotal:\s+(\d+)/);
    const availMatch = text.match(/MemAvailable:\s+(\d+)/);
    if (totalMatch && availMatch) {
      const total = parseInt(totalMatch[1], 10);
      const avail = parseInt(availMatch[1], 10);
      if (total > 0) {
        // Absolute used memory for the tile's corner label: meminfo reports
        // kB, widgets want bytes.
        this.lastData.ramUsed = (total - avail) * 1024;
        return 1.0 - (avail / total);
      }
    }
    return this.lastData.ram;
  }

  async sampleGPU() {
    if (!this.gpuPath) return 0;
    const text = await this.readFile(this.gpuPath);
    const value = parseInt(text.trim(), 10);
    return isNaN(value) ? 0 : value / 100.0;
  }

  async sampleCpuTemp() {
    if (!this.cpuTempPath) return 0;
    const text = await this.readFile(this.cpuTempPath);
    const value = parseInt(text.trim(), 10);
    return isNaN(value) ? 0 : value / 1000.0;
  }

  async sampleGpuTemp() {
    if (!this.gpuTempPath) return 0;
    const text = await this.readFile(this.gpuTempPath);
    const value = parseInt(text.trim(), 10);
    return isNaN(value) ? 0 : value / 1000.0;
  }

  async sampleNetwork() {
    const text = await this.readFile('/proc/net/dev');
    const lines = text.split('\n');
    let totalRx = 0;
    let totalTx = 0;

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || VIRTUAL_IFACE_RE.test(line)) continue;
      const parts = line.split(':');
      if (parts.length >= 2) {
        const data = parts[1].trim().split(/\s+/);
        if (data.length >= 9) {
          totalRx += parseInt(data[0], 10) || 0;
          totalTx += parseInt(data[8], 10) || 0;
        }
      }
    }

    const nowMs = GLib.get_monotonic_time() / 1000;
    let down = 0;
    let up = 0;

    if (this.prevTimeMs > 0) {
      const deltaMs = nowMs - this.prevTimeMs;
      if (deltaMs > 0) {
        down = Math.max(0, ((totalRx - this.prevRxBytes) / deltaMs) * 1000);
        up = Math.max(0, ((totalTx - this.prevTxBytes) / deltaMs) * 1000);
      }
    }

    this.prevRxBytes = totalRx;
    this.prevTxBytes = totalTx;
    this.prevTimeMs = nowMs;

    return { down, up };
  }

  async poll() {
    // A slow sysfs read must not let two polls interleave and corrupt the
    // delta bookkeeping (prev CPU / network counters).
    if (this._polling) return;
    this._polling = true;
    try {
      await this._pollOnce();
    } finally {
      this._polling = false;
    }
  }

  _startTimer() {
    if (this.timerId || this.paused || this.subscribers.length === 0) return;
    this.poll();
    this.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
      this.poll();
      return GLib.SOURCE_CONTINUE;
    });
  }

  _stopTimer() {
    if (this.timerId) {
      GLib.Source.remove(this.timerId);
      this.timerId = null;
    }
  }

  async _pollOnce() {
    const [cpu, ram, gpu, cpuTemp, gpuTemp, network] = await Promise.all([
      this.sampleCPU(),
      this.sampleRAM(),
      this.sampleGPU(),
      this.sampleCpuTemp(),
      this.sampleGpuTemp(),
      this.sampleNetwork(),
    ]);

    this.lastData.cpu = cpu;
    this.lastData.ram = ram;
    this.lastData.gpu = gpu;
    this.lastData.cpuTemp = cpuTemp;
    this.lastData.gpuTemp = gpuTemp;
    this.lastData.networkDown = network.down;
    this.lastData.networkUp = network.up;

    this.lastData.cpuSamples.push(cpu);
    if (this.lastData.cpuSamples.length > SPARK_SAMPLES) this.lastData.cpuSamples.shift();

    this.lastData.ramSamples.push(ram);
    if (this.lastData.ramSamples.length > SPARK_SAMPLES) this.lastData.ramSamples.shift();

    this.lastData.gpuSamples.push(gpu);
    if (this.lastData.gpuSamples.length > SPARK_SAMPLES) this.lastData.gpuSamples.shift();

    this.lastData.netDownSamples.push(network.down / 1024 / 1024);
    if (this.lastData.netDownSamples.length > SPARK_SAMPLES) this.lastData.netDownSamples.shift();

    this.lastData.netUpSamples.push(network.up / 1024 / 1024);
    if (this.lastData.netUpSamples.length > SPARK_SAMPLES) this.lastData.netUpSamples.shift();

    for (const cb of [...this.subscribers]) {
      try {
        cb(this.lastData);
      } catch (e) {
        console.error('Subscriber error:', e);
      }
    }
  }

  subscribe(callback) {
    this.subscribers.push(callback);

    if (this.lastData.cpu > 0 || this.lastData.ram > 0) {
      callback(this.lastData);
    }

    if (this.subscribers.length === 1)
      this._startTimer();

    return () => this.unsubscribe(callback);
  }

  unsubscribe(callback) {
    this.subscribers = this.subscribers.filter(cb => cb !== callback);
    if (this.subscribers.length === 0) {
      this._stopTimer();
      // Nobody left to show data to: the next subscriber decides afresh.
      this.paused = false;
      this.prevCpuTotal = 0;
      this.prevCpuIdle = 0;
      this.prevRxBytes = 0;
      this.prevTxBytes = 0;
      this.prevTimeMs = 0;
    }
  }

  // Fullscreen optimization: pause/resume polling
  pausePolling() {
    this.paused = true;
    this._stopTimer();
  }

  resumePolling() {
    this.paused = false;
    // A long pause makes the first network delta span the whole pause;
    // restart the rate baseline instead of showing a bogus average.
    this.prevTimeMs = 0;
    this._startTimer();
  }
}

let monitor = null;

// Lazy singleton: the GObject instance is created on first use in render()
// (i.e. after enable()), not at module import time.
function getSystemMonitor() {
  if (monitor === null) {
    monitor = new SystemMonitor();
  }
  return monitor;
}

// Export monitor for the fullscreen pause optimization
export { monitor };

function formatBytes(bytes) {
  // Rates are fractional (bytes / elapsed ms): anything below 1 B/s made
  // log() negative and the unit came out as `undefined`.
  if (!(bytes >= 1)) return ['0.0', 'B/s'];
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return [(bytes / Math.pow(k, i)).toFixed(1), sizes[i]];
}

// Storage-flavoured sibling of formatBytes for memory amounts (no rate
// suffix): "5.9 GB". Used by the RAM tile's corner label.
function formatMem(bytes) {
  if (!bytes || bytes <= 0) return null;
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function hexToRgb(color) {
  const str = String(color ?? '').trim();
  const hex = str.replace('#', '');

  if (/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) {
    const expanded = hex.length === 3
      ? hex.split('').map(ch => ch + ch).join('')
      : hex;
    return {
      r: parseInt(expanded.slice(0, 2), 16) / 255,
      g: parseInt(expanded.slice(2, 4), 16) / 255,
      b: parseInt(expanded.slice(4, 6), 16) / 255,
    };
  }

  const match = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (match) {
    return {
      r: Number(match[1]) / 255,
      g: Number(match[2]) / 255,
      b: Number(match[3]) / 255,
    };
  }

  return { r: 0.2, g: 0.6, b: 0.9 };
}

function drawSparkline(ctx, width, height, samples, maxValue, color, lineAlpha) {
  ctx.setOperator(0); // CAIRO_OPERATOR_CLEAR
  ctx.paint();
  ctx.setOperator(2); // CAIRO_OPERATOR_OVER

  if (!samples || samples.length < 2 || width <= 0 || height <= 0) return;

  const rgb = hexToRgb(color);
  const span = Math.max(maxValue, 0.01);
  const stepX = width / (SPARK_SAMPLES - 1);
  const offsetX = width - ((samples.length - 1) * stepX);

  const pointAt = (index) => [
    offsetX + (index * stepX),
    height - 1 - ((samples[index] / span) * (height - 2)),
  ];

  ctx.newPath();
  for (let i = 0; i < samples.length; i++) {
    const [x, y] = pointAt(i);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.setSourceRGBA(rgb.r, rgb.g, rgb.b, lineAlpha);
  ctx.setLineWidth(SPARK_LINE_WIDTH);
  ctx.stroke();

  const [firstX, firstY] = pointAt(0);
  const [lastX] = pointAt(samples.length - 1);
  ctx.newPath();
  ctx.moveTo(firstX, firstY);
  for (let i = 1; i < samples.length; i++) {
    const [x, y] = pointAt(i);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(lastX, height);
  ctx.lineTo(firstX, height);
  ctx.closePath();
  ctx.setSourceRGBA(rgb.r, rgb.g, rgb.b, SPARK_FILL_ALPHA * lineAlpha);
  ctx.fill();
}

function createSparkTile(theme, label, value, unit, accentColor, samples, maxValue, extraInfo = null, metricKey = null) {
  const isGlass = theme?.isGlass ?? false;
  const tileBackground = isGlass 
    ? 'transparent'
    : (theme.dark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)');
  
  const tile = new St.BoxLayout(boxLayoutProps({
    vertical: true,
    x_expand: false,
    y_expand: false,
    style: `
      background-color: ${tileBackground};
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 6px;
      spacing: 4px;
    `,
  }));

  const headerRow = new St.BoxLayout(boxLayoutProps({
    x_expand: true,
    style: `spacing: 6px;`,
  }));

  const lucideGIcon = lucideIcon(theme, metricKey);

  // Measured on GNOME 51 (Ubuntu 13px): the label's line box is 14px tall
  // while its caps ink spans 0..10, so the text's optical center sits 2px
  // ABOVE the line-box center. Clutter.BoxLayout gives every child the full
  // row height and ignores child y_align, and St.Icon centers its texture
  // in the line box — so the 14px glyph visually hangs below the caps
  // (Lucide cpu text-ink center measured at 6.5 vs caps center 5.0).
  // Paint-only lift: translates the glyph up without touching the layout.
  const iconTranslateY = -1.5;

  const icon = lucideGIcon
    ? new St.Icon({
        gicon: lucideGIcon,
        icon_size: 14,
        translation_y: iconTranslateY,
      })
    : new St.Icon({
        icon_name: 'computer-symbolic',
        icon_size: 14,
        translation_y: iconTranslateY,
        style: `color: ${theme.muted};`,
      });

  const nameLabel = new St.Label({
    text: label,
    style: `
      color: ${theme.muted};
      font-size: 13px;
      font-weight: 600;
    `,
  });

  headerRow.add_child(icon);
  headerRow.add_child(nameLabel);

  const headerSpacer = new St.Widget({
    x_expand: true,
  });
  headerRow.add_child(headerSpacer);

  let extraLabel = null;
  const needsCorner = (label === 'CPU' || label === 'GPU' || label === 'RAM');

  if (needsCorner || extraInfo) {
    extraLabel = new St.Label({
      text: extraInfo || '',
      visible: !!extraInfo,
      style: `
        color: ${theme.muted};
        font-size: 16px;
        font-weight: 600;
      `,
    });
    headerRow.add_child(extraLabel);
  }

  tile.add_child(headerRow);

  const valueRow = new St.BoxLayout(boxLayoutProps({
    x_align: Clutter.ActorAlign.START,
    style: `spacing: 0px;`,
  }));

  const valueLabel = new St.Label({
    text: value,
    style: `
      color: ${theme.text};
      font-size: 26px;
      font-weight: 600;
    `,
  });

  const unitLabel = new St.Label({
    text: unit,
    style: `
      color: ${theme.text};
      font-size: 26px;
      font-weight: 600;
    `,
  });

  valueRow.add_child(valueLabel);
  valueRow.add_child(unitLabel);

  const sparkArea = new St.DrawingArea({
    x_expand: true,
    y_expand: true,
  });

  sparkArea.connect('repaint', (area) => {
    const ctx = area.get_context();
    const [w, h] = area.get_surface_size();
    drawSparkline(ctx, w, h, samples, maxValue, accentColor, 1.0);
    ctx.$dispose();
  });

  tile.add_child(valueRow);
  tile.add_child(sparkArea);

  return { tile, valueLabel, unitLabel, sparkArea, extraLabel };
}

export function render({body, theme, widget, sizeForWidget, paneRoot, settings}) {
  monitor = getSystemMonitor();
  const size = widget?.size || defaultSize;
  const [width, height] = sizeForWidget(widget);

  const accentColor = theme.accent || '#3584e4';

  let currentMetric = METRIC_CPU;
  let currentView = VIEW_CPU_RAM;
  // The page the user last stopped on survives every re-render: theme and
  // style switches, live refreshes and resizes all refill the body and used
  // to throw the pane back onto the first page (RAM reported as CPU again).
  const statePath = widgetStatePath('system', widget);
  const clampIndex = (value, limit) =>
    Number.isInteger(value) && value >= 0 && value < limit ? value : null;
  try {
    const savedPositions = loadJsonFromFileSync(statePath);
    currentMetric = clampIndex(savedPositions?.metric, 5) ?? currentMetric;
    currentView = clampIndex(savedPositions?.view, 3) ?? currentView;
  } catch (e) {
    // A corrupt page file is a page file from before this feature: fall
    // through to the defaults rather than breaking the render.
  }
  // Round dots or dashes — the global page-indicator-style setting.
  const indicatorStyle = (settings?.get_int('page-indicator-style') ?? 1) === 1 ? 'dash' : 'dot';
  // Page dash color: the accent when the System Monitor Widget switch is
  // on, otherwise the neutral theme text (white on dark, black on light).
  const indicatorColor = settings?.get_boolean('system-page-indicator-accent') ?? true
    ? accentColor
    : theme.text;
  const showPageDashes = settings?.get_boolean('system-show-page-dashes') ?? true;
  let unsubscribe = null;
  const animatingActors = new Set();

  // Pages must OVERLAP during the swipe cross — the outgoing page keeps
  // sliding to the very edge of the widget while the incoming page already
  // enters from the opposite side (the calendar page-cross mechanic). A
  // stacking BoxLayout would split the pane between two rows mid-flight,
  // so this is a Bin: every page takes the full pane box.
  const container = new St.Widget({
    layout_manager: new Clutter.BinLayout(),
    x_expand: true,
    y_expand: true,
    clip_to_allocation: true,
    style: `padding: 3px;`,
  });

  // Explicitly size the tiles: one row of two tiles (medium) or two rows of
  // two tiles (large) get equal halves of the inner width. We read the real
  // allocation and force set_size / set_width so text length never changes
  // tile width (tiles are x_expand:false on purpose).
  let layoutMode = null; // 'medium' | 'large'
  let layoutRows = [];   // row actors whose tiles get sized by layoutTiles()

  const layoutTiles = () => {
    if (!layoutMode || layoutRows.length === 0) return;

    const box = container.get_allocation_box();
    const innerW = Math.floor(box.get_width()) - CONTAINER_PAD * 2;
    const innerH = Math.floor(box.get_height()) - CONTAINER_PAD * 2;
    if (innerW <= 0 || innerH <= 0) return;

    if (layoutMode === 'small') {
      const singleTile = layoutRows[0]?.get_children()?.[0];
      if (singleTile) {
        const cur = singleTile.get_allocation_box();
        if (cur.get_width() !== innerW) {
          singleTile.set_width(innerW);
        }
      }
      return;
    }

    if (layoutMode === 'medium') {
      const tileW = Math.max(MIN_TILE, Math.floor((innerW - ROW_SPACING) / 2));
      for (const row of layoutRows) {
        for (const child of row.get_children()) {
          const cur = child.get_allocation_box();
          if (cur.get_width() !== tileW) {
            child.set_width(tileW);
          }
        }
      }
    } else {
      const tileW = Math.max(MIN_TILE, Math.floor((innerW - ROW_SPACING) / 2));
      const rowH = Math.max(MIN_TILE, Math.floor((innerH - ROW_SPACING) / 2));
      for (const row of layoutRows) {
        const curRow = row.get_allocation_box();
        if (curRow.get_height() !== rowH) {
          row.set_height(rowH);
        }
        for (const child of row.get_children()) {
          const cur = child.get_allocation_box();
          if (cur.get_width() !== tileW) {
            child.set_width(tileW);
          }
        }
      }
    }
  };

  container.connect('notify::allocation', layoutTiles);

  if (size === 'small') {
    layoutMode = 'small';

    const metricConfigs = [
      { label: 'CPU', key: 'cpu', samplesKey: 'cpuSamples', maxValue: 1.0, unit: '%' },
      { label: 'RAM', key: 'ram', samplesKey: 'ramSamples', maxValue: 1.0, unit: '%' },
      { label: 'GPU', key: 'gpu', samplesKey: 'gpuSamples', maxValue: 1.0, unit: '%' },
      { label: _('Download'), key: 'networkDown', samplesKey: 'netDownSamples', maxValue: 10, unit: '' },
      { label: _('Upload'), key: 'networkUp', samplesKey: 'netUpSamples', maxValue: 10, unit: '' },
    ];

    let tile, valueLabel, unitLabel, sparkArea, extraLabel;
    let scrollBox;

    // Page dashes pinned to the pane's very bottom strip, one per metric
    // (5): the active metric lights up in the accent color, the rest stay
    // muted — the same idea as the calendar 1x1 page dots. The strip hangs
    // off the pane wrapper (unpadded, unclipped), so the tile itself keeps
    // its regular inset.
    const pageDashes = attachPageDashes({
      paneRoot, sizeForWidget, widget,
      count: metricConfigs.length,
      color: indicatorColor,
      visible: showPageDashes,
      style: indicatorStyle,
    });
    const refreshDashes = () => pageDashes.set(currentMetric);

    // GNOME workspace-switch cross — the same animation family as the 2x1:
    // leaving and entering pages travel in lockstep, nothing fades.
    const CROSS_DURATION = Math.round(ANIMATION_DURATION * 2); // 500ms

    // Pure page build (no entry animation, no wiping): one page = one
    // scrollBox in the pane Bin. The outer label refs (tile/valueLabel/…)
    // end up pointing at the LAST built page — the live-data loop feeds the
    // entering one, like the 2x1 tiles do.
    const buildPage = (metricIndex) => {
      scrollBox = new St.BoxLayout(boxLayoutProps({
        x_expand: true,
        y_expand: true,
        // No background - glass effect shows through (border only)
        style: ``,
      }));

      const config = metricConfigs[metricIndex];
      const samples = monitor.lastData[config.samplesKey] || [];
      
      let extraInfo = null;
      if (config.label === 'CPU' && monitor.lastData.cpuTemp > 0) {
        extraInfo = `${Math.round(monitor.lastData.cpuTemp)}°C`;
      } else if (config.label === 'GPU' && monitor.lastData.gpuTemp > 0) {
        extraInfo = `${Math.round(monitor.lastData.gpuTemp)}°C`;
      } else if (config.label === 'RAM') {
        extraInfo = formatMem(monitor.lastData.ramUsed);
      }
      
      const result = createSparkTile(theme, config.label, '0', config.unit, accentColor, samples, config.maxValue, extraInfo, config.key);
      tile = result.tile;
      valueLabel = result.valueLabel;
      unitLabel = result.unitLabel;
      sparkArea = result.sparkArea;
      extraLabel = result.extraLabel;
      
      scrollBox.add_child(tile);
      container.add_child(scrollBox);

      layoutRows = [scrollBox];
      layoutTiles();
      return scrollBox;
    };

    const rebuild = () => {
      container.remove_all_children();
      currentPage = buildPage(currentMetric);
      // Plain builds (init, theme change) keep the soft fade-in.
      tile.set_opacity(0);
      tile.ease({
        opacity: 255,
        duration: ANIMATION_DURATION,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    };

    const onData = (data) => {
      const config = metricConfigs[currentMetric];
      
      if (config.key === 'networkDown' || config.key === 'networkUp') {
        const [val, unit] = formatBytes(data[config.key]);
        valueLabel.set_text(val);
        unitLabel.set_text(unit);
      } else {
        const val = Math.round(data[config.key] * 100);
        valueLabel.set_text(String(val));
        unitLabel.set_text('%');
      }
      
      if (extraLabel) {
        if (config.label === 'CPU' && data.cpuTemp > 0) {
          extraLabel.set_text(`${Math.round(data.cpuTemp)}°C`);
          extraLabel.show();
        } else if (config.label === 'GPU' && data.gpuTemp > 0) {
          extraLabel.set_text(`${Math.round(data.gpuTemp)}°C`);
          extraLabel.show();
        } else if (config.label === 'RAM') {
          const usedMem = formatMem(data.ramUsed);
          if (usedMem) {
            extraLabel.set_text(usedMem);
            extraLabel.show();
          } else {
            extraLabel.hide();
          }
        }
      }
      
      sparkArea.queue_repaint();
      
      // Reallocate tile widths after text updates (especially for network)
      layoutTiles();
    };

    // The page currently on duty.
    let currentPage = null;

    // Apple-style follow pager (lib/pager.js): the page follows the
    // pointer with its neighbour attached, both in one frame.
    const pageGap = () => {
      const paneBox = container.get_allocation_box();
      const pageW = Math.max(1, Math.floor(paneBox.get_width()) - CONTAINER_PAD * 2);
      return pageW + Math.round(pageW / 16);
    };
    const dropPage = page => {
      if (!page || isActorDestroyed(page)) return;
      page.get_parent()?.remove_child(page);
      page.destroy();
    };
    attachFollowPager(container, {
      isAlive: () => !tornDown,
      distance: pageGap,
      begin: (dir) => {
        const index = (currentMetric + dir + metricConfigs.length) % metricConfigs.length;
        const leaving = currentPage;
        if (!leaving) return null;
        // The entering build is the last one: live data feeds it.
        const entering = buildPage(index);
        layoutRows = [leaving, entering];
        layoutTiles();
        if (monitor.lastData.cpu > 0 || monitor.lastData.ram > 0)
          onData(monitor.lastData);
        return {leaving, entering, index};
      },
      discard: (pair) => dropPage(pair.entering),
      commit: (pair) => {
        currentMetric = pair.index;
        // Remember the metric for the next re-render (theme switch...).
        saveWidgetState(statePath, { metric: currentMetric });
        refreshDashes();
      },
      settledCommit: (pair) => {
        dropPage(pair.leaving);
        currentPage = pair.entering;
        layoutRows = [currentPage];
        layoutTiles();
        if (monitor.lastData.cpu > 0 || monitor.lastData.ram > 0)
          onData(monitor.lastData);
      },
      settledCancel: (pair) => {
        dropPage(pair.entering);
        // Live labels pointed at the dropped neighbour: rebuild the
        // current page in place (identical content, no fade).
        dropPage(pair.leaving);
        currentPage = buildPage(currentMetric);
        if (monitor.lastData.cpu > 0 || monitor.lastData.ram > 0)
          onData(monitor.lastData);
      },
    });
    rebuild();
    unsubscribe = monitor.subscribe(onData);
    refreshDashes();

  } else if (size === 'medium') {
    layoutMode = 'medium';

    // GNOME eases the workspace switch with EASE_OUT_CUBIC; the pane is
    // narrow so a slightly longer sweep reads calm.
    const CROSS_DURATION = Math.round(ANIMATION_DURATION * 2); // 500ms

    const viewConfigs = [
      [
        { label: 'CPU', key: 'cpu', samplesKey: 'cpuSamples', maxValue: 1.0, unit: '%' },
        { label: 'RAM', key: 'ram', samplesKey: 'ramSamples', maxValue: 1.0, unit: '%' },
      ],
      [
        { label: 'GPU', key: 'gpu', samplesKey: 'gpuSamples', maxValue: 1.0, unit: '%' },
        { label: 'RAM', key: 'ram', samplesKey: 'ramSamples', maxValue: 1.0, unit: '%' },
      ],
      [
      { label: _('Download'), key: 'networkDown', samplesKey: 'netDownSamples', maxValue: 10, unit: '' },
      { label: _('Upload'), key: 'networkUp', samplesKey: 'netUpSamples', maxValue: 10, unit: '' },
      ],
    ];

    let tiles = [];
    let currentRow;

    // Page dashes pinned to the pane's very bottom strip, one per swipe
    // view (3) — see attachPageDashes for the wrapper-level placement.
    const pageDashes = attachPageDashes({
      paneRoot, sizeForWidget, widget,
      count: viewConfigs.length,
      color: indicatorColor,
      visible: showPageDashes,
      style: indicatorStyle,
    });
    const refreshDashes = () => pageDashes.set(currentView);

    // ── GNOME workspace-switch cross (js/ui/workspaceAnimation.js) ────────
    // A stripe holds the leaving and the incoming page side by side and the
    // whole stripe travels (pages never overlap, nothing fades — the seam
    // between them is the only thing crossing the pane). A plain build
    // (init, theme change) attaches straight to the pane.
    const buildRow = (attachTo, viewIndex) => {
      currentRow = new St.BoxLayout(boxLayoutProps({
        x_expand: true,
        y_expand: true,
        // No background - glass effect shows through (border only)
        style: `spacing: 10px;`,
      }));

      const view = viewConfigs[viewIndex];
      tiles = [];

      for (const config of view) {
        const samples = monitor.lastData[config.samplesKey] || [];

        let extraInfo = null;
        if (config.label === 'CPU' && monitor.lastData.cpuTemp > 0) {
          extraInfo = `${Math.round(monitor.lastData.cpuTemp)}°C`;
        } else if (config.label === 'GPU' && monitor.lastData.gpuTemp > 0) {
          extraInfo = `${Math.round(monitor.lastData.gpuTemp)}°C`;
        } else if (config.label === 'RAM') {
          extraInfo = formatMem(monitor.lastData.ramUsed);
        }

        const result = createSparkTile(theme, config.label, '0', config.unit, accentColor, samples, config.maxValue, extraInfo, config.key);
        tiles.push(result);
        currentRow.add_child(result.tile);
      }

      attachTo.add_child(currentRow);

      // Geometry facts for the live logs: every allocation change of every
      // built row goes to the journal.
      currentRow.connect('notify::allocation', (actor) => {
        const b = actor.get_allocation_box();

      });

      return currentRow;
    };

    const rebuild = (attachTo = container, viewIndex = currentView) => {
      if (attachTo === container)
        container.remove_all_children();

      const row = buildRow(attachTo, viewIndex);
      layoutRows = [row];
      layoutTiles();
      return row;
    };

    const onData = (data) => {
      try {
        applyData(data);
      } catch (e) {
        logError(e, 'System monitor data update failed');
      }
    };

    const applyData = (data) => {
      const view = viewConfigs[currentView];
      
      for (let i = 0; i < tiles.length; i++) {
        const config = view[i];
        const tile = tiles[i];
        
        if (config.key === 'networkDown' || config.key === 'networkUp') {
          const [val, unit] = formatBytes(data[config.key]);
          tile.valueLabel.set_text(val);
          tile.unitLabel.set_text(unit);
        } else {
          const val = Math.round(data[config.key] * 100);
          tile.valueLabel.set_text(String(val));
          tile.unitLabel.set_text('%');
        }
        
        if (tile.extraLabel) {
          if (config.label === 'CPU' && data.cpuTemp > 0) {
            tile.extraLabel.set_text(`${Math.round(data.cpuTemp)}°C`);
            tile.extraLabel.show();
          } else if (config.label === 'GPU' && data.gpuTemp > 0) {
            tile.extraLabel.set_text(`${Math.round(data.gpuTemp)}°C`);
            tile.extraLabel.show();
          } else if (config.label === 'RAM') {
            const usedMem = formatMem(data.ramUsed);
            if (usedMem) {
              tile.extraLabel.set_text(usedMem);
              tile.extraLabel.show();
            } else {
              tile.extraLabel.hide();
            }
          }
        }
        
        tile.sparkArea.queue_repaint();
      }
      
      // Reallocate tile widths after text updates (especially for network)
      layoutTiles();
    };

    // Apple-style follow pager (lib/pager.js): the row follows the pointer
    // with its neighbour attached, both in one frame.
    const rowDistance = () => {
      const paneBox = container.get_allocation_box();
      const pageW = Math.max(1, Math.floor(paneBox.get_width()) - CONTAINER_PAD * 2);
      return pageW + Math.round(pageW / 16);
    };
    const dropRow = row => {
      if (!row || isActorDestroyed(row)) return;
      row.get_parent()?.remove_child(row);
      row.destroy();
    };
    const feed = () => {
      if (monitor.lastData.cpu > 0 || monitor.lastData.ram > 0)
        onData(monitor.lastData);
    };
    attachFollowPager(container, {
      isAlive: () => !tornDown,
      distance: rowDistance,
      begin: (dir) => {
        const leaving = currentRow;
        if (!leaving) return null;
        const index = (currentView + dir + viewConfigs.length) % viewConfigs.length;
        // The entering build is the last one: the live tiles feed it.
        const entering = buildRow(container, index);
        layoutRows = [leaving, entering];
        layoutTiles();
        feed();
        return {leaving, entering, index};
      },
      discard: (pair) => {
        dropRow(pair.entering);
        currentRow = pair.leaving;
      },
      commit: (pair) => {
        currentView = pair.index;
        // Remember the page for the next re-render (theme switch, resize...).
        saveWidgetState(statePath, { view: currentView });
        refreshDashes();
      },
      settledCommit: (pair) => {
        dropRow(pair.leaving);
        currentRow = pair.entering;
        layoutRows = [currentRow];
        layoutTiles();
        feed();
      },
      settledCancel: (pair) => {
        dropRow(pair.entering);
        // The live tiles pointed at the dropped neighbour: rebuild the
        // current row in place (identical content, no fade).
        rebuild();
        feed();
      },
    });
    rebuild();
    unsubscribe = monitor.subscribe(onData);
    refreshDashes();

  } else if (size === 'large') {
    layoutMode = 'large';

    const tilesGrid = new St.BoxLayout(boxLayoutProps({
      vertical: true,
      x_expand: true,
      y_expand: true,
      style: `spacing: 10px;`,
    }));

    const topRow = new St.BoxLayout(boxLayoutProps({
      x_expand: true,
      style: `spacing: 10px;`,
    }));

    const bottomRow = new St.BoxLayout(boxLayoutProps({
      x_expand: true,
      style: `spacing: 10px;`,
    }));

    const cpuExtraInfo = monitor.lastData.cpuTemp > 0 ? `${Math.round(monitor.lastData.cpuTemp)}°C` : null;
    const cpuTile = createSparkTile(theme, 'CPU', '0', '%', accentColor, monitor.lastData.cpuSamples, 1.0, cpuExtraInfo, 'cpu');
    const ramTile = createSparkTile(theme, 'RAM', '0', '%', accentColor, monitor.lastData.ramSamples, 1.0, formatMem(monitor.lastData.ramUsed), 'ram');
    const downTile = createSparkTile(theme, 'Download', '0', 'KB/s', accentColor, monitor.lastData.netDownSamples, 10, null, 'networkDown');
    const upTile = createSparkTile(theme, 'Upload', '0', 'KB/s', accentColor, monitor.lastData.netUpSamples, 10, null, 'networkUp');

    topRow.add_child(cpuTile.tile);
    topRow.add_child(ramTile.tile);
    bottomRow.add_child(downTile.tile);
    bottomRow.add_child(upTile.tile);

    tilesGrid.add_child(topRow);
    tilesGrid.add_child(bottomRow);
    container.add_child(tilesGrid);
    layoutRows = [topRow, bottomRow];
    layoutTiles();

    const onData = (data) => {
      cpuTile.valueLabel.set_text(String(Math.round(data.cpu * 100)));
      ramTile.valueLabel.set_text(String(Math.round(data.ram * 100)));

      if (ramTile.extraLabel) {
        const usedMem = formatMem(data.ramUsed);
        if (usedMem) {
          ramTile.extraLabel.set_text(usedMem);
          ramTile.extraLabel.show();
        } else {
          ramTile.extraLabel.hide();
        }
      }

      if (cpuTile.extraLabel && data.cpuTemp > 0) {
        cpuTile.extraLabel.set_text(`${Math.round(data.cpuTemp)}°C`);
        cpuTile.extraLabel.show();
      }

      const [dVal, dUnit] = formatBytes(data.networkDown);
      downTile.valueLabel.set_text(dVal);
      downTile.unitLabel.set_text(dUnit);

      const [uVal, uUnit] = formatBytes(data.networkUp);
      upTile.valueLabel.set_text(uVal);
      upTile.unitLabel.set_text(uUnit);

      cpuTile.sparkArea.queue_repaint();
      ramTile.sparkArea.queue_repaint();
      downTile.sparkArea.queue_repaint();
      upTile.sparkArea.queue_repaint();
    };

    unsubscribe = monitor.subscribe(onData);

    // The 2x2 shows every metric at once — no pages, so no dashes here.
    // Calling with visible:false still removes a stale strip left behind
    // by the 2x1 (the wrapper survives resizes; only the body refills).
    attachPageDashes({ paneRoot, sizeForWidget, widget, count: 0, visible: false });
  }

  body.add_child(container);

  // The body is refilled in place on theme/style changes (its CHILDREN are
  // destroyed, the body itself survives) — a destroy hook on the body alone
  // never fires there, so onData stayed subscribed and kept poking DEAD
  // actors on every monitor tick (the endless "already disposed" spam and
  // eventual visual blanks). Anchor the same teardown to the pane: that
  // actor dies on every refill too.
  let tornDown = false;
  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    // Cancel all active ease animations to prevent ghost content
    for (const actor of animatingActors) {
      actor.remove_all_transitions();
    }
    animatingActors.clear();

    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };
  container.connect('destroy', teardown);
  body.connect('destroy', teardown);

}

export function style(theme) {
  return `
    background-color: ${theme.background};
    border: ${theme.borderWidth}px solid ${theme.border};
    border-radius: ${theme.radius}px;
  `;
}
