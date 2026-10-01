/**
 * Compatibility helper for GNOME 50/51
 * 
 * In GNOME 51, St.BoxLayout no longer accepts `vertical` property.
 * Instead, it uses `orientation` with Clutter.Orientation enum.
 * 
 * This helper creates the correct properties object for both versions.
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

/**
 * Get GNOME Shell major version
 * @returns {number} Major version (50, 51, etc.)
 */
function getGnomeVersion() {
	const version = Config.PACKAGE_VERSION;
	return parseInt(version.split('.')[0], 10);
}

const GNOME_VERSION = getGnomeVersion();

/**
 * Create BoxLayout properties compatible with both GNOME 50 and 51
 * 
 * @param {object} props - BoxLayout properties
 * @param {boolean} [props.vertical] - True for vertical layout (GNOME 50 style)
 * @param {Clutter.Orientation} [props.orientation] - Orientation (GNOME 51 style)
 * @returns {object} Properties object compatible with current GNOME version
 * 
 * @example
 * // Works on both GNOME 50 and 51:
 * const box = new St.BoxLayout(boxLayoutProps({
 *   vertical: true,
 *   style: 'spacing: 10px;'
 * }));
 */
export function boxLayoutProps(props) {
	const result = {...props};
	
	if (GNOME_VERSION >= 51) {
		// GNOME 51+: Use orientation instead of vertical
		if ('vertical' in props) {
			delete result.vertical;
			result.orientation = props.vertical 
				? Clutter.Orientation.VERTICAL 
				: Clutter.Orientation.HORIZONTAL;
		}
	} else {
		// GNOME 50: Use vertical instead of orientation
		if ('orientation' in props) {
			delete result.orientation;
			result.vertical = props.orientation === Clutter.Orientation.VERTICAL;
		}
	}
	
	return result;
}

/**
 * Check if running on GNOME 51 or later
 * @returns {boolean}
 */
export function isGnome51Plus() {
	return GNOME_VERSION >= 51;
}

/**
 * Check if running on GNOME 50
 * @returns {boolean}
 */
export function isGnome50() {
	return GNOME_VERSION === 50;
}

/**
 * Get current GNOME Shell version
 * @returns {number}
 */
export function getVersion() {
	return GNOME_VERSION;
}
