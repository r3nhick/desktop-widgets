# Scope: Desktop Widgets

Розширення GNOME Shell з десктоп-віджетами: годинники, календар, погода,
фото, батарея, музика, notes, todo, github, screentime та системний монітор,
розкладені по сітці на робочому столі. Fork проєкту Widgets.

**Build approach:** Tracer Bullet (кожне виправлення — наскрізний вертикальний шматок, доведений до робочого стану: знайшов баг, виправив, перевірив).
**Workflow:** Beta (/check verify, потім /test після кожного /develop). `/architect` — рекомендований перший крок для фічі з реальним рішенням, але його можна пропустити, якщо вже знаєш, що будувати. Будь-яка фіча може нести свій тег для більшого чи меншого процесу.

_Це рекомендації, щоб тримати збірку в порядку, а не вимоги. Пропускай те, що не пасує. Ти вирішуєш, коли фіча `done`._

## At a glance

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| A | Widget engine та сітка | Existing | existing |
| B | Бібліотека віджетів | Existing | existing |
| C | Локалізація uk, ru | Existing | existing |
| 1 | Вирівнювання тайлів System Monitor | Slice 1 | in-progress |
| 2 | Скан і виправлення багів усього проєкту | Slice 1 | planned |
| 3 | Розміщення та прилипання віджетів | Slice 1 | in-progress |
| 4 | Налаштування widget gap | Slice 1 | in-progress |

## Existing (перед workflow)

### A. Widget engine та сітка · existing
Ядро розширення: розкладка по сітці, edit mode, drag і resize, піном,
контекстні меню, стилі, погода та батарея як джерела даних. code in `extension.js`

### B. Бібліотека віджетів · existing
14 готових віджетів, кожен як самодостатній модуль у `widgets/<type>/widget.js`
з контрактом `type`, `defaultSize`, `supportedSizes`, `style(theme)`, `render(...)`.
code in `widgets/`

### C. Локалізація uk, ru · existing
Переклади через gettext, каталоги в `po/`, зібрані в `locale/`, скрипт
`tools/extract-strings.mjs`. code in `po/`, `locale/`, `tools/extract-strings.mjs`

## Slice 1: Скан і виправлення багів

### 1. Вирівнювання тайлів System Monitor · in-progress
Незавершена робота над системним монітором: у рядах 2×1 і 2×2 перші блоки
(CPU, RAM) ширші за другі (Download, Upload), ширина тайлів у ряді нерівна.
Температура CPU/GPU має сидіти праворуч по краю. Попередній фікс не спрацював,
тож треба розібратися, чому стилі min/max width не дають рівності.
**Done when:** усі тайли в ряду однакової ширини в кожному перегляді, температура
притиснута до правого краю заголовка, і робота закомічена.
Spec: [0001](../specs/0001-system-tiles-equal-width/index.md)
- [x] Design it (spec): рівні тайли з реальної алокації контейнера
- [x] Build it: /develop вирівнювання тайлів System Monitor
  - [x] Механізм `layoutTiles()` + підписка на алокацію для medium (AC-1, AC-4)
  - [x] Розкладка large: ширина тайлам, висота рядам (AC-2, AC-4)
  - [x] Виклик `layoutTiles()` після rebuild у medium (AC-1, AC-5)
  - [x] Статика з `node --check`, жива перевірка в свіжій сесії (AC-1..AC-5) — підтверджено користувачем
- [x] Verify it: /check verify вирівнювання тайлів System Monitor
- [ ] Test it: /test вирівнювання тайлів System Monitor

### 2. Скан і виправлення багів усього проєкту
Прогнати перевірку по всьому коду: всі віджети, `extension.js`, `prefs.js`,
утиліти, переклади. Знайти баги, конфлікти і застарілі місця та виправити їх.
**Done when:** знайдені баги виправлені, конфліктів у коді немає, широкі
симптоми перевірені на живому розширенні через /check verify і /test.
- [ ] Сканувати, знайти і виправити: `/develop скан і виправлення багів`

### 3. Розміщення та прилипання віджетів · in-progress
Під час drag віджет прилипає до сітки, а інші віджети не рухаються: зараз
`_resolveLayout` + `_findOpenPosition` штовхають зачеплений віджет у вільну
позицію (AC: прилипання до найближчої вільної клітинки, без overlap).
**Done when:** під час перетягування віджет прилипає до сітки, зачеплені віджети
не змінюють позицію, при кидку на зайняту клітинку віджет стає на найближчу
вільну, поведінка перевірена на живому розширенні.
Spec: [0002](../specs/0002-widget-drag-snap-behavior/index.md)
- [x] Design it (spec): видалити виклик `_resolveLayout` з `moveDrag`, fallback до oldX/oldY
- [ ] Build it: /develop розміщення та прилипання віджетів
  - [x] Зберегти oldX/oldY при button-press + видалити `_resolveLayout` з `moveDrag` (AC-1, AC-4, AC-6)
  - [x] Fallback логіка у `finishDrag` + Escape handler (AC-4, AC-6)
  - [ ] Жива перевірка у свіжій сесії (AC-1..AC-6)
- [ ] Verify it: /check verify розміщення та прилипання віджетів
- [ ] Test it: /test розміщення та прилипання віджетів

### 4. Налаштування widget gap · in-progress
Додати slider у prefs (General → Widgets) для налаштування проміжку між віджетами:
зараз `WIDGET_GAP = 10` захардкоджено в коді. Slider 0-50px дозволяє користувачу
контролювати щільність розміщення віджетів на робочому столі.
**Done when:** у prefs є slider "Widget gap (px)" 0-50, значення зберігається у
gsettings і застосовується live (без рестарту), зміна gap перевірена на живому
розширенні.
Spec: [0003](../specs/0003-configurable-widget-gap/index.md)
- [x] Design it (spec): slider 0-50px у prefs, gsettings `widget-gap`, live reload через signal
- [ ] Build it: /develop налаштування widget gap
  - [x] Додати `widget-gap` key у schema + slider у prefs (AC-1, AC-2)
  - [x] Extension читає gap з gsettings при enable + live reload через signal (AC-3, AC-4)
  - [x] Замінити константу `WIDGET_GAP` на `this._widgetGap` у всіх місцях (AC-5)
  - [ ] Статика + жива перевірка (AC-1..AC-5)
- [ ] Verify it: /check verify налаштування widget gap
- [ ] Test it: /test налаштування widget gap

## Legend

**Decision box.** Кожна фіча несе рівно один чекбокс із суфіксом `(spec)`, який
позначає рішення. Інші чекбокси виконують роботу, `/architect` їх не тикає.

**Життєвий цикл фічі**: `planned` → `in-progress` → `done`, плюс `existing`
(бло до workflow) та `dropped` (прибрали, лишається для історії). `existing`
не `done`: воно не з цього workflow, тож `/develop` і `/sync` його не чіпають.

**Workflow** (рядок у шапці) — проєктний рівень ригору після `/develop`:
Prototype = нічого, Alpha = /check verify, Beta = /check verify + /test,
GA = додає свіжий модельного /check review + /document.

**Next step** = перший невідмічений чекбокс (завжди команда або відстежуваний
milestone). **needs a decision** = спершу `/architect`, інакше одразу `/develop`.