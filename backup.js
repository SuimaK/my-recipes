'use strict';
// Резервные копии: выгрузка всей базы в JSON и восстановление без повторов.

function backupPhoto(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function readAllForBackup() {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(['recipes', 'menus'], 'readonly');
    const recipes = tx.objectStore('recipes').getAll();
    const menus = tx.objectStore('menus').getAll();
    tx.oncomplete = () => resolve({recipes: recipes.result, menus: menus.result});
    tx.onabort = () => reject(tx.error);
  });
}

byId('export-backup').onclick = async () => {
  const button = byId('export-backup');
  button.disabled = true;
  try {
    const snapshot = await readAllForBackup();
    // Копия собирается по частям: каждый рецепт с фото сразу превращается в отдельный Blob,
    // поэтому в памяти не держится одна огромная строка со всеми фото сразу.
    const parts = ['{"format":"recipekeeper-backup-v1","createdAt":' + JSON.stringify(new Date().toISOString()) + ',"recipes":['];
    for (const [index, source] of snapshot.recipes.entries()) {
      const {thumb, ...recipe} = source; // миниатюра пересоздаётся после восстановления
      recipe.photo = recipe.photo ? await backupPhoto(recipe.photo) : null;
      parts.push(new Blob([(index ? ',' : '') + JSON.stringify(recipe)]));
    }
    parts.push('],"menus":' + JSON.stringify(snapshot.menus) + '}');
    const url = URL.createObjectURL(new Blob(parts, {type: 'application/json'}));
    const link = element('a');
    link.href = url;
    link.download = 'recipes-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    message('Копия подготовлена. Сохрани скачанный файл в «Файлы» или iCloud Drive.');
  } catch {
    message('Не удалось создать копию. Данные не изменены.');
  } finally {
    button.disabled = false;
  }
};

const isText = value => typeof value === 'string';

function validateBackup(data) {
  if (data?.format !== 'recipekeeper-backup-v1' || !Array.isArray(data.recipes) || !Array.isArray(data.menus)) {
    throw Error('Неверный формат копии');
  }
  const ids = new Set();
  for (const recipe of data.recipes) {
    if (!Number.isInteger(recipe?.id) || ids.has(recipe.id) || !isText(recipe.title) || !recipe.title.trim()
        || !isText(recipe.instructions) || !Number.isInteger(recipe.servings) || recipe.servings < 1 || recipe.servings > 999
        || !Array.isArray(recipe.ingredients)
        || recipe.ingredients.some(item => !item || ['name', 'amount', 'unit'].some(key => !isText(item[key])))) {
      throw Error('Повреждён рецепт');
    }
    ids.add(recipe.id);
    if (recipe.comments != null && (!Array.isArray(recipe.comments) || recipe.comments.some(comment =>
      !comment || !isText(comment.text) || !isText(comment.id) || !Number.isFinite(Date.parse(comment.createdAt))))) {
      throw Error('Повреждены заметки');
    }
    if (recipe.importKey != null && !isText(recipe.importKey)) delete recipe.importKey;
    delete recipe.thumb;
    if (recipe.photo != null) {
      if (!isText(recipe.photo) || !/^data:image\/(jpeg|png|webp|gif|heic|heif);base64,/i.test(recipe.photo)) {
        throw Error('Неверный формат фото');
      }
      const [header, body] = recipe.photo.split(',');
      const bytes = Uint8Array.from(atob(body), character => character.charCodeAt(0));
      recipe.photo = new Blob([bytes], {type: header.slice(5, header.indexOf(';'))});
    }
  }
  for (const menu of data.menus) {
    if (!isText(menu?.name) || !Array.isArray(menu.entries)
        || menu.entries.some(entry => !ids.has(entry?.recipeId) || !Number.isInteger(entry.servings)
          || entry.servings < 1 || entry.servings > 999)
        || (menu.purchased != null && (!Array.isArray(menu.purchased) || menu.purchased.some(item => !isText(item))))) {
      throw Error('Повреждено меню или отсутствует связанный рецепт');
    }
  }
  return data;
}

/** Одинаковые рецепты: совпадают название, инструкция и ингредиенты. Фото, заметки и избранное не учитываются. */
function recipeFingerprint(recipe) {
  return JSON.stringify([normalizeRecipeTitle(recipe.title), String(recipe.instructions || '').trim(),
    (recipe.ingredients || []).map(item => [item.name, item.amount, item.unit].map(value => String(value || '').trim()))]);
}

/** Одинаковые меню: совпадают название и блюда с порциями. Отметки о покупках не учитываются. */
function menuFingerprint(menu) {
  return JSON.stringify([normalizeRecipeTitle(menu.name), (menu.entries || []).map(entry => [entry.recipeId, entry.servings])]);
}

/** Добавляет рецепты и меню из копии одной транзакцией: при ошибке не сохраняется ничего. */
function restoreBackup(data) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(['recipes', 'menus'], 'readwrite');
    const recipes = tx.objectStore('recipes');
    const menus = tx.objectStore('menus');
    const result = {added: 0, skipped: 0, menusAdded: 0, menusSkipped: 0};
    const existingRecipes = recipes.getAll();
    const existingMenus = menus.getAll();
    existingMenus.onsuccess = () => {
      const known = new Map(existingRecipes.result.map(recipe => [recipeFingerprint(recipe), recipe.id]));
      const knownMenus = new Set(existingMenus.result.map(menuFingerprint));
      const mapping = new Map();     // id в копии → id в книге
      const firstInBackup = new Map(); // отпечаток → id первого такого рецепта в копии
      const aliases = [];            // повторы внутри самой копии
      let pending = 0;
      const addMenus = () => {
        for (const [id, firstId] of aliases) mapping.set(id, mapping.get(firstId));
        for (const {id, ...source} of data.menus) {
          const entries = source.entries.map(entry => ({...entry, recipeId: mapping.get(entry.recipeId)}))
            .filter(entry => entry.recipeId !== undefined);
          const menu = {...source, entries};
          const key = menuFingerprint(menu);
          if (knownMenus.has(key)) { result.menusSkipped++; continue; }
          knownMenus.add(key);
          menus.add(menu);
          result.menusAdded++;
        }
      };
      for (const {id, ...recipe} of data.recipes) {
        const key = recipeFingerprint(recipe);
        if (known.has(key)) { mapping.set(id, known.get(key)); result.skipped++; continue; }
        if (firstInBackup.has(key)) { aliases.push([id, firstInBackup.get(key)]); result.skipped++; continue; }
        firstInBackup.set(key, id);
        pending++;
        const request = recipes.add(recipe);
        request.onsuccess = () => {
          mapping.set(id, request.result);
          result.added++;
          if (--pending === 0) addMenus();
        };
      }
      if (!pending) addMenus();
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error);
  });
}

let restoreData;

/** Проверяет копию и готовит кнопку «Добавить из копии». data — уже разобранный JSON, если он есть. */
async function loadBackupFile(file, data) {
  restoreData = null;
  byId('restore-backup').disabled = true;
  try {
    if (file.size > 250 * 1024 * 1024) throw Error('Копия больше 250 МБ');
    restoreData = validateBackup(data ?? JSON.parse(await file.text()));
    byId('restore-info').textContent = `Рецептов: ${restoreData.recipes.length}, меню: ${restoreData.menus.length}.`;
    byId('restore-backup').disabled = false;
  } catch (error) {
    byId('restore-info').textContent = 'Копия не загружена: ' + (error instanceof SyntaxError ? 'файл повреждён' : error.message);
  }
}

byId('restore-file').onchange = event => {
  const file = event.target.files[0];
  if (file) return loadBackupFile(file);
  restoreData = null;
  byId('restore-backup').disabled = true;
};

byId('restore-backup').onclick = async () => {
  if (!restoreData) return;
  const button = byId('restore-backup');
  button.disabled = true;
  let result;
  try {
    result = await restoreBackup(restoreData);
  } catch {
    message('Восстановление отменено из-за ошибки. Частичные данные не сохранены.');
    button.disabled = false;
    return;
  }
  restoreData = null;
  byId('restore-file').value = '';
  byId('restore-info').textContent = '';
  await returnToList();
  message('Копия восстановлена. Добавлено рецептов: ' + result.added
    + (result.skipped ? ', уже были в книге: ' + result.skipped : '') + '.'
    + (result.menusAdded ? ' Добавлено меню: ' + result.menusAdded + '.' : '')
    + (result.menusSkipped ? ' Меню уже были в книге: ' + result.menusSkipped + '.' : ''));
};
