# Rationale: Widget drag snap behavior

## Context

Зараз під час drag `_makeDraggable` викликає `_resolveLayout(widget, false, false)` у `moveDrag` (extension.js:1845), і той штовхає інші віджети через `_findOpenPosition`, якщо перетинаються. Це створює небажаний ефект: коли тягнеш один віджет і він перетинається з іншим, той інший миттєво переміщується у вільну позицію. Користувач скаржиться: «зачіпили інший він тож переміщається цього не тре».

Потрібна поведінка: під час drag тільки той віджет, що тягнеш, рухається; інші лишаються нерухомими. При drop (button release) система знаходить найближчу вільну клітинку і плавно переміщує туди віджет з ease анімацією. Якщо вільних клітинок немає взагалі (весь екран зайнятий), віджет повертається на попередню позицію до початку drag.

Механізм `_findOpenPosition` уже існує і працює правильно (рядок 2272): він проходить усі клітинки сітки, сортує їх по Manhattan distance від позиції drop і повертає першу вільну. Проблема — він викликається під час руху миші, а не лише після drop.

## Options considered

### Option 1: Прибрати виклик `_resolveLayout` з `moveDrag`

Найпростіше рішення: видалити рядок 1845 `this._resolveLayout(widget, false, false)` з обробника `moveDrag`, лишити виклик тільки у `finishDrag` (рядок 1812). Зберігати `widget.oldX` і `widget.oldY` при button-press (рядок 1848), щоб повернутися туди, якщо `_findOpenPosition` не знайде вільного місця.

**Pros**:
- Мінімальна зміна: один рядок видалити, три рядки додати (збереження oldX/oldY + перевірка fallback у finishDrag)
- Існуючий `_findOpenPosition` працює правильно, нічого переписувати не треба
- Ease анімація через існуючий `_animateWidget(widget, true)` у finishDrag працює без змін
- Pinned логіка вже є у `_resolveLayout` (рядок 2323: skip якщо pinned), нічого додавати

**Cons**:
- Під час drag віджет може рухатися поверх інших (overlap), але це тимчасове, до drop
- Треба явно додати Escape handler для скасування drag

### Option 2: Параметр `duringDrag` у `_resolveLayout`

Додати параметр `duringDrag: boolean` у `_resolveLayout`, і якщо він true, пропускати блок рядків 2333-2338 (перевірка overlap і виклик `_findOpenPosition`). Викликати `_resolveLayout(widget, false, false, true)` з `moveDrag`, `_resolveLayout(widget, true, false, false)` з `finishDrag`.

**Pros**:
- Явний контроль через параметр, код читабельний
- `_resolveLayout` лишається єдиним місцем логіки collision

**Cons**:
- Складніша сигнатура методу (4 параметри, третій boolean завжди `false` зараз)
- Більше коду ніж Option 1, але з тим самим результатом
- Додатковий параметр прокидається через усі виклики

### Option 3: Новий метод `_snapToNearestEdge`

Створити окремий метод замість повторного використання `_findOpenPosition`. Він би робив те саме, але був би явним для drop-only логіки.

**Pros**:
- Явна назва, читабельний код

**Cons**:
- Дублювання коду: `_findOpenPosition` робить саме те, що треба (Manhattan distance sort + перша вільна)
- Більше методів = більше підтримки