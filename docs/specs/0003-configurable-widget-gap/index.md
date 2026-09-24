# 0003. Configurable widget gap

**Date**: 2026-09-24
**Status**: In Progress

## Summary

Додаємо настройку widget gap (проміжок між віджетами на сітці) у prefs під General → Widgets. Зараз це константа `WIDGET_GAP = 10` в коді. Slider 0-50px дозволяє користувачу налаштувати щільність розміщення віджетів на робочому столі: менший gap для більшої кількості віджетів, більший для просторішого layout.

## Requirements

**User stories**:
- Як користувач розширення, я хочу налаштувати проміжок між віджетами, щоб контролювати щільність розміщення на робочому столі.
- Як користувач, я хочу бачити зміну gap одразу після збереження prefs (без виходу з сесії), щоб швидко налаштувати layout.

**Acceptance criteria**:
- **AC-1**: У prefs під General → Widgets з'являється slider "Widget gap (px)" з діапазоном 0-50, default 10, крок 1px
- **AC-2**: Значення gap зберігається у gsettings schema під ключем `widget-gap` (integer)
- **AC-3**: При зміні slider у prefs значення зберігається в gsettings і оновлюється live у розширенні через `changed::widget-gap` signal (без потреби виходу з сесії)
- **AC-4**: Extension читає `widget-gap` з gsettings при enable і використовує його замість константи `WIDGET_GAP`; якщо ключ відсутній або невалідний, fallback до 10px
- **AC-5**: Зміна gap застосовується до усіх місць, де використовується WIDGET_GAP: `_makeDraggable` minX/minY/maxX/maxY bounds (рядок 1831-1834), `_findOpenPosition` bounds (рядок 2287-2289), будь-які інші місця де раніше була константа

## Rationale

Decision record у [rationale.md](./rationale.md).

## Decision

**Chosen option**: Option 1: Slider 0-50px у prefs, gsettings `widget-gap`, live reload через signal

Slider найінтуїтивніший для налаштування проміжку (користувач одразу бачить діапазон), gsettings дає persistence і валідацію, live reload через signal дозволяє побачити зміну без рестарту сесії. Діапазон 0-50px покриває реалістичні сценарії (більше 50px — надмірно великий gap, менше 0 — не має сенсу).

## Feature design

**Data model sketch**:
Без змін у widget data. Додати один ключ у gsettings schema:
```xml
<key name="widget-gap" type="i">
  <default>10</default>
  <summary>Widget gap in pixels</summary>
  <description>Space between widgets and screen edges (0-50px)</description>
  <range min="0" max="50"/>
</key>
```

**API surface**:
Внутрішні зміни `WidgetController` та `prefs.js`, не публічний API.

| Component | Changes | Key inputs | Key outputs | Notes |
|---|---|---|---|---|
| `schemas/…gschema.xml` | Add `widget-gap` key | none | schema compiled | integer, default 10, range 0-50 |
| `prefs.js` | Add Adw.SpinRow у General page | gsettings | none | Bind `widget-gap` key to SpinRow value property |
| `extension.js` WidgetController | Read `widget-gap` at enable, subscribe to `changed::widget-gap` | gsettings | `this._widgetGap` | Replace hardcoded `WIDGET_GAP` constant; update all usages |
| `_makeDraggable` | Use `this._widgetGap` замість `WIDGET_GAP` | none | none | Lines 1831-1834 minX/minY/maxX/maxY |
| `_findOpenPosition` | Use `this._widgetGap` замість `WIDGET_GAP` | none | none | Lines 2287-2289 minX/minY bounds |

**Value sourcing**:

| Action | Value produced | Source |
|---|---|---|
| prefs slider зміна | gap integer 0-50 | користувач рухає slider, значення зберігається у gsettings через Adw.SpinRow binding |
| extension enable | `this._widgetGap` integer | `this._layoutSettings.get_int('widget-gap')` з fallback до 10 якщо ключ відсутній |
| gsettings signal `changed::widget-gap` | оновлений gap | `this._layoutSettings.connect('changed::widget-gap', () => { this._widgetGap = this._layoutSettings.get_int('widget-gap'); })` |
| minX/maxX/minY/maxY у drag bounds | offset від краю монітора | `this._widgetGap` замість константи `WIDGET_GAP` |

**Key invariants**:
- `widget-gap` завжди integer у діапазоні 0-50 (gsettings range валідація)
- `this._widgetGap` fallback до 10 якщо ключ gsettings відсутній або невалідний
- Live reload працює: зміна slider у prefs → gsettings → signal → extension оновлює `this._widgetGap` → наступний drag використовує новий gap (без рестарту)
- Існуючі віджети не переміщуються при зміні gap (gap застосовується тільки до нового drag/placement)

**Security model**:
Немає нових security concerns. Gap — локальна UI настройка, не впливає на permissions.

**Configuration required**:
- Додати `widget-gap` ключ у `schemas/org.gnome.shell.extensions.desktop-widgets.gschema.xml`
- Перекомпілювати schema після зміни (`glib-compile-schemas schemas/`)

**Critical test scenarios**:
- Happy path: відкрити prefs, змінити slider gap на 20px, зберегти, перетягнути віджет у edit mode, bounds використовують gap 20px (більший проміжок від краю), перевіряє **AC-1**, **AC-2**, **AC-3**, **AC-5**
- Fallback: видалити ключ `widget-gap` з gsettings (dconf reset), рестартнути розширення, gap fallback до 10px, перевіряє **AC-4**
- Live reload: відкрити prefs, змінити gap на 5px, БЕЗ рестарту сесії перетягнути віджет, bounds використовують gap 5px (менший проміжок), перевіряє **AC-3**
- Edge values: встановити gap 0px, перетягнути віджет до самого краю екрана (minX = monitor.x), перевіряє **AC-5**; встановити gap 50px, перетягнути віджет, великий проміжок від краю, перевіряє **AC-5**

## Build plan

Tracer Bullet: додати schema key, потім slider у prefs, потім live reload у extension, потім live перевірка.

1. Додати `widget-gap` ключ у `schemas/org.gnome.shell.extensions.desktop-widgets.gschema.xml`: тип integer, default 10, range 0-50, summary/description, satisfies **AC-2**
2. Перекомпілювати schema через `glib-compile-schemas schemas/` і перевірити що ключ доступний через `gsettings get org.gnome.shell.extensions.desktop-widgets widget-gap`, satisfies **AC-2**
3. Додати Adw.SpinRow у `prefs.js` під General page у розділ Widgets (після інших widget settings якщо є, або створити розділ): label "Widget gap (px)", діапазон 0-50, крок 1, bind до `widget-gap` gsettings key через `this._settings.bind('widget-gap', row, 'value', Gio.SettingsBindFlags.DEFAULT)`, satisfies **AC-1**
4. У `extension.js` WidgetController: читати `this._widgetGap = this._layoutSettings.get_int('widget-gap') || 10` при enable (fallback до 10), підписатись на `this._layoutSettings.connect('changed::widget-gap', () => { this._widgetGap = this._layoutSettings.get_int('widget-gap'); })` для live reload, satisfies **AC-3**, **AC-4**
5. Замінити всі місця де використовується константа `WIDGET_GAP` на `this._widgetGap`: у `_makeDraggable` рядок 1831-1834 (minX/maxX/minY/maxY), у `_findOpenPosition` рядок 2287-2289 (minX/minY), grep-пошук по `WIDGET_GAP` щоб знайти усі випадки, satisfies **AC-5**
6. Статична перевірка `node --check extension.js prefs.js` і жива перевірка у свіжій сесії за контрольним списком Critical test scenarios, satisfies **AC-1**, **AC-2**, **AC-3**, **AC-4**, **AC-5**

## Consequences

**Positive**:
- Користувач контролює щільність layout (gap 0 для максимальної кількості віджетів, gap 30-50 для просторішого вигляду)
- Live reload без рестарту сесії (зміна у prefs одразу застосовується)
- gsettings валідує діапазон автоматично (0-50), не треба явної валідації в коді

**Negative / tradeoffs**:
- Ще одна настройка у prefs (більше опцій = складніший UI); але gap — базова настройка layout, виправдана
- Треба оновити schema і перекомпілювати; користувачі, що встановили розширення вручну, мають запустити `glib-compile-schemas` після git pull
- Існуючі віджети не переміщуються при зміні gap (gap застосовується тільки до нового drag); це правильна поведінка (не руйнувати layout), але користувач може очікувати миттєвого ефекту

**Neutral**:
- Slider займає один рядок у prefs General page
- Fallback до 10px (поточна константа) для backward compatibility

## Follow-up

- [ ] Після live перевірки запустити `glib-compile-schemas schemas/` локально і закомітити як частину зміни (compiled schema входить до репо дляручного встановлення)
- [ ] Оновити README або INSTALL: після git pull треба `glib-compile-schemas schemas/` якщо встановлення ручне