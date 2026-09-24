# Rationale: Configurable widget gap

## Context

Зараз `WIDGET_GAP = 10` захардкоджено в `extension.js`. Це проміжок між віджетами і краєм екрана, що використовується у `_makeDraggable`, `_clampWidget` (через монітор bounds), і `_findOpenPosition`. Користувачі можуть хотіти щільніший layout (gap 0-5px) або просторіший (gap 20-30px).

Треба зберігати gap у gsettings schema, читати його при enable, і оновлювати live коли користувач змінює slider у prefs. Існуюча константа стає fallback значенням.

## Options considered

### Option 1: Slider 0-50px у prefs, gsettings `widget-gap`, live reload через signal

Додати Adw.SpinRow у prefs під розділ General → Widgets. Зберігати значення у gsettings schema як integer ключ `widget-gap` (default 10). Extension підписується на `changed::widget-gap` при enable і оновлює `this._widgetGap`, який замінює всі місця де була константа.

**Pros**:
- Slider інтуїтивний, швидко налаштувати
- Діапазон 0-50px покриває реалістичні випадки (0 = щільно, 50 = дуже просторо)
- Live reload без рестарту сесії
- gsettings автоматично валідує integer range

**Cons**:
- Треба оновити schema і перекомпілювати
- Треба прокинути `this._widgetGap` через всі методи, де використовується gap

### Option 2: Text input у prefs

Замість slider — Adw.EntryRow з валідацією числа 0-50.

**Pros**:
- Точний контроль (користувач вводить exact значення)

**Cons**:
- Менш інтуїтивний ніж slider
- Потрібна явна валідація input (не пусто, не буква, в діапазоні)
- Slider швидше для drag-налаштування

### Option 3: Dropdown з фіксованими варіантами

Dropdown: None (0px), Small (5px), Default (10px), Large (20px), Extra Large (30px).

**Pros**:
- Простий вибір, не треба думати про числа

**Cons**:
- Менше гнучкості (не можна встановити gap 12px)
- Dropdown займає більше місця в UI
- Slider дає краще відчуття діапазону