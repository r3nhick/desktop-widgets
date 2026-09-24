# 0002. Widget drag snap behavior

**Date**: 2026-09-24
**Status**: In Progress

## Summary

Змінюємо поведінку drag віджетів так, щоб інші віджети не штовхалися під час перетягування. Коли відпускаєш віджет на зайняту клітинку, він автоматично прилипає до найближчої вільної позиції з плавною анімацією. Це робить розміщення передбачуваним: тягнеш один, інші лишаються на місці.

## Requirements

**User stories**:
- Як користувач розширення, я хочу тягати віджети без штовхання інших, щоб розміщення було передбачуваним і не порушувало чужий layout.
- Як користувач, я хочу, щоб віджет, який я кинув на зайняту позицію, автоматично знайшов найближче вільне місце з плавною анімацією, щоб не треба було вгадувати, куди його поставити вручну.

**Acceptance criteria**:
- **AC-1**: Під час drag (поки кнопка миші затиснута) інші віджети лишаються нерухомими на своїх позиціях; тільки той віджет, що тягнеш, рухається по сітці під курсором
- **AC-2**: При drop на зайняту клітинку віджет автоматично прилипає до найближчої вільної клітинки сітки з ease анімацією через `_animateWidget`
- **AC-3**: Pinned віджети залишаються непорушними під час drag будь-яких інших віджетів і блокують свою клітинку як зайняту для алгоритму `_findOpenPosition`
- **AC-4**: Якщо після drop немає жодної вільної клітинки на всій сітці монітора (весь екран зайнятий), віджет повертається на попередню позицію (oldX/oldY, де він був перед початком drag) з ease анімацією, drop скасовується
- **AC-5**: На multi monitor setup кожен монітор має власну незалежну сітку; віджет не може перестрибнути на інший монітор під час одного drag (поточна поведінка `monitorAtStage` зберігається)
- **AC-6**: Натискання Escape під час активного drag скасовує операцію: віджет миттєво повертається на попередню позицію (oldX/oldY) без анімації, drag state очищується

## Rationale

Decision record у [rationale.md](./rationale.md).

## Decision

**Chosen option**: Option 1: Прибрати виклик `_resolveLayout` з `moveDrag`

Найпростіше і найменш інвазивне рішення. Існуючий `_findOpenPosition` працює правильно, ease анімація через `_animateWidget` на місці, pinned логіка вже є. Треба лише: (1) видалити один рядок виклику з `moveDrag`, (2) зберегти `widget.oldX/oldY` при button-press, (3) перевірити у `finishDrag`, чи `_findOpenPosition` повернув originX/originY без змін (fallback до oldX/oldY), (4) додати Escape handler.

## Feature design

**Data model sketch**:
Без змін. Використовуємо існуючі поля `widget.x`, `widget.y`, `widget.pinned`.

**API surface**:
Внутрішні методи `WidgetController`, не публічний API.

| Method | Changes | Key inputs | Key outputs | Notes |
|---|---|---|---|---|
| `_makeDraggable` | Edit `moveDrag`, `finishDrag`, add Escape handler | view, event | none | Remove `_resolveLayout` call from `moveDrag` line 1845; store `widget.oldX/oldY` at button-press line 1868; check `_findOpenPosition` fallback in `finishDrag`; add Escape key listener |
| `_resolveLayout` | No change | anchor, animate, save | changed: boolean | Викликається тільки з `finishDrag`, не з `moveDrag` |
| `_findOpenPosition` | No change | widget, blockingWidgets | {x, y} | Вже працює правильно; повертає originX/originY якщо немає вільної позиції |

**Value sourcing**:

| Action | Value produced | Source |
|---|---|---|
| finishDrag викликає `_findOpenPosition` | {x, y} найближчої вільної клітинки | `_findOpenPosition` сканує сітку монітора, сортує candidates по Manhattan distance від `originX/originY` (widget.x/widget.y на момент drop), повертає першу вільну або originX/originY як fallback |
| fallback коли немає вільної позиції | oldX, oldY позиція віджета до початку drag | `widget.oldX`, `widget.oldY` зберігаються при button-press (рядок 1868) перед присвоєнням drag state |
| Escape скасовує drag | повертає віджет на oldX/oldY | той самий `widget.oldX/oldY` |
| ease анімація при drop | плавний рух до {x, y} | існуючий `_animateWidget(widget, true)` у finishDrag рядок 1813 |

**Key invariants**:
- Pinned віджети (`widget.pinned === true`) ніколи не рухаються через `_resolveLayout` (рядок 2323) і завжди входять до `blockingWidgets` для `_findOpenPosition`
- `_findOpenPosition` завжди повертає валідні координати: або першу вільну клітинку, або `originX/originY` як fallback
- `widget.oldX/oldY` зберігаються один раз при button-press і очищаються після finishDrag або Escape
- Кожен монітор має незалежну сітку через існуючий `monitorAtStage` (рядок 1825, 2276); drag не перетинає межі монітора

**Security model**:
Немає нових security concerns. Edit mode вже контролює дозвіл на drag через `if (!this._editMode || view.widget.pinned)` рядок 1860.

**Configuration required**:
Немає нових env vars або конфігів. Використовуємо існуючі константи `GRID_SIZE`, `WIDGET_GAP`.

**Critical test scenarios**:
- Happy path: тягнеш віджет через edit mode, кидаєш на зайняту клітинку, віджет плавно анімується до найближчої вільної, інші віджети не рухалися під час drag, перевіряє **AC-1**, **AC-2**
- Pinned віджет: тягнеш unpinned віджет до pinned віджета, кидаєш, алгоритм враховує pinned як зайнятий і знаходить іншу вільну клітинку, перевіряє **AC-3**
- Весь екран зайнятий: тягнеш віджет, на сітці немає вільних клітинок, drop повертає віджет на oldX/oldY з ease анімацією, перевіряє **AC-4**
- Multi monitor: маєш два монітори, тягнеш віджет на першому монітору, алгоритм шукає вільну позицію тільки на першому монітору (той самий `monitor` з `monitorAtStage`), перевіряє **AC-5**
- Escape під час drag: тягнеш віджет, натискаєш Escape, віджет миттєво (без анімації) повертається на oldX/oldY, drag state очищується, перевіряє **AC-6**

## Build plan

Tracer Bullet: вертикальний шматок від видалення виклику `_resolveLayout` до live перевірки всіх AC у свіжій сесії.

1. Зберегти `widget.oldX/oldY` при button-press у `_makeDraggable`: перед присвоєнням `drag` state (рядок ~1869) записати `widget.oldX = widget.x; widget.oldY = widget.y`, satisfies **AC-4**, **AC-6**
2. Видалити виклик `_resolveLayout(widget, false, false)` з `moveDrag` (рядок 1845), satisfies **AC-1**
3. Додати fallback логіку у `finishDrag`: після виклику `_findOpenPosition` (рядок 2334 всередині `_resolveLayout`, який викликається з finishDrag рядок 1812) перевірити, чи повернута позиція дорівнює originX/originY (сигнал "не знайшли вільну"). Якщо так, встановити `widget.x = widget.oldX; widget.y = widget.oldY`, satisfies **AC-4**
4. Додати Escape handler у `_makeDraggable`: підписатись на `key-press-event` у global.stage під час активного drag, при Escape викликати `drag = null`, встановити `widget.x = widget.oldX; widget.y = widget.oldY`, `actor.set_position(widget.x, widget.y)`, очистити drag state без анімації, satisfies **AC-6**
5. Статична перевірка `node --check extension.js` і жива перевірка у свіжій Wayland сесії за контрольним списком Critical test scenarios, satisfies **AC-1**, **AC-2**, **AC-3**, **AC-4**, **AC-5**, **AC-6**

## Consequences

**Positive**:
- Розміщення віджетів стає передбачуваним: тягнеш один, інші не рухаються
- Існуючий `_findOpenPosition` + `_animateWidget` роблять всю важку роботу, нічого не переписуємо
- Pinned логіка працює без змін

**Negative / tradeoffs**:
- Під час drag віджет може тимчасово overlap інші (поки не drop), але це візуально чітко (той віджет piднятий через `raiseActor` рядок 1876)
- Додатковий state `widget.oldX/oldY` живе під час drag; треба очистити після finishDrag або Escape
- Якщо екран повністю забитий віджетами і немає вільної клітинки, drop скасовується (повернення на oldX/oldY); це правильна поведінка, але користувач має побачити, що місця немає

**Neutral**:
- Multi monitor поведінка без змін (окремі сітки через існуючий `monitorAtStage`)
- Ease анімація працює як зараз (250ms через існуючу константу `ANIMATION_DURATION`)

## Follow-up

- [x] Після live перевірки запустити `graft build`, граф застаріє через зміни у `extension.js` (completed 2026-09-24)