# Verify: Вирівнювання тайлів System Monitor · spec 0001 · updated 2026-09-23
_Steps derived from spec 0001 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## UI / manual (жива сесія)

- [x] Свіжа сесія (logout/login), medium: проглянь усі три види (CPU/RAM, GPU/RAM, Download/Upload) → обидва тайли в кожному ряді однакової ширини, включно з випадками без температури → AC-1
- [x] Реалтайм у medium: мережеві значення змінюються з kB/s на MB/s → рамки тайлів лишаються впритул рівними → AC-1
- [x] Свіжа сесія, large: всі чотири тайли однакової ширини, верхній і нижній ряди однакової висоти; рівність тримається поки оновлюються значення → AC-2
- [x] Температура CPU/GPU притиснута до правого краю заголовка свого тайла; у тайлів RAM/Download/Upload права частина порожня і не впливає на ширину → AC-3
- [x] Після стабілізації розкладки повторних перерахунків немає: розмір контейнера стабільний, навантаження на Shell не зростає → AC-4
- [x] Зміна розміру віджета на сітці в medium і large → тайли і ряди перераховуються з реальної алокації контейнера мінус CONTAINER_PAD і проміжок, а не з формули (value sourcing: джерело layoutTiles) → AC-1, AC-2
- [x] Значення температури досі приходить з monitor.lastData.cpuTemp/gpuTemp у extraLabel і лишається праворуч (value sourcing: це джерело не мінялось) → AC-3
- [x] small: один тайл зі свайпом поводиться як раніше, без нових розмірів → AC-5

## Commands

- [x] `node --check widgets/system/widget.js` → проходить без помилок синтаксису → AC-4

## Acceptance-criteria coverage

- AC-1 covered by medium view cycling, realtime step, resize step
- AC-2 covered by large step, resize step
- AC-3 covered by temperature steps (manual + value sourcing)
- AC-4 covered by stability step, static check
- AC-5 covered by small regression step