'use strict';
// Доработка загрузки рецептов: сборники в тексте и TXT, несколько файлов сразу,
// перетаскивание и вставка скриншота, кодировка Windows-1251, HTML-страницы рецептов,
// поиск повторов при загрузке и восстановлении копии.

const sectionIngredients = /^(?:#{1,6}\s*)?(?:\*\*)?(?:ингредиенты|продукты|состав|ingredients)(?:\*\*)?\s*(?:[:：]|$)/iu;
const recipeMarker = /^\s*#*\s*(?:рецепт|recipe)\s*№?\s*\d+/iu;
const separatorLine = /^\s*(?:-{3,}|\*{3,}|={3,}|_{3,}|~{3,})\s*$/;

function normalizeRecipeTitle(title) {
  return String(title || '').normalize('NFC').toLocaleLowerCase('ru').replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function looksLikeMeta(line) {
  return /^(?:порци|количество\s+порций|на\s+\d+\s+порци|(?:общее\s+)?время|выход)/iu.test(line);
}

function looksLikeTitle(line) {
  const text = line.replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '').trim();
  if (!text || text.length > 120 || sectionIngredients.test(text) || looksLikeMeta(text)) return false;
  if (/^(?:приготовлени|способ\s+приготовлени|инструкци|шаги)/iu.test(text)) return false;
  if (/^[-–—•●▪·*]|^\d+[.)]\s/u.test(text)) return false;
  return !(/[.!?;]$/.test(text) && text.split(/\s+/).length > 5);
}

function cutLines(lines, starts) {
  const sorted = [...new Set(starts)].sort((a, b) => a - b);
  const parts = [];
  if (sorted[0] > 0) parts.push(lines.slice(0, sorted[0]).join('\n'));
  sorted.forEach((start, index) => parts.push(lines.slice(start, sorted[index + 1] ?? lines.length).join('\n')));
  return parts.map(part => part.trim()).filter(Boolean);
}

/** Делит текст сборника на тексты отдельных рецептов. Один рецепт → массив из одного элемента. */
function splitRecipeText(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').trim();
  if (!normalized) return [];
  const lines = normalized.split('\n');

  const bySeparator = [];
  let chunk = [];
  for (const line of lines) {
    if (separatorLine.test(line)) { bySeparator.push(chunk.join('\n')); chunk = []; }
    else chunk.push(line);
  }
  bySeparator.push(chunk.join('\n'));
  const separated = bySeparator.map(part => part.trim()).filter(Boolean);
  if (separated.length > 1) return separated.flatMap(splitRecipeText);

  const markers = lines.map((line, index) => recipeMarker.test(line) ? index : -1).filter(index => index >= 0);
  if (markers.length > 1) return cutLines(lines, markers);

  const headers = lines.map((line, index) => sectionIngredients.test(line.trim()) ? index : -1).filter(index => index >= 0);
  if (headers.length > 1) {
    const starts = headers.map(index => {
      let j = index - 1;
      while (j >= 0 && (!lines[j].trim() || looksLikeMeta(lines[j].trim()))) j--;
      return j >= 0 && looksLikeTitle(lines[j]) ? j : index;
    });
    return cutLines(lines, starts);
  }

  const headings = lines.map((line, index) => /^#{1,2}\s+\S/.test(line) && looksLikeTitle(line) ? index : -1)
    .filter(index => index >= 0);
  if (headings.length > 1) return cutLines(lines, headings);
  return [normalized];
}

/** «Ингредиенты: свёкла, капуста, лук» → каждый продукт с новой строки. */
function expandInlineIngredients(text) {
  return text.replace(/^(\s*(?:ингредиенты|продукты|состав)\s*[:：])\s*(.+)$/gimu, (whole, head, list) => {
    const items = list.split(/\s*;\s*|,\s+(?=\p{L})/u).map(item => item.trim()).filter(Boolean);
    return items.length > 1 ? head + '\n' + items.join('\n') : whole;
  });
}

function recipeTextLooksUsable(text) {
  const recipe = parseRecipe(expandInlineIngredients(text));
  return Boolean(recipe.title && (recipe.ingredients.length || recipe.instructions));
}

/** Текст или сборник → черновики {page, text, source}. */
function textDrafts(text, source) {
  return splitRecipeText(text).map(expandInlineIngredients).filter(recipeTextLooksUsable)
    .map((draft, index) => ({page: index + 1, text: draft, source}));
}

// ---------- Файлы ----------

async function readTextFile(file) {
  const buffer = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buffer).replace(/^﻿/, '');
  const broken = (utf8.match(/\uFFFD/g) || []).length;
  if (broken > 3 || (broken && broken / utf8.length > 0.001)) {
    try { return new TextDecoder('windows-1251').decode(buffer); } catch { /* декодер недоступен */ }
  }
  return utf8;
}

function schemaRecipes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(item => schemaRecipes(item, out)); return out; }
  const types = [].concat(node['@type'] || []).map(String);
  if (types.includes('Recipe')) out.push(node);
  if (node['@graph']) schemaRecipes(node['@graph'], out);
  return out;
}

function schemaSteps(value) {
  return [].concat(value || []).flatMap(step => {
    if (typeof step === 'string') return step.split(/\n+/).map(line => line.trim()).filter(Boolean);
    if (step?.['@type'] === 'HowToSection') return schemaSteps(step.itemListElement);
    return step?.text ? [String(step.text).trim()] : [];
  });
}

function schemaMinutes(value) {
  const match = /^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(String(value || ''));
  const minutes = match ? (+match[1] || 0) * 60 + (+match[2] || 0) : 0;
  return minutes ? 'Общее время: ' + minutes + ' мин' : '';
}

function decodeEntities(text) {
  const area = document.createElement('textarea');
  area.innerHTML = text;
  return area.value;
}

function htmlDrafts(html, source) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const found = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try { schemaRecipes(JSON.parse(script.textContent), found); } catch { /* пропускаем повреждённый блок */ }
  }
  if (found.length) {
    return found.map((recipe, index) => {
      const servings = /\d+/.exec([].concat(recipe.recipeYield || [])[0] || '');
      const text = [decodeEntities(String(recipe.name || 'Рецепт')),
        servings ? 'Порции: ' + servings[0] : '',
        schemaMinutes(recipe.totalTime || recipe.cookTime),
        'Ингредиенты:', ...[].concat(recipe.recipeIngredient || []).map(item => decodeEntities(String(item))),
        'Приготовление:', ...schemaSteps(recipe.recipeInstructions).map(decodeEntities)].filter(Boolean).join('\n');
      return {page: index + 1, text, source};
    });
  }
  for (const node of doc.querySelectorAll('script,style,noscript,nav,header,footer')) node.remove();
  for (const item of doc.querySelectorAll('li')) item.prepend('- ');
  for (const block of doc.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,tr,br,section,article')) block.append('\n');
  return textDrafts((doc.body?.textContent || '').split('\n').map(line => line.trim()).join('\n'), source);
}

function fileKind(file) {
  const name = file.name.toLowerCase();
  if (file.type.startsWith('image/') || /\.(?:jpe?g|png|heic|heif|webp|gif)$/.test(name)) return 'image';
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (file.type === 'application/json' || name.endsWith('.json')) return 'json';
  if (file.type === 'text/html' || /\.html?$/.test(name)) return 'html';
  if (file.type.startsWith('text/') || /\.(?:txt|md|text)$/.test(name)) return 'text';
  return 'unknown';
}

// ---------- Повторы ----------

async function existingTitles() {
  const recipes = await transact('readonly', store => store.getAll());
  return new Map(recipes.map(recipe => [normalizeRecipeTitle(recipe.title), recipe]));
}

function recipeFingerprint(recipe) {
  return JSON.stringify([normalizeRecipeTitle(recipe.title), String(recipe.instructions || '').trim(),
    (recipe.ingredients || []).map(item => [item.name, item.amount, item.unit].map(value => String(value || '').trim()))]);
}

// ---------- Проверка черновиков ----------

let reviewTitles = new Map();

async function showDrafts(drafts, raw, name) {
  reviewTitles = await existingTitles();
  renderPDFReview(drafts, raw, name);
  byId('pdf-review').querySelector('h3').textContent = 'Найденные рецепты';
  let duplicates = 0;
  pdfDraftRows.forEach((row, index) => {
    const draft = drafts[index];
    const summary = row.editor.closest('details').querySelector('summary');
    const title = parseRecipe(row.editor.value).title;
    summary.textContent = (draft.source ? draft.source + ' · ' : 'Стр. ' + draft.page + ' · ') + title;
    if (reviewTitles.has(normalizeRecipeTitle(title))) {
      duplicates++;
      row.check.checked = false;
      const note = element('p', 'Рецепт с таким названием уже есть в книге. Отметь «Загрузить», если нужна ещё одна карточка.');
      note.className = 'duplicate-note';
      row.check.closest('label').after(note);
      summary.append(element('span', ' · уже есть'));
    }
  });
  if (drafts.length) {
    byId('pdf-result').textContent = 'Найдено рецептов: ' + drafts.length +
      (duplicates ? '. Уже есть в книге: ' + duplicates + ', они не отмечены.' : '. Проверь каждую карточку перед сохранением.');
  }
  byId('pdf-save').disabled = false;
  byId('pdf-review').scrollIntoView({block: 'start'});
}

// ---------- Загрузка нескольких файлов ----------

let fileReport = [];

function renderFileReport() {
  let box = byId('file-report');
  if (!box) {
    box = element('ul');
    box.id = 'file-report';
    box.className = 'file-report';
    byId('import-form').after(box);
  }
  box.hidden = !fileReport.length;
  box.replaceChildren(...fileReport.map(entry => {
    const row = element('li');
    row.className = 'file-report-row ' + entry.state;
    row.append(element('span', entry.name), element('small', entry.text));
    return row;
  }));
}

async function importFiles(files) {
  fileReport = files.map(file => ({name: file.name, state: 'wait', text: 'В очереди'}));
  renderFileReport();
  const drafts = [];
  const raws = [];
  let collections = 0;
  for (const [index, file] of files.entries()) {
    const entry = fileReport[index];
    entry.text = 'Читаю…';
    renderFileReport();
    try {
      if (file.size > 250 * 1024 * 1024) throw Error('файл больше 250 МБ');
      const kind = fileKind(file);
      let found = [];
      if (kind === 'json') {
        const data = JSON.parse(await file.text());
        if (data?.format === 'recipekeeper-backup-v1') {
          openBackupRestore(file);
          entry.state = 'ok';
          entry.text = 'Это резервная копия: открыл восстановление на вкладке «Копии»';
          continue;
        }
        await importCollection(file);
        collections++;
        entry.state = 'ok';
        entry.text = byId('status').textContent || 'Сборник сохранён';
        show('importer');
        continue;
      }
      if (kind === 'pdf') {
        const result = await extractPDF(file);
        found = result.drafts.map(draft => ({...draft, source: file.name + ', стр. ' + draft.page}));
        raws.push(result.raw);
        if (!found.length && result.raw.trim()) found = [{page: 1, text: result.raw, source: file.name}];
      } else if (kind === 'text') {
        const text = await readTextFile(file);
        raws.push(text);
        found = textDrafts(text, file.name);
      } else if (kind === 'html') {
        found = htmlDrafts(await readTextFile(file), file.name);
      } else if (kind === 'image') {
        throw Error('для фото выбери «По фото»');
      } else {
        throw Error('формат не поддерживается: подойдут PDF, TXT, MD, HTML и JSON');
      }
      if (!found.length) throw Error('рецепт не найден');
      if (kind !== 'pdf' && found.length > 1) found.forEach(draft => { draft.source = file.name + ' #' + draft.page; });
      drafts.push(...found);
      entry.state = 'ok';
      entry.text = 'Рецептов: ' + found.length;
    } catch (error) {
      entry.state = 'error';
      entry.text = error?.name === 'PasswordException' ? 'PDF защищён паролем' :
        error instanceof SyntaxError ? 'файл JSON повреждён' : error?.message || 'не удалось прочитать';
    }
    renderFileReport();
  }
  renderFileReport();
  if (drafts.length) {
    show('importer');
    await showDrafts(drafts, raws.join('\n\n'), files.length > 1 ? 'Файлов: ' + files.length : files[0].name);
    message('Черновики готовы. Проверь их и выбери, что сохранить.');
  } else if (!collections && !fileReport.some(entry => entry.state === 'ok')) {
    message('Импорт не завершён. Причины указаны у каждого файла.');
  }
}

/** Вариант convertPDF, который возвращает черновики, а не показывает их. */
async function extractPDF(file) {
  let captured;
  const original = renderPDFReview;
  renderPDFReview = (drafts, raw) => { captured = {drafts, raw}; };
  try {
    await convertPDF(file);
  } finally {
    renderPDFReview = original;
  }
  return captured || {drafts: [], raw: ''};
}

function openBackupRestore(file) {
  show('backups');
  const input = byId('restore-file');
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change'));
}

// ---------- Подключение к интерфейсу ----------

const fileInput = byId('import-file');
fileInput.multiple = true;
fileInput.accept = '.pdf,.txt,.md,.json,.html,.htm,application/pdf,text/plain,text/markdown,text/html,application/json';
importModes.file.hint = 'Выбери один или несколько файлов: PDF, TXT, MD, HTML (сохранённая страница рецепта) или сборник JSON. Файлы можно просто перетащить в окно.';
importModes.text.hint = 'Вставь один рецепт или сразу несколько. Рецепты разделяй строкой «---» или начинай каждый с названия и заголовка «Ингредиенты».';
importModes.file.missing = 'Выбери файлы.';

const originalSubmit = importForm.onsubmit;
importForm.onsubmit = async event => {
  event.preventDefault();
  fileReport = [];
  renderFileReport();
  if (activeImport === 'text') {
    const text = byId('import-text').value.trim();
    const drafts = textDrafts(text, '');
    if (drafts.length > 1) {
      await showDrafts(drafts, text, 'Вставленный текст');
      message('В тексте несколько рецептов. Проверь черновики и выбери, что сохранить.');
      return;
    }
    if (drafts.length === 1) byId('import-text').value = drafts[0].text;
  }
  if (activeImport === 'file') {
    const files = [...fileInput.files];
    if (!files.length) { message(importModes.file.missing); return; }
    const controls = [fileInput, byId('import-submit'), byId('import-back')];
    for (const control of controls) control.disabled = true;
    try {
      resetPDFReview();
      await importFiles(files);
    } finally {
      for (const control of controls) control.disabled = false;
    }
    return;
  }
  const result = await originalSubmit(event);
  if (activeImport !== 'photo' && !byId('editor').hidden) await markEditorDuplicate();
  return result;
};

async function markEditorDuplicate() {
  const titles = await existingTitles();
  const note = byId('import-note');
  const duplicate = titles.get(normalizeRecipeTitle(fields.title.value));
  note.textContent = duplicate
    ? 'Рецепт «' + duplicate.title + '» уже есть в книге. Сохранение создаст ещё одну карточку.'
    : 'Проверь черновик рецепта. Уточни поля, которые приложение не смогло распознать.';
}

const originalOCRCreate = byId('ocr-create').onclick;
byId('ocr-create').onclick = async () => {
  originalOCRCreate();
  if (!byId('editor').hidden) await markEditorDuplicate();
};

// Подсказка о количестве рецептов в тексте.
const textArea = byId('import-text');
let hintTimer;
textArea.addEventListener('input', () => {
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    const count = textDrafts(textArea.value, '').length;
    byId('import-hint').textContent = count > 1 ? 'Найдено рецептов: ' + count + '. Каждый можно будет проверить перед сохранением.'
      : importModes.text.hint;
  }, 250);
});

// Перетаскивание файлов в окно и вставка скриншота.
let dragDepth = 0;
const dropOverlay = element('div', 'Отпусти файлы, чтобы добавить рецепты');
dropOverlay.className = 'drop-overlay';
dropOverlay.hidden = true;
document.body.append(dropOverlay);
window.addEventListener('dragenter', event => {
  if (!database || !event.dataTransfer?.types?.includes('Files')) return;
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropOverlay.hidden = true; } });
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', async event => {
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length || !database) return;
  const images = files.filter(file => fileKind(file) === 'image');
  if (images.length === files.length) { startPhotoImport(images); return; }
  byId('add-dialog').close();
  byId('open-import').onclick();
  const transfer = new DataTransfer();
  files.filter(file => fileKind(file) !== 'image').forEach(file => transfer.items.add(file));
  fileInput.files = transfer.files;
  importForm.requestSubmit();
});

function startPhotoImport(files) {
  byId('add-dialog').close();
  byId('open-photo').onclick();
  const transfer = new DataTransfer();
  [].concat(files).slice(0, maxPhotos).forEach(file => transfer.items.add(file));
  byId('import-photo').files = transfer.files;
  importForm.requestSubmit();
}

window.addEventListener('paste', event => {
  if (byId('importer').hidden || activeImport === 'text') return;
  const images = [...(event.clipboardData?.files || [])].filter(file => fileKind(file) === 'image');
  if (!images.length) return;
  event.preventDefault();
  startPhotoImport(images);
});

// ---------- Восстановление копии без повторов ----------

byId('restore-backup').onclick = async () => {
  if (!restoreData) return;
  const button = byId('restore-backup');
  button.disabled = true;
  try {
    const existing = await transact('readonly', store => store.getAll());
    const known = new Map(existing.map(recipe => [recipeFingerprint(recipe), recipe.id]));
    let added = 0;
    let skipped = 0;
    await new Promise((resolve, reject) => {
      const tx = database.transaction(['recipes', 'menus'], 'readwrite');
      const mapping = new Map();
      const recipes = tx.objectStore('recipes');
      const menus = tx.objectStore('menus');
      let pending = 0;
      const addMenus = () => {
        for (const source of restoreData.menus) {
          const {id, ...menu} = source;
          menus.add({...menu, entries: menu.entries.map(entry => ({...entry, recipeId: mapping.get(entry.recipeId)}))});
        }
      };
      for (const source of restoreData.recipes) {
        const {id, importKey, ...recipe} = source;
        const same = known.get(recipeFingerprint(recipe));
        if (same !== undefined) { mapping.set(id, same); skipped++; continue; }
        pending++;
        const request = recipes.add(recipe);
        request.onsuccess = () => { mapping.set(id, request.result); added++; if (--pending === 0) addMenus(); };
      }
      if (!pending) addMenus();
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    restoreData = null;
    byId('restore-file').value = '';
    byId('restore-info').textContent = '';
    await listRecipes();
    message('Копия восстановлена. Добавлено рецептов: ' + added + (skipped ? ', уже были в книге: ' + skipped : '') + '.');
  } catch {
    message('Восстановление отменено из-за ошибки. Частичные данные не сохранены.');
    button.disabled = false;
  }
};

// Сколько фото выбрано для распознавания.
byId('import-photo').addEventListener('change', event => {
  const count = event.target.files.length;
  byId('import-hint').textContent = count > maxPhotos ? 'Можно выбрать до ' + maxPhotos + ' фото за раз.'
    : count > 1 ? 'Выбрано фото: ' + count + '. Текст распознается по порядку и объединится в один рецепт.'
    : importModes.photo.hint;
});
