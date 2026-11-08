import { store } from './store.js';
import { parseRecipesFromText, findDuplicate } from './parser.js';
import { importFile, ACCEPT, detectKind, imageToDataUrl } from './importers.js';

const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, few, many) => { const m10 = n % 10, m100 = n % 100; return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`; };
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

const ui = { view: 'recipes', category: '', favOnly: false };

// ---------------- Список рецептов ----------------

function categories() {
  return [...new Set(store.recipes.map((r) => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
}

function filtered() {
  const qt = norm($('#q-title').value.trim());
  const qi = norm($('#q-ing').value).split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  return store.recipes.filter((r) => {
    if (ui.category && r.category !== ui.category) return false;
    if (ui.favOnly && !r.favorite) return false;
    if (qt && !norm(r.title).includes(qt)) return false;
    if (qi.length) {
      const ing = norm((r.ingredients || []).join(' \n '));
      if (!qi.every((q) => ing.includes(q))) return false;
    }
    return true;
  });
}

function renderList() {
  const cats = categories();
  if (ui.category && !cats.includes(ui.category)) ui.category = '';
  $('#chips').innerHTML = cats.length || store.recipes.some((r) => r.favorite)
    ? [`<button class="chip" data-cat="" aria-pressed="${!ui.category && !ui.favOnly}">Все</button>`,
       store.recipes.some((r) => r.favorite) ? `<button class="chip" data-fav aria-pressed="${ui.favOnly}">★ Избранное</button>` : '',
       ...cats.map((c) => `<button class="chip" data-cat="${esc(c)}" aria-pressed="${ui.category === c}">${esc(c)}</button>`)].join('')
    : '';
  const list = filtered();
  const total = store.recipes.length;
  $('#empty').hidden = total > 0;
  $('#count').textContent = total ? (list.length === total ? plural(total, 'рецепт', 'рецепта', 'рецептов') : `Найдено ${list.length} из ${total}`) : '';
  $('#grid').innerHTML = list.map((r) => `
    <button class="card" data-open="${esc(r.id)}" type="button">
      <div class="card-photo${r.photo ? '' : ' no-photo'}" style="${r.photo ? `background-image:url('${esc(r.photo)}')` : ''}">${r.photo ? '' : '🍽️'}</div>
      <div class="card-body">
        <p class="card-title">${r.favorite ? '★ ' : ''}${esc(r.title)}</p>
        <div class="card-meta">
          ${r.category ? `<span>${esc(r.category)}</span>` : ''}
          ${r.time ? `<span>⏱ ${esc(r.time)}</span>` : ''}
          ${r.servings ? `<span>🍽 ${esc(r.servings)} порц.</span>` : ''}
          ${store.menu.includes(r.id) ? '<span class="in-menu">✓ в меню</span>' : ''}
        </div>
        <div class="card-ing">${esc((r.ingredients || []).join(', '))}</div>
      </div>
    </button>`).join('') || (total ? '<p class="hint">Ничего не нашлось. Попробуйте изменить запрос.</p>' : '');
}

function renderMenu() {
  const items = store.menu.map((id) => store.byId(id)).filter(Boolean);
  const badge = $('#menu-badge');
  badge.hidden = !items.length;
  badge.textContent = items.length;
  $('#menu-empty').hidden = items.length > 0;
  $('#clear-menu').hidden = !items.length;
  $('#menu-list').innerHTML = items.map((r) => `
    <div class="menu-item"><button class="btn btn-ghost btn-sm" data-open="${esc(r.id)}">${esc(r.title)}</button>
    <button class="btn btn-sm" data-unmenu="${esc(r.id)}" aria-label="Убрать ${esc(r.title)} из меню">Убрать</button></div>`).join('');
  const seen = new Map();
  items.forEach((r) => (r.ingredients || []).forEach((i) => { const k = norm(i); if (!seen.has(k)) seen.set(k, i); }));
  $('#shopping').innerHTML = [...seen.entries()].map(([k, i]) => `
    <li><label><input type="checkbox" data-shop="${esc(k)}" ${store.checked[k] ? 'checked' : ''}><span>${esc(i)}</span></label></li>`).join('');
  $('#shopping').previousElementSibling.hidden = !items.length;
}

function renderBackup() {
  const n = store.recipes.length;
  $('#backup-stats').textContent = n ? `В книге ${plural(n, 'рецепт', 'рецепта', 'рецептов')}.` : 'Книга пока пуста.';
  $('#export-btn').disabled = !n;
  $('#wipe-btn').disabled = !n;
}

function renderAll() { renderList(); renderMenu(); renderBackup(); }

function setView(v) {
  ui.view = v;
  for (const b of document.querySelectorAll('.tabs [role=tab]')) b.setAttribute('aria-selected', String(b.dataset.view === v));
  $('#view-recipes').hidden = v !== 'recipes';
  $('#view-menu').hidden = v !== 'menu';
  $('#view-backup').hidden = v !== 'backup';
  window.scrollTo({ top: 0 });
}

// ---------------- Тост с отменой ----------------

let toastTimer;
function toast(text, undo) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(text)}</span>${undo ? '<button type="button">Отменить</button>' : ''}`;
  t.hidden = false;
  if (undo) t.querySelector('button').onclick = () => { undo(); t.hidden = true; };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, undo ? 7000 : 3500);
}

// ---------------- Просмотр рецепта ----------------

const viewDlg = $('#view-dlg');
let viewing = null;

function openRecipe(id) {
  const r = store.byId(id);
  if (!r) return;
  viewing = id;
  $('#view-cat').textContent = r.category || 'Рецепт';
  $('#view-title').textContent = r.title;
  const facts = [r.time && `⏱ ${r.time}`, r.servings && `🍽 ${r.servings} порц.`, r.source && `Источник: ${r.source}`].filter(Boolean);
  $('#view-body').innerHTML = `
    ${r.photo ? `<img class="view-photo" src="${esc(r.photo)}" alt="">` : ''}
    ${facts.length ? `<div class="facts">${facts.map((f) => `<span class="tag">${esc(f)}</span>`).join('')}</div>` : ''}
    ${r.ingredients?.length ? `<h3>Ингредиенты</h3><ul class="ing-list">${r.ingredients.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
    ${r.steps?.length ? `<h3>Приготовление</h3><ol class="steps">${r.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
    ${r.notes ? `<h3>Заметки</h3><p class="notes">${esc(r.notes)}</p>` : ''}`;
  const inMenu = store.menu.includes(id);
  $('#view-foot').innerHTML = `
    <button class="btn btn-danger btn-sm" data-act="delete">Удалить</button>
    <span class="spacer"></span>
    <button class="btn btn-sm" data-act="fav">${r.favorite ? '★ В избранном' : '☆ В избранное'}</button>
    <button class="btn btn-sm" data-act="edit">Изменить</button>
    <button class="btn btn-primary btn-sm" data-act="menu">${inMenu ? '✓ В меню' : '＋ В меню'}</button>`;
  if (!viewDlg.open) viewDlg.showModal();
}

viewDlg.addEventListener('click', (e) => {
  if (e.target === viewDlg || e.target.closest('[data-close]')) return viewDlg.close();
  const act = e.target.closest('[data-act]')?.dataset.act;
  const r = store.byId(viewing);
  if (!act || !r) return;
  if (act === 'menu') { store.toggleMenu(r.id); openRecipe(r.id); }
  if (act === 'fav') { store.update(r.id, { favorite: !r.favorite }); openRecipe(r.id); }
  if (act === 'edit') { viewDlg.close(); openImport('edit', r); }
  if (act === 'delete') {
    const copy = { ...r };
    const wasInMenu = store.menu.includes(r.id);
    store.remove(r.id);
    viewDlg.close();
    toast(`«${copy.title}» удалён`, () => { restoreRecipes([copy]); if (wasInMenu) store.toggleMenu(copy.id); });
  }
});

function restoreRecipes(list) {
  // Возвращаем рецепты с прежними id (для отмены).
  store.recipes.unshift(...list);
  store.update(list[0].id, {});
}

// ---------------- Добавление и импорт ----------------

const dlg = $('#import-dlg');
const body = $('#import-body');
const foot = $('#import-foot');
const imp = { step: 'choose', files: [], drafts: [], text: '', editing: null, busy: false, error: '' };

const METHODS = [
  { id: 'manual', icon: '✎', title: 'Вручную', sub: 'Заполнить рецепт самостоятельно' },
  { id: 'photo', icon: '▣', title: 'По фото', sub: 'Распознать страницу или скриншот' },
  { id: 'text', icon: '≡', title: 'Из текста', sub: 'Вставить готовый текст рецепта' },
  { id: 'file', icon: '⇧', title: 'Из файла', sub: 'PDF, TXT, JSON, HTML или сборник' },
];

function openImport(step = 'choose', recipe = null) {
  Object.assign(imp, { step, files: [], drafts: [], text: '', editing: null, busy: false, error: '' });
  if (step === 'manual') imp.drafts = [draft(blankRecipe(), 'вручную')];
  if (step === 'edit') { imp.editing = recipe.id; imp.drafts = [draft({ ...recipe }, '')]; }
  renderImport();
  if (!dlg.open) dlg.showModal();
}

function blankRecipe() { return { title: '', category: '', servings: null, time: '', ingredients: [], steps: [], notes: '', source: '' }; }

function draft(recipe, source) {
  const dup = imp.editing ? null : findDuplicate(recipe, store.recipes);
  return { recipe, source, include: !dup, dupId: dup?.id || null, dupAction: 'skip', open: false };
}

function setHead(eyebrow, title) { $('#import-eyebrow').textContent = eyebrow; $('#import-title').textContent = title; }

function renderImport() {
  const s = imp.step;
  const err = imp.error ? `<div class="error-box" role="alert">${esc(imp.error)}</div>` : '';
  if (s === 'choose') {
    setHead('Новый рецепт', 'Как добавить?');
    body.innerHTML = `<div class="methods">${METHODS.map((m) => `
      <button type="button" class="method" data-method="${m.id}"><span class="method-icon" aria-hidden="true">${m.icon}</span>
      <span><b>${m.title}</b><small>${m.sub}</small></span></button>`).join('')}</div>
      <p class="hint">Подсказка: файлы можно просто перетащить в окно приложения.</p>`;
    foot.innerHTML = '';
  } else if (s === 'text') {
    setHead('Из текста', 'Вставьте текст рецепта');
    body.innerHTML = `${err}<div class="form"><label><span>Текст одного или нескольких рецептов</span>
      <textarea id="paste" rows="12" placeholder="Блины&#10;Ингредиенты:&#10;- молоко 500 мл&#10;- яйца 2 шт&#10;Приготовление:&#10;1. Смешать…&#10;&#10;Несколько рецептов разделяйте строкой ---">${esc(imp.text)}</textarea></label>
      <p class="help" id="paste-hint" aria-live="polite"></p></div>`;
    foot.innerHTML = `<button type="button" class="btn btn-ghost" data-go="choose">Назад</button><button type="button" class="btn btn-primary" data-parse>Распознать</button>`;
    updatePasteHint();
  } else if (s === 'file' || s === 'photo') {
    const photo = s === 'photo';
    setHead(photo ? 'По фото' : 'Из файла', photo ? 'Фото страницы или скриншот' : 'Загрузите файлы');
    body.innerHTML = `${err}
      <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Выбрать файлы">
        <div class="big" aria-hidden="true">${photo ? '📷' : '📄'}</div>
        <b>${photo ? 'Выберите фото или сделайте снимок' : 'Перетащите файлы сюда или нажмите, чтобы выбрать'}</b>
        <span class="formats">${photo ? 'JPG, PNG, HEIC, скриншоты. Можно несколько сразу.' : 'TXT, MD, PDF, JSON (копия), HTML (сохранённая страница). Можно несколько, в одном файле можно сборник.'}</span>
      </div>
      ${photo ? '<p class="hint">Распознавание идёт прямо в браузере, при первом запуске загружается языковой модуль (около 10 МБ).</p>' : ''}
      <ul class="files">${imp.files.map(fileRow).join('')}</ul>`;
    foot.innerHTML = `<button type="button" class="btn btn-ghost" data-go="choose">Назад</button>
      ${photo ? '<button type="button" class="btn" data-camera>Сделать фото</button>' : ''}
      ${imp.drafts.length && !imp.busy ? `<button type="button" class="btn btn-primary" data-go="review">Проверить (${imp.drafts.length})</button>` : ''}`;
  } else if (s === 'review' || s === 'manual' || s === 'edit') {
    renderReview();
  }
}

function fileRow(f, idx) {
  const icon = { pdf: '📕', image: '🖼️', json: '🗂️', html: '🌐', text: '📄' }[f.kind] || '📄';
  return `<li class="file-row ${f.status}"><span aria-hidden="true">${icon}</span>
    <div class="name">${esc(f.file.name)}${f.status === 'busy' ? `<div class="progress"><i style="width:${Math.round((f.progress || 0) * 100)}%"></i></div>` : ''}</div>
    <span class="st">${esc(f.msg)}</span>
    ${f.status === 'err' && f.text ? `<button type="button" class="btn btn-sm" data-fix="${idx}">Поправить текст</button>` : ''}</li>`;
}

function updatePasteHint() {
  const el = $('#paste-hint');
  if (!el) return;
  const t = $('#paste').value;
  if (!t.trim()) { el.textContent = 'Поддерживаются заголовки «Ингредиенты», «Приготовление», «Порции», «Время». Каждый ингредиент с новой строки.'; return; }
  const n = parseRecipesFromText(t).length;
  el.textContent = n ? `Найдено: ${plural(n, 'рецепт', 'рецепта', 'рецептов')}` : 'Пока не похоже на рецепт: добавьте ингредиенты или шаги.';
}

function draftIssues(r) {
  const out = [];
  if (!r.title.trim()) out.push('нет названия');
  if (!r.ingredients.length) out.push('нет ингредиентов');
  if (!r.steps.length) out.push('нет шагов');
  return out;
}

function editorHtml(d, i) {
  const r = d.recipe;
  const cats = categories();
  return `<div class="form" data-editor="${i}">
    <label><span>Название *</span><input type="text" data-f="title" value="${esc(r.title)}" required placeholder="Например, Блины на молоке"></label>
    <div class="row">
      <label><span>Категория</span><input type="text" data-f="category" value="${esc(r.category)}" list="cat-list" placeholder="Завтрак"></label>
      <label><span>Порции</span><input type="number" min="1" max="100" inputmode="numeric" data-f="servings" value="${esc(r.servings ?? '')}"></label>
      <label><span>Время</span><input type="text" data-f="time" value="${esc(r.time)}" placeholder="40 минут"></label>
    </div>
    <label><span>Ингредиенты</span><textarea data-f="ingredients" rows="6" placeholder="Каждый с новой строки">${esc(r.ingredients.join('\n'))}</textarea></label>
    <label><span>Приготовление</span><textarea data-f="steps" rows="6" placeholder="Каждый шаг с новой строки">${esc(r.steps.join('\n'))}</textarea></label>
    <label><span>Заметки</span><textarea data-f="notes" rows="2">${esc(r.notes)}</textarea></label>
    <div class="photo-pick">${r.photo ? `<img src="${esc(r.photo)}" alt="Фото блюда">` : ''}
      <button type="button" class="btn btn-sm" data-photo="${i}">${r.photo ? 'Заменить фото' : 'Добавить фото блюда'}</button>
      ${r.photo ? `<button type="button" class="btn btn-ghost btn-sm" data-nophoto="${i}">Убрать</button>` : ''}</div>
    <datalist id="cat-list">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
  </div>`;
}

function renderReview() {
  const single = imp.step === 'manual' || imp.step === 'edit';
  if (single) {
    setHead(imp.step === 'edit' ? 'Редактирование' : 'Вручную', imp.step === 'edit' ? 'Изменить рецепт' : 'Новый рецепт');
    body.innerHTML = (imp.error ? `<div class="error-box" role="alert">${esc(imp.error)}</div>` : '') + editorHtml(imp.drafts[0], 0);
    foot.innerHTML = `<button type="button" class="btn btn-ghost" data-go="${imp.step === 'edit' ? 'close' : 'choose'}">${imp.step === 'edit' ? 'Отмена' : 'Назад'}</button>
      <button type="button" class="btn btn-primary" data-save>Сохранить</button>`;
    return;
  }
  const n = imp.drafts.filter((d) => d.include).length;
  setHead('Проверка', `Найдено ${plural(imp.drafts.length, 'рецепт', 'рецепта', 'рецептов')}`);
  body.innerHTML = `${imp.error ? `<div class="error-box" role="alert">${esc(imp.error)}</div>` : ''}
    <div class="review-head"><p class="hint" style="margin:0">Проверьте, что всё распозналось верно. Нажмите на рецепт, чтобы поправить.</p>
      <button type="button" class="btn btn-ghost btn-sm" data-all>${imp.drafts.every((d) => d.include) ? 'Снять все' : 'Выбрать все'}</button></div>
    <div class="review">${imp.drafts.map((d, i) => {
      const r = d.recipe;
      const issues = draftIssues(r);
      return `<div class="rcard ${d.include ? '' : 'off'}" data-i="${i}">
        <div class="rcard-top">
          <input type="checkbox" data-inc="${i}" ${d.include ? 'checked' : ''} aria-label="Добавить «${esc(r.title)}»">
          <button type="button" class="rcard-title" data-toggle="${i}" style="background:none;border:0;text-align:left;cursor:pointer;padding:0">
            <b>${esc(r.title || 'Без названия')}</b>
            <small>${plural(r.ingredients.length, 'ингредиент', 'ингредиента', 'ингредиентов')} · ${plural(r.steps.length, 'шаг', 'шага', 'шагов')}${d.source ? ` · ${esc(d.source)}` : ''}</small>
          </button>
          ${issues.map((x) => `<span class="tag warn">${esc(x)}</span>`).join('')}
          <button type="button" class="btn btn-ghost btn-sm" data-toggle="${i}" aria-expanded="${d.open}">${d.open ? 'Свернуть' : 'Изменить'}</button>
        </div>
        ${d.open ? `<div class="rcard-edit">${editorHtml(d, i)}</div>` : ''}
        ${d.dupId ? `<div class="dup"><span>Такой рецепт уже есть.</span>
          <select data-dup="${i}" aria-label="Что сделать с повтором">
            <option value="skip" ${d.dupAction === 'skip' ? 'selected' : ''}>Пропустить</option>
            <option value="replace" ${d.dupAction === 'replace' ? 'selected' : ''}>Заменить старый</option>
            <option value="copy" ${d.dupAction === 'copy' ? 'selected' : ''}>Добавить как копию</option>
          </select></div>` : ''}
      </div>`;
    }).join('')}</div>`;
  foot.innerHTML = `<button type="button" class="btn btn-ghost" data-go="choose">Добавить ещё</button>
    <button type="button" class="btn btn-primary" data-save ${n ? '' : 'disabled'}>Сохранить ${n ? plural(n, 'рецепт', 'рецепта', 'рецептов') : ''}</button>`;
}

function readEditor(i) {
  const ed = body.querySelector(`[data-editor="${i}"]`);
  if (!ed) return;
  const r = imp.drafts[i].recipe;
  const v = (f) => ed.querySelector(`[data-f="${f}"]`).value;
  const lines = (f) => v(f).split('\n').map((s) => s.replace(/^\s*[-–•*]\s*/, '').trim()).filter(Boolean);
  r.title = v('title').trim();
  r.category = v('category').trim();
  r.servings = v('servings') ? Math.max(1, parseInt(v('servings'), 10) || 1) : null;
  r.time = v('time').trim();
  r.ingredients = lines('ingredients');
  r.steps = lines('steps');
  r.notes = v('notes').trim();
}

function readAllEditors() { imp.drafts.forEach((_, i) => readEditor(i)); }

async function processFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  imp.error = '';
  if (imp.step !== 'photo') imp.step = 'file';
  const entries = files.map((file) => ({ file, kind: detectKind(file), status: 'busy', msg: 'В очереди', progress: 0 }));
  imp.files.push(...entries);
  imp.busy = true;
  renderImport();
  for (const f of entries) {
    f.msg = 'Читаю…';
    renderImport();
    try {
      const res = await importFile(f.file, (msg, p) => { f.msg = msg; f.progress = p; renderImport(); });
      res.recipes.forEach((r) => imp.drafts.push(draft(r, f.file.name)));
      f.status = 'ok';
      f.msg = plural(res.recipes.length, 'рецепт', 'рецепта', 'рецептов');
    } catch (e) {
      f.status = 'err';
      f.msg = e.message || 'Ошибка чтения';
      f.text = e.text;
      console.warn(f.file.name, e);
    }
    renderImport();
  }
  imp.busy = false;
  if (imp.drafts.length && entries.every((f) => f.status === 'ok')) imp.step = 'review';
  renderImport();
}

function save() {
  readAllEditors();
  const single = imp.step === 'manual' || imp.step === 'edit';
  const chosen = imp.drafts.filter((d) => d.include || single);
  const bad = chosen.find((d) => !d.recipe.title.trim() || (!d.recipe.ingredients.length && !d.recipe.steps.length));
  if (bad) {
    imp.error = !bad.recipe.title.trim() ? 'У рецепта должно быть название.' : `Добавьте ингредиенты или шаги для «${bad.recipe.title}».`;
    bad.open = true;
    renderImport();
    body.querySelector('.error-box')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (imp.step === 'edit') {
    store.update(imp.editing, imp.drafts[0].recipe);
    const id = imp.editing;
    dlg.close();
    toast('Рецепт сохранён');
    openRecipe(id);
    return;
  }
  const toAdd = [];
  const replaced = [];
  for (const d of chosen) {
    if (d.dupId && d.dupAction === 'skip') continue;
    if (d.dupId && d.dupAction === 'replace') {
      const old = store.byId(d.dupId);
      if (old) { replaced.push({ ...old }); store.update(d.dupId, { ...d.recipe, photo: d.recipe.photo || old.photo }); continue; }
    }
    toAdd.push(d.recipe);
  }
  const ids = toAdd.length ? store.add(toAdd) : [];
  dlg.close();
  setView('recipes');
  const total = ids.length + replaced.length;
  if (!total) { toast('Ничего не добавлено: все рецепты уже есть в книге'); return; }
  const msg = [ids.length && `Добавлено: ${plural(ids.length, 'рецепт', 'рецепта', 'рецептов')}`, replaced.length && `обновлено: ${replaced.length}`].filter(Boolean).join(', ');
  toast(msg, () => {
    if (ids.length) store.remove(ids);
    replaced.forEach((old) => store.update(old.id, old));
  });
}

// События диалога импорта
dlg.addEventListener('click', async (e) => {
  const t = e.target;
  if (t === dlg) return dlg.close();
  const m = t.closest('[data-method]')?.dataset.method;
  if (m) {
    imp.step = m;
    imp.error = '';
    if (m === 'manual') imp.drafts = [draft(blankRecipe(), 'вручную')];
    renderImport();
    if (m === 'text') $('#paste')?.focus();
    return;
  }
  const go = t.closest('[data-go]')?.dataset.go;
  if (go) {
    if (go === 'close') return dlg.close();
    if (imp.step === 'review' || imp.step === 'manual') readAllEditors();
    if (go === 'choose') { imp.files = []; if (imp.step !== 'review') imp.drafts = []; }
    imp.step = go === 'choose' && imp.drafts.length ? 'choose' : go;
    imp.error = '';
    return renderImport();
  }
  if (t.closest('#dropzone')) return pickFiles(imp.step === 'photo' ? 'image/*' : ACCEPT);
  if (t.closest('[data-camera]')) return pickFiles('image/*', true);
  if (t.closest('[data-parse]')) {
    imp.text = $('#paste').value;
    const found = parseRecipesFromText(imp.text);
    if (!found.length) { imp.error = 'Не получилось найти рецепт. Проверьте, что в тексте есть ингредиенты (с новой строки) или шаги.'; return renderImport(); }
    found.forEach((r) => imp.drafts.push(draft(r, 'текст')));
    imp.step = 'review';
    imp.error = '';
    return renderImport();
  }
  const fix = t.closest('[data-fix]')?.dataset.fix;
  if (fix != null) { imp.text = imp.files[fix].text; imp.step = 'text'; imp.error = ''; return renderImport(); }
  const tog = t.closest('[data-toggle]')?.dataset.toggle;
  if (tog != null) { readAllEditors(); imp.drafts[tog].open = !imp.drafts[tog].open; return renderImport(); }
  if (t.closest('[data-all]')) { readAllEditors(); const all = imp.drafts.every((d) => d.include); imp.drafts.forEach((d) => { d.include = !all; }); return renderImport(); }
  const ph = t.closest('[data-photo]')?.dataset.photo;
  if (ph != null) {
    readAllEditors();
    const [file] = await chooseFiles('image/*', false);
    if (file) { try { imp.drafts[ph].recipe.photo = await imageToDataUrl(file); } catch { imp.error = 'Не удалось прочитать фото'; } renderImport(); }
    return;
  }
  const np = t.closest('[data-nophoto]')?.dataset.nophoto;
  if (np != null) { readAllEditors(); delete imp.drafts[np].recipe.photo; return renderImport(); }
  if (t.closest('[data-save]')) return save();
});

dlg.addEventListener('change', (e) => {
  const inc = e.target.dataset.inc;
  if (inc != null) { readAllEditors(); imp.drafts[inc].include = e.target.checked; if (e.target.checked && imp.drafts[inc].dupId && imp.drafts[inc].dupAction === 'skip') imp.drafts[inc].dupAction = 'copy'; return renderImport(); }
  const dup = e.target.dataset.dup;
  if (dup != null) { readAllEditors(); const d = imp.drafts[dup]; d.dupAction = e.target.value; d.include = d.dupAction !== 'skip'; renderImport(); }
});
dlg.addEventListener('input', (e) => { if (e.target.id === 'paste') { imp.text = e.target.value; clearTimeout(dlg._t); dlg._t = setTimeout(updatePasteHint, 250); } });
dlg.addEventListener('keydown', (e) => { if (e.target.id === 'dropzone' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickFiles(imp.step === 'photo' ? 'image/*' : ACCEPT); } });
dlg.addEventListener('submit', (e) => e.preventDefault());

// Перетаскивание на зону и на всё окно
dlg.addEventListener('dragover', (e) => { if (e.target.closest('#dropzone')) { e.preventDefault(); $('#dropzone').classList.add('over'); } });
dlg.addEventListener('dragleave', (e) => { e.target.closest('#dropzone')?.classList.remove('over'); });

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#drop-overlay').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  if (!dlg.open || !['file', 'photo', 'review'].includes(imp.step)) openImport('file');
  else if (imp.step === 'review') { readAllEditors(); imp.step = 'file'; }
  processFiles(files);
});

// Вставка картинки из буфера (скриншот) в открытом окне «По фото» / «Из файла»
window.addEventListener('paste', (e) => {
  if (!dlg.open || !['photo', 'file'].includes(imp.step)) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); processFiles(files); }
});

const fileInput = $('#file-input');
function chooseFiles(accept, multiple = true, capture = false) {
  return new Promise((resolve) => {
    fileInput.accept = accept;
    fileInput.multiple = multiple;
    if (capture) fileInput.setAttribute('capture', 'environment'); else fileInput.removeAttribute('capture');
    fileInput.value = '';
    fileInput.onchange = () => resolve([...fileInput.files]);
    fileInput.click();
  });
}
async function pickFiles(accept, capture = false) {
  const files = await chooseFiles(accept, true, capture);
  if (files.length) processFiles(files);
}

// ---------------- Общие события ----------------

$('#add-btn').onclick = () => openImport();
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-action=add]')) return openImport();
  const open = e.target.closest('[data-open]')?.dataset.open;
  if (open && !dlg.contains(e.target)) return openRecipe(open);
  const tab = e.target.closest('.tabs [data-view]')?.dataset.view;
  if (tab) return setView(tab);
  const chip = e.target.closest('.chip');
  if (chip) { if ('fav' in chip.dataset) { ui.favOnly = !ui.favOnly; ui.category = ''; } else { ui.category = chip.dataset.cat; ui.favOnly = false; } return renderList(); }
  const un = e.target.closest('[data-unmenu]')?.dataset.unmenu;
  if (un) store.toggleMenu(un);
});
document.addEventListener('change', (e) => { const k = e.target.dataset?.shop; if (k) store.setChecked(k, e.target.checked); });
$('#q-title').addEventListener('input', renderList);
$('#q-ing').addEventListener('input', renderList);
$('#clear-menu').onclick = () => {
  const prev = [...store.menu];
  store.clearMenu();
  toast('Меню очищено', () => prev.forEach((id) => store.toggleMenu(id)));
};

$('#export-btn').onclick = () => {
  const blob = new Blob([store.exportJson()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `recepty-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Копия сохранена в загрузки');
};
$('#restore-btn').onclick = async () => {
  const files = await chooseFiles('.json,application/json', false);
  if (files.length) { openImport('file'); processFiles(files); }
};
$('#wipe-btn').onclick = () => {
  if (!confirm('Удалить все рецепты из этого браузера? Сначала лучше сохранить копию.')) return;
  const prev = [...store.recipes];
  store.replaceAll([]);
  toast('Книга очищена', () => store.replaceAll(prev));
};

store.subscribe((ev) => { if (ev.error) toast(ev.error); renderAll(); });
renderAll();
