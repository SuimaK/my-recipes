// Хранилище в localStorage. Одна точка правды для рецептов и меню.
const KEY = 'my-recipes.v2';
const LEGACY_KEYS = ['recipes', 'myRecipes', 'my-recipes'];

function uid() {
  return (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const data = JSON.parse(raw);
      return { recipes: Array.isArray(data.recipes) ? data.recipes : [], menu: Array.isArray(data.menu) ? data.menu : [], checked: data.checked || {} };
    }
    // Переносим данные из старой версии приложения, если они есть в этом браузере.
    for (const k of LEGACY_KEYS) {
      const old = localStorage.getItem(k);
      if (!old) continue;
      const list = JSON.parse(old);
      if (Array.isArray(list) && list.length) return { recipes: list.map((r) => ({ ...r, id: r.id || uid() })), menu: [], checked: {} };
    }
  } catch (e) {
    console.warn('Не удалось прочитать сохранённые рецепты', e);
  }
  return { recipes: [], menu: [], checked: {} };
}

const state = load();
const listeners = new Set();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    // Обычно — переполнено место из-за фотографий.
    listeners.forEach((fn) => fn({ error: 'Не хватает места в браузере. Удалите фото у части рецептов или сделайте копию и очистите книгу.' }));
    throw e;
  }
  listeners.forEach((fn) => fn({}));
}

export const store = {
  get recipes() { return state.recipes; },
  get menu() { return state.menu; },
  get checked() { return state.checked; },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  byId(id) { return state.recipes.find((r) => r.id === id); },

  /** Добавляет рецепты; возвращает их id. */
  add(recipes) {
    const now = Date.now();
    const added = recipes.map((r) => ({ ...r, id: uid(), createdAt: now, updatedAt: now }));
    state.recipes.unshift(...added);
    save();
    return added.map((r) => r.id);
  },
  update(id, patch) {
    const r = this.byId(id);
    if (!r) return;
    Object.assign(r, patch, { updatedAt: Date.now() });
    save();
  },
  remove(ids) {
    const set = new Set([].concat(ids));
    state.recipes = state.recipes.filter((r) => !set.has(r.id));
    state.menu = state.menu.filter((id) => !set.has(id));
    save();
  },
  toggleMenu(id) {
    state.menu = state.menu.includes(id) ? state.menu.filter((x) => x !== id) : [...state.menu, id];
    save();
  },
  clearMenu() { state.menu = []; state.checked = {}; save(); },
  setChecked(key, value) { if (value) state.checked[key] = true; else delete state.checked[key]; save(); },
  replaceAll(recipes) { state.recipes = recipes; state.menu = []; state.checked = {}; save(); },
  exportJson() {
    return JSON.stringify({ app: 'my-recipes', version: 2, exportedAt: new Date().toISOString(), recipes: state.recipes, menu: state.menu }, null, 2);
  },
};
