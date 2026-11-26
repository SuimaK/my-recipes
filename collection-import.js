'use strict';
// Загрузка рецептов из файлов и текста: сборники в тексте и TXT, несколько файлов сразу,
// перетаскивание и вставка скриншота, кодировка Windows-1251, HTML-страницы рецептов,
// поиск повторов при загрузке.

const sectionIngredients = /^(?:#{1,6}\s*)?(?:\*\*)?(?:ингредиенты|продукты|состав|ingredients)(?:\*\*)?\s*(?:[:：]|$)/iu;
const recipeMarker = /^\s*#*\s*(?:рецепт|recipe)\s*№?\s*\d+/iu;
const separatorLine = /^\s*(?:-{3,}|\*{3,}|={3,}|_{3,}|~{3,})\s*$/;


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
  const normalized = String(text || '').replace(/\r\n?/g, '\n').replace(/\u00A0/g, ' ').trim();
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
  const utf8 = new TextDecoder('utf-8').decode(buffer).replace(/^\uFEFF/, '');
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

async function markEditorDuplicate() {
  const titles = await existingTitles();
  const note = byId('import-note');
  const duplicate = titles.get(normalizeRecipeTitle(fields.title.value));
  note.textContent = duplicate
    ? 'Рецепт «' + duplicate.title + '» уже есть в книге. Сохранение создаст ещё одну карточку.'
    : 'Проверь черновик рецепта. Уточни поля, которые приложение не смогло распознать.';
}

// ---------- Проверка черновиков ----------

async function showDrafts(drafts, raw, name) {
  const titles = await existingTitles();
  const rows = renderPDFReview(drafts, raw, name);
  byId('pdf-review').querySelector('h3').textContent = 'Найденные рецепты';
  let duplicates = 0;
  rows.forEach((row, index) => {
    const draft = drafts[index];
    const summary = row.editor.closest('details').querySelector('summary');
    const title = parseRecipe(row.editor.value).title;
    summary.textContent = (draft.source ? draft.source + ' · ' : 'Стр. ' + draft.page + ' · ') + title;
    if (titles.has(normalizeRecipeTitle(title))) {
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

const MB = 1024 * 1024;
const maxFileSize = {pdf: 100 * MB, json: 250 * MB, text: 10 * MB, html: 10 * MB};
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

function clearFileReport() {
  fileReport = [];
  renderFileReport();
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
      const kind = fileKind(file);
      if (file.size > maxFileSize[kind]) throw Error('файл больше ' + Math.round(maxFileSize[kind] / MB) + ' МБ');
      let found = [];
      if (kind === 'json') {
        const data = JSON.parse(await file.text());
        if (data?.format === 'recipekeeper-backup-v1') {
          openBackupRestore(file, data);
          entry.state = 'ok';
          entry.text = 'Это резервная копия: открыл восстановление на вкладке «Копии»';
          continue;
        }
        if (file.size > maxCollectionSize) throw Error('сборник больше 25 МБ');
        entry.text = await importCollectionData(data);
        collections++;
        entry.state = 'ok';
        show('importer');
        continue;
      }
      if (kind === 'pdf') {
        const result = await convertPDF(file, {render: false});
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

function openBackupRestore(file, data) {
  show('backups');
  const transfer = new DataTransfer();
  transfer.items.add(file);
  byId('restore-file').files = transfer.files;
  return loadBackupFile(file, data);
}

// ---------- Подсказки ----------

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

// Сколько фото выбрано для распознавания.
byId('import-photo').addEventListener('change', event => {
  const count = event.target.files.length;
  byId('import-hint').textContent = count > maxPhotos ? 'Можно выбрать до ' + maxPhotos + ' фото за раз.'
    : count > 1 ? 'Выбрано фото: ' + count + '. Текст распознается по порядку и объединится в один рецепт.'
    : importModes.photo.hint;
});

// ---------- Перетаскивание файлов и вставка скриншота ----------

// Перехватываем только перетаскивание файлов: текст по-прежнему можно перетащить в поле ввода.
const draggingFiles = event => Boolean(event.dataTransfer?.types && [...event.dataTransfer.types].includes('Files'));
let dragDepth = 0;
const dropOverlay = element('div', 'Отпусти файлы, чтобы добавить рецепты');
dropOverlay.className = 'drop-overlay';
dropOverlay.hidden = true;
document.body.append(dropOverlay);
window.addEventListener('dragenter', event => {
  if (!database || !draggingFiles(event)) return;
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragleave', event => {
  if (!draggingFiles(event)) return;
  if (--dragDepth <= 0) { dragDepth = 0; dropOverlay.hidden = true; }
});
window.addEventListener('dragover', event => { if (draggingFiles(event)) event.preventDefault(); });
window.addEventListener('drop', event => {
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  if (!database) return;
  const images = files.filter(file => fileKind(file) === 'image');
  // Только фото → распознавание. Иначе все файлы идут в «Из файла»: у фото в отчёте будет подсказка.
  startImport(images.length === files.length ? 'photo' : 'file', images.length === files.length ? images : files);
});

function startImport(mode, files) {
  openImportMode(mode);
  const transfer = new DataTransfer();
  (mode === 'photo' ? files.slice(0, maxPhotos) : files).forEach(file => transfer.items.add(file));
  byId(importModes[mode].input).files = transfer.files;
  importForm.requestSubmit();
}

window.addEventListener('paste', event => {
  if (byId('importer').hidden || activeImport === 'text') return;
  const images = [...(event.clipboardData?.files || [])].filter(file => fileKind(file) === 'image');
  if (!images.length) return;
  event.preventDefault();
  startImport('photo', images);
});
