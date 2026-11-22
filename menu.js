'use strict';

const menuChoice = byId('menu-choice');
const menuAdd = byId('menu-add');
const newMenu = byId('new-menu');
let activeMenuId;
let menuBusy = false;

const normalizedUnits = new Map([
  ...['кг','килограмм','килограмма','килограммов','kg'].map(unit => [unit, ['г', 1000]]),
  ...['г','гр','грамм','грамма','граммов','g'].map(unit => [unit, ['г', 1]]),
  ...['мг','mg'].map(unit => [unit, ['г', 0.001]]),
  ...['л','литр','литра','литров','l'].map(unit => [unit, ['мл', 1000]]),
  ...['мл','ml'].map(unit => [unit, ['мл', 1]]),
  ...['шт','штука','штуки','штук'].map(unit => [unit, ['шт.', 1]]),
  ['ч л', ['ч. л.', 1]], ['чл', ['ч. л.', 1]],
  ['ст л', ['ст. л.', 1]], ['стл', ['ст. л.', 1]],
  ...['стакан','стакана','стаканов'].map(unit => [unit, ['стак.', 1]])
]);

function normalizedName(name) {
  return name.toLowerCase().replace(/ё/g, 'е').trim().replace(/\s+/g, ' ');
}

function shoppingItems(entries, recipes) {
  const groups = new Map();
  for (const entry of entries) {
    const recipe = recipes.get(entry.recipeId);
    if (!recipe) continue;
    for (const item of recipe.ingredients) {
      const unitKey = normalizedName(item.unit).replace(/\./g, '');
      const eggs = /^(?:яйцо|яйца|яиц)$/u.test(normalizedName(item.name));
      const name = eggs ? 'Яйца' : item.name;
      const [unit, factor] = normalizedUnits.get(unitKey) || [eggs && !unitKey ? 'шт.' : item.unit, 1];
      const bounds = amountBounds(item.amount);
      const key = JSON.stringify([normalizedName(name), normalizedName(unit),
        bounds ? null : normalizedName(item.amount)]);
      if (!groups.has(key)) groups.set(key, {name, unit, low: 0, high: 0, text: bounds ? null : item.amount});
      if (bounds) {
        const group = groups.get(key);
        const scale = factor * entry.servings / recipe.servings;
        group.low += bounds[0] * scale;
        group.high += bounds[1] * scale;
      }
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')).map(item => {
    let {low, high, unit} = item;
    if (low >= 1000 && (unit === 'г' || unit === 'мл')) {
      low /= 1000;
      high /= 1000;
      unit = unit === 'г' ? 'кг' : 'л';
    }
    const amount = item.text ?? formatBounds(low, high, item.name, unit);
    const quantity = [amount, unit].filter(Boolean).join(' ');
    return quantity ? item.name + ' — ' + quantity : item.name;
  });
}

function option(value, label) {
  const node = element('option', label);
  node.value = value;
  return node;
}

async function renderMenus() {
  const [menus, recipes] = await Promise.all([
    transact('readonly', store => store.getAll(), 'menus'),
    transact('readonly', store => store.getAll())
  ]);
  const active = menus.find(menu => menu.id === activeMenuId) || menus.at(-1);
  activeMenuId = active?.id;
  byId('menu-panel').hidden = !active;
  if (!active) return;
  menuChoice.replaceChildren(...menus.map(menu => option(menu.id, menu.name)));
  menuChoice.value = active.id;
  const available = new Map(recipes.map(recipe => [recipe.id, recipe]));
  const select = menuAdd.elements.recipe;
  const servings = menuAdd.elements.servings;
  const previousRecipeId = +select.value;
  select.replaceChildren(...recipes.map(recipe => option(recipe.id, recipe.title)));
  if (available.has(previousRecipeId)) select.value = previousRecipeId;
  if (!recipes.length) select.append(option('', 'Сначала добавь рецепт'));
  select.disabled = servings.disabled = menuAdd.querySelector('button').disabled = !recipes.length;
  select.onchange = () => { servings.value = available.get(+select.value)?.servings ?? ''; };
  select.onchange();
  const dishes = byId('menu-dishes');
  dishes.replaceChildren();
  for (const [index, entry] of active.entries.entries()) {
    const row = element('li');
    row.className = 'menu-dish';
    const label = element('label', 'Порции');
    const input = element('input');
    input.type = 'number';
    input.min = '1';
    input.max = '999';
    input.inputMode = 'numeric';
    input.value = entry.servings;
    input.onchange = () => {
      if (!input.checkValidity() || !Number.isInteger(input.valueAsNumber)) {
        input.value = entry.servings;
        return;
      }
      changeMenu(() => {
        entry.servings = input.valueAsNumber;
        return storeMenu(active);
      });
    };
    label.append(input);
    const remove = element('button', '×');
    remove.className = 'quiet danger';
    remove.setAttribute('aria-label', 'Убрать блюдо из меню');
    remove.onclick = () => changeMenu(() => {
      active.entries.splice(index, 1);
      return storeMenu(active);
    });
    row.append(element('strong', available.get(entry.recipeId)?.title || 'Рецепт удалён'), label, remove);
    dishes.append(row);
  }
  const shopping = shoppingItems(active.entries, available);
  const copy = byId('copy-shopping');
  copy.disabled = !shopping.length;
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(shopping.join('\n'));
      message('Список продуктов скопирован.');
    } catch {
      message('Не удалось скопировать список. Его можно выделить и скопировать вручную.');
    }
  };
  const purchased = new Set(active.purchased || []);
  const updateProgress = () => {
    const count = shopping.filter(item => purchased.has(item)).length;
    byId('shopping-progress').textContent = shopping.length ? 'Куплено ' + count + ' из ' + shopping.length : '';
  };
  const list = byId('shopping-list');
  list.replaceChildren();
  for (const item of shopping) {
    const row = element('li');
    const label = element('label');
    const check = element('input');
    check.type = 'checkbox';
    check.checked = purchased.has(item);
    check.onchange = async () => {
      const checked = check.checked;
      check.disabled = true;
      try {
        await setPurchased(active.id, item, checked);
        if (checked) purchased.add(item);
        else purchased.delete(item);
        if (list.contains(check)) updateProgress();
      } catch {
        check.checked = !checked;
        message('Не удалось сохранить отметку о покупке.');
      } finally {
        check.disabled = false;
      }
    };
    label.append(check, element('span', item));
    row.append(label);
    list.append(row);
  }
  if (!shopping.length) list.append(element('li', 'Добавь блюда, чтобы рассчитать продукты.'));
  updateProgress();
  menuAdd.onsubmit = event => {
    event.preventDefault();
    const recipe = available.get(+select.value);
    const portions = servings.valueAsNumber;
    if (recipe && servings.checkValidity() && Number.isInteger(portions)) {
      changeMenu(() => {
        active.entries.push({recipeId: recipe.id, servings: portions});
        return storeMenu(active);
      });
    }
  };
  byId('delete-menu').onclick = () => {
    if (confirm('Удалить это меню?')) changeMenu(() => transact('readwrite', store => store.delete(active.id), 'menus'));
  };
}

function setPurchased(menuId, item, checked) {
  return transact('readwrite', store => {
    const request = store.get(menuId);
    request.onsuccess = () => {
      const menu = request.result;
      if (!menu) return;
      const purchased = new Set(menu.purchased || []);
      if (checked) purchased.add(item);
      else purchased.delete(item);
      store.put({...menu, purchased: [...purchased]});
    };
    return request;
  }, 'menus');
}

function storeMenu(menu) {
  return transact('readwrite', store => {
    const request = store.get(menu.id);
    request.onsuccess = () => {
      if (request.result) store.put({...menu, purchased: request.result.purchased});
    };
    return request;
  }, 'menus');
}

async function changeMenu(action) {
  if (menuBusy) return;
  menuBusy = true;
  const panel = byId('menus');
  panel.inert = true;
  try {
    message();
    await action();
    await renderMenus();
  } catch {
    try { await renderMenus(); } catch {}
    message('Не удалось обновить меню. Попробуй ещё раз.');
  } finally {
    panel.inert = false;
    menuBusy = false;
  }
}

newMenu.onsubmit = event => {
  event.preventDefault();
  const name = newMenu.elements.name.value.trim();
  if (!name) { message('Введи название меню.'); return; }
  changeMenu(async () => {
    activeMenuId = await transact('readwrite', store => store.add({name, entries: []}), 'menus');
    newMenu.reset();
  });
};
menuChoice.onchange = () => changeMenu(() => { activeMenuId = +menuChoice.value; });
byId('open-menus').onclick = async event => {
  if (!database) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await renderMenus();
    show('menus');
  } catch {
    message('Не удалось открыть меню. Попробуй ещё раз.');
  } finally {
    button.disabled = false;
  }
};

async function openRecipeInMenu(recipe) {
  try {
    await renderMenus();
    show('menus');
    if (!activeMenuId) {
      message('Сначала создай меню, затем выбери рецепт.');
      return;
    }
    const select = menuAdd.elements.recipe;
    select.value = String(recipe.id);
    select.dispatchEvent(new Event('change'));
    menuAdd.scrollIntoView({behavior: 'smooth', block: 'center'});
  } catch {
    message('Не удалось открыть меню. Попробуй ещё раз.');
  }
}
