# Verify: Налаштування widget gap · spec 0003 · updated 2026-09-24

_Steps derived from spec 0003 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## UI / manual

- [ ] Відкрити prefs → General → Widgets → бачимо slider "Widget gap (px)" з діапазоном 0-50, default 10, крок 1 → AC-1
- [ ] Змінити slider на 20, закрити prefs → `gsettings get org.gnome.shell.extensions.desktop-widgets-r3nhick widget-gap` показує `20` → AC-2
- [ ] Змінити gap на 20 у prefs, БЕЗ рестарту сесії увімкнути edit mode і перетягнути віджет → проміжок від краю монітора = 20px → AC-3, AC-5
- [ ] `gsettings reset org.gnome.shell.extensions.desktop-widgets-r3nhick widget-gap`, рестартнути розширення → gap повертається до 10px → AC-4
- [ ] Встановити gap 0px, перетягнути віджет до краю екрана → minX = monitor.x (0 проміжку) → AC-5
- [ ] Встановити gap 50px, перетягнути віджет → великий проміжок від краю (50px) → AC-5

## Commands

- [ ] `node --check extension.js prefs.js` → без помилок → statika

## Acceptance-criteria coverage

- AC-1 covered by step 1 · AC-2 covered by step 2 · AC-3 covered by step 3 · AC-4 covered by step 4 · AC-5 covered by steps 5-6