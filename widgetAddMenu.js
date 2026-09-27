import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CARD_WIDTH = 160;
const CARD_HEIGHT = 180;
const ICON_SIZE = 80;
const CARDS_PER_ROW = 4;
const MENU_PADDING = 20;

// Каталог віджетів без перекладів (оригінальні англійські назви)
const WIDGET_CATALOG_DATA = [
	{
		type: 'clock',
		labelKey: 'Analog Clock',
		descKey: 'Classic round clock',
		icon: 'clock.svg',
		category: 'time',
	},
	{
		type: 'digitalclock',
		labelKey: 'Digital Clock',
		descKey: 'Modern time display',
		icon: 'digidal_clock.svg',
		category: 'time',
	},
	{
		type: 'binaryclock',
		labelKey: 'Binary Clock',
		descKey: 'Geek time display',
		icon: 'binary_clock.svg',
		category: 'time',
	},
	{
		type: 'calendar',
		labelKey: 'Calendar',
		descKey: 'Monthly calendar view',
		icon: 'calendar.svg',
		category: 'productivity',
	},
	{
		type: 'weather',
		labelKey: 'Weather',
		descKey: 'Current conditions',
		icon: 'weather.svg',
		category: 'info',
	},
	{
		type: 'music',
		labelKey: 'Music Player',
		descKey: 'Media controls',
		icon: 'music.svg',
		category: 'media',
	},
	{
		type: 'battery',
		labelKey: 'Battery',
		descKey: 'Power status',
		icon: 'battery.svg',
		category: 'system',
	},
	{
		type: 'system',
		labelKey: 'System Monitor',
		descKey: 'CPU, RAM, Disk',
		icon: 'system_monitor.svg',
		category: 'system',
	},
	{
		type: 'screentime',
		labelKey: 'Screen Time',
		descKey: 'Usage tracker',
		icon: 'sreen_time.svg',
		category: 'productivity',
	},
	{
		type: 'todo',
		labelKey: 'Todo List',
		descKey: 'Task manager',
		icon: 'task.svg',
		category: 'productivity',
	},
	{
		type: 'notes',
		labelKey: 'Notes',
		descKey: 'Quick notes',
		icon: 'notes.svg',
		category: 'productivity',
	},
	{
		type: 'github',
		labelKey: 'GitHub',
		descKey: 'Repository stats',
		icon: 'github.svg',
		category: 'info',
	},
	{
		type: 'photos',
		labelKey: 'Photos',
		descKey: 'Image viewer',
		icon: 'calendar.svg',
		category: 'media',
	},
	{
		type: 'applauncher',
		labelKey: 'App Launcher',
		descKey: 'Quick app access',
		icon: 'task.svg',
		category: 'productivity',
	},
];

const CATEGORY_KEYS = {
	time: 'Time',
	productivity: 'Productivity',
	info: 'Information',
	media: 'Media',
	system: 'System',
};

export const WidgetAddMenu = GObject.registerClass(
class WidgetAddMenu extends St.BoxLayout {
	_init(extensionPath, onWidgetAdd, gettextFn) {
		super._init({
			vertical: true,
			style_class: 'widget-add-menu',
			reactive: true,
			can_focus: true,
			visible: false,
		});

		this._extensionPath = extensionPath;
		this._onWidgetAdd = onWidgetAdd;
		this._ = gettextFn || ((text) => text);
		
		this._buildUI();
	}

	_buildUI() {
		const _ = this._;
		
		// Контейнер з тінню та закругленими кутами
		this.set_style(`
			background-color: rgba(30, 30, 30, 0.95);
			border-radius: 16px;
			padding: ${MENU_PADDING}px;
			box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		`);

		// Заголовок
		const header = new St.BoxLayout({
			vertical: false,
			style: 'spacing: 12px; margin-bottom: 20px;',
		});

		const title = new St.Label({
			text: _('Add Widget'),
			style_class: 'widget-add-menu-title',
			style: 'font-size: 24px; font-weight: 700; color: #ffffff;',
		});

		const closeButton = new St.Button({
			style_class: 'widget-add-menu-close',
			child: new St.Icon({
				icon_name: 'window-close-symbolic',
				icon_size: 20,
				style: 'color: #ffffff;',
			}),
			style: `
				border-radius: 50%;
				padding: 8px;
				background-color: rgba(255, 255, 255, 0.1);
			`,
		});
		closeButton.connect('clicked', () => this.hide());

		header.add_child(title);
		header.add_child(new St.Widget({ x_expand: true })); // spacer
		header.add_child(closeButton);
		this.add_child(header);

		// Прокручувана область з картками
		const scrollView = new St.ScrollView({
			style_class: 'widget-add-menu-scroll',
			hscrollbar_policy: St.PolicyType.NEVER,
			vscrollbar_policy: St.PolicyType.AUTOMATIC,
			overlay_scrollbars: true,
		});

		const contentBox = new St.BoxLayout({
			vertical: true,
			style: 'spacing: 24px;',
		});

		// Групуємо віджети за категоріями
		const categorized = {};
		
		for (const widgetData of WIDGET_CATALOG_DATA) {
			if (!categorized[widgetData.category]) {
				categorized[widgetData.category] = [];
			}
			// Створюємо віджет з перекладами
			categorized[widgetData.category].push({
				type: widgetData.type,
				label: _(widgetData.labelKey),
				description: _(widgetData.descKey),
				icon: widgetData.icon,
				category: widgetData.category,
			});
		}

		// Додаємо категорії
		for (const [categoryKey, widgets] of Object.entries(categorized)) {
			const categoryName = _(CATEGORY_KEYS[categoryKey] || categoryKey);
			const categorySection = this._buildCategory(categoryName, widgets);
			contentBox.add_child(categorySection);
		}

		scrollView.add_child(contentBox);
		this.add_child(scrollView);

		// Розмір меню
		const menuWidth = (CARD_WIDTH + 12) * CARDS_PER_ROW + MENU_PADDING * 2;
		const menuHeight = 600;
		this.set_width(menuWidth);
		this.set_height(menuHeight);
	}

	_buildCategory(categoryName, widgets) {
		const section = new St.BoxLayout({
			vertical: true,
			style: 'spacing: 12px;',
		});

		// Назва категорії
		const categoryLabel = new St.Label({
			text: categoryName,
			style: 'font-size: 16px; font-weight: 600; color: rgba(255, 255, 255, 0.7); margin-bottom: 8px;',
		});
		section.add_child(categoryLabel);

		// Сітка карток
		const grid = new St.Widget({
			layout_manager: new Clutter.GridLayout({ orientation: Clutter.Orientation.HORIZONTAL }),
		});
		const gridLayout = grid.layout_manager;
		gridLayout.set_column_spacing(12);
		gridLayout.set_row_spacing(12);

		let col = 0;
		let row = 0;

		for (const widget of widgets) {
			const card = this._buildWidgetCard(widget);
			gridLayout.attach(card, col, row, 1, 1);

			col++;
			if (col >= CARDS_PER_ROW) {
				col = 0;
				row++;
			}
		}

		section.add_child(grid);
		return section;
	}

	_buildWidgetCard(widgetMeta) {
		const card = new St.Button({
			style_class: 'widget-card',
			reactive: true,
			can_focus: true,
		});

		card.set_width(CARD_WIDTH);
		card.set_height(CARD_HEIGHT);

		const cardBox = new St.BoxLayout({
			vertical: true,
			style: `
				background-color: rgba(255, 255, 255, 0.08);
				border-radius: 12px;
				padding: 16px;
				spacing: 8px;
			`,
		});

		// SVG іконка
		const iconPath = `${this._extensionPath}/assets/icons/${widgetMeta.icon}`;
		const iconFile = Gio.File.new_for_path(iconPath);

		let icon;
		if (iconFile.query_exists(null)) {
			// Використовуємо St.Icon для SVG
			const gicon = Gio.FileIcon.new(iconFile);
			icon = new St.Icon({
				gicon: gicon,
				icon_size: ICON_SIZE,
				style: 'margin-bottom: 8px;',
			});
		} else {
			// Fallback на symbolic icon
			icon = new St.Icon({
				icon_name: 'application-x-addon-symbolic',
				icon_size: ICON_SIZE,
				style: 'color: rgba(255, 255, 255, 0.5); margin-bottom: 8px;',
			});
		}

		const iconBox = new St.Widget({
			layout_manager: new Clutter.BinLayout(),
			y_align: Clutter.ActorAlign.CENTER,
			height: ICON_SIZE + 16,
		});
		iconBox.add_child(icon);
		cardBox.add_child(iconBox);

		// Назва віджета
		const label = new St.Label({
			text: widgetMeta.label,
			style: 'font-size: 14px; font-weight: 600; color: #ffffff; text-align: center;',
		});
		label.clutter_text.set_line_wrap(true);
		label.clutter_text.set_ellipsize(3); // Pango.EllipsizeMode.END
		cardBox.add_child(label);

		// Опис
		const desc = new St.Label({
			text: widgetMeta.description,
			style: 'font-size: 11px; color: rgba(255, 255, 255, 0.6); text-align: center;',
		});
		desc.clutter_text.set_line_wrap(true);
		desc.clutter_text.set_ellipsize(3);
		cardBox.add_child(desc);

		card.set_child(cardBox);

		// Hover ефект
		card.connect('enter-event', () => {
			cardBox.set_style(`
				background-color: rgba(255, 255, 255, 0.15);
				border-radius: 12px;
				padding: 16px;
				spacing: 8px;
				transition-duration: 200ms;
			`);
		});

		card.connect('leave-event', () => {
			cardBox.set_style(`
				background-color: rgba(255, 255, 255, 0.08);
				border-radius: 12px;
				padding: 16px;
				spacing: 8px;
				transition-duration: 200ms;
			`);
		});

		// Клік для додавання віджета
		card.connect('clicked', () => {
			this._onWidgetAdd(widgetMeta.type);
			this.hide();
		});

		return card;
	}

	show() {
		this.visible = true;
		this.opacity = 0;

		this.ease({
			opacity: 255,
			duration: 200,
			mode: Clutter.AnimationMode.EASE_OUT_QUAD,
		});

		// Центруємо на екрані
		const monitor = Main.layoutManager.primaryMonitor;
		const x = monitor.x + (monitor.width - this.width) / 2;
		const y = monitor.y + (monitor.height - this.height) / 2;
		this.set_position(Math.floor(x), Math.floor(y));

		this.grab_key_focus();
	}

	hide() {
		this.ease({
			opacity: 0,
			duration: 200,
			mode: Clutter.AnimationMode.EASE_IN_QUAD,
			onComplete: () => {
				this.visible = false;
			},
		});
	}

	vfunc_key_press_event(event) {
		const symbol = event.get_key_symbol();
		if (symbol === Clutter.KEY_Escape) {
			this.hide();
			return Clutter.EVENT_STOP;
		}
		return Clutter.EVENT_PROPAGATE;
	}
});
