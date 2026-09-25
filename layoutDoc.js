// Контракт документа розкладки: його версія та єдиний спосіб його записати.
// Імпортується і розширенням, і вікном налаштувань, щоб обидва процеси
// зберігали однакову версію.

const LAYOUT_KEY = 'layout-json';
const LAYOUT_VERSION = 3;

// Єдине місце, де версія потрапляє в документ, тож документ без version
// неможливо створити ні з одного боку.
function layoutJson(widgets) {
  return JSON.stringify({version: LAYOUT_VERSION, widgets});
};

// Порожній рядок означає «розкладку не задано»: розширення повертає типові
// віджети. Це не документ, тож версія тут не потрібна.
function clearLayout(settings) {
  settings.set_string(LAYOUT_KEY, '');
};

function writeLayout(settings, widgets) {
  settings.set_string(LAYOUT_KEY, layoutJson(widgets));
};

export { LAYOUT_KEY, LAYOUT_VERSION, clearLayout, layoutJson, writeLayout };
