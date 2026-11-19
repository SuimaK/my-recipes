'use strict';

const byId = id => document.getElementById(id);
const form = byId('form');
const fields = form.elements;
const formatter = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2});
const wholeFormatter = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 0});
const kilogramFormatter = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 3});
let database;
let current;
let photoURL;
let collectionRecipes = [];
let tilePhotoURLs = [];
const ingredientSearch = byId('ingredient-search');
const titleSearch = byId('title-search');
const categoryOptions = [
  ['breakfasts', 'Завтраки'],
  ['soups', 'Супы'],
  ['salads', 'Салаты'],
  ['mains', 'Основные блюда'],
  ['sides', 'Гарниры'],
  ['baking', 'Выпечка'],
  ['desserts', 'Десерты'],
  ['sauces', 'Соусы'],
  ['drinks', 'Напитки'],
  ['other', 'Другое']
];
const categoryLabels = Object.fromEntries(categoryOptions);
const difficultyOptions = [
  ['easy', 'Легко'],
  ['medium', 'Средне'],
  ['hard', 'Сложно']
];
const difficultyLabels = Object.fromEntries(difficultyOptions);
let activeCategory = 'all';

for (const [value, label] of categoryOptions) {
  const option = element('option', label);
  option.value = value;
  fields.category.append(option);
}
const unspecifiedDifficulty = element('option', 'Не указана');
unspecifiedDifficulty.value = '';
fields.difficulty.append(unspecifiedDifficulty);
for (const [value, label] of difficultyOptions) {
  const option = element('option', label);
  option.value = value;
  fields.difficulty.append(option);
}

function message(value = '') {
  const status = byId('status');
  status.textContent = value;
  status.hidden = !value;
}

function show(id) {
  for (const view of ['collection', 'detail', 'editor', 'importer', 'menus', 'backups']) byId(view).hidden = view !== id;
  const mainView = id === 'collection' || id === 'menus' || id === 'backups';
  byId('tabbar').hidden = !mainView;
  byId('app-title').textContent = id === 'backups' ? 'Резервные копии' : id === 'menus' ? 'Меню' : 'Мои рецепты';
  byId('open-recipes').setAttribute('aria-current', id === 'collection' ? 'page' : 'false');
  byId('open-menus').setAttribute('aria-current', id === 'menus' ? 'page' : 'false');
  byId('open-backups').setAttribute('aria-current', id === 'backups' ? 'page' : 'false');
  message();
  window.scrollTo(0, 0);
}

function element(tag, value) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  return node;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('recipekeeper-stage-one', 2);
    request.onupgradeneeded = event => {
      if (event.oldVersion < 1) request.result.createObjectStore('recipes', {keyPath: 'id', autoIncrement: true});
      if (event.oldVersion < 2) request.result.createObjectStore('menus', {keyPath: 'id', autoIncrement: true});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact(mode, action, storeName = 'recipes') {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

function readAmount(value) {
  const normalized = value.trim().replace(',', '.');
  if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return Number(normalized);
  const fraction = /^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/.exec(normalized);
  if (fraction && Number(fraction[3]) > 0) {
    return Number(fraction[1] || 0) + Number(fraction[2]) / Number(fraction[3]);
  }
  return null;
}

function amountBounds(value) {
  const parts = value.trim().split(/\s*[-–—]\s*/);
  if (parts.length > 2) return null;
  const bounds = parts.map(readAmount);
  if (bounds.some(amount => amount === null || !Number.isFinite(amount))) return null;
  const [low, high = low] = bounds;
  return high >= low ? [low, high] : null;
}

function formatQuantity(amount) {
  return amount > 0 && amount < 0.005 ? '<' + formatter.format(0.01) : formatter.format(amount);
}

function formatBounds(low, high, name, unit) {
  const normalizedUnit = unit.toLowerCase().replace(/\./g, '').trim();
  const eggs = /(?:^|[^\p{L}])(?:яйцо|яйца|яйцы|яиц)(?=$|[^\p{L}])/iu.test(name);
  const inPieces = /^(?:шт|штука|штуки|штук)?$/u.test(normalizedUnit);
  let format = formatQuantity;
  if (/^(?:г|гр|грамм|грамма|граммов|g)$/u.test(normalizedUnit) || (eggs && inPieces)) {
    format = amount => wholeFormatter.format(amount);
  } else if (/^(?:кг|килограмм|килограмма|килограммов|kg)$/u.test(normalizedUnit)) {
    format = amount => kilogramFormatter.format(amount);
  }
  const first = format(low);
  const last = format(high);
  return first === last ? first : first + '–' + last;
}

function ingredientText(ingredient, base, portions) {
  const bounds = amountBounds(ingredient.amount);
  const scaled = bounds && base !== portions
    ? formatBounds(bounds[0] * portions / base, bounds[1] * portions / base, ingredient.name, ingredient.unit)
    : ingredient.amount;
  const quantity = [scaled, ingredient.unit].filter(Boolean).join(' ');
  return quantity ? ingredient.name + ' — ' + quantity : ingredient.name;
}

function ingredientSearchWords(value) {
  return (value.normalize('NFC').toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) || [])
    .map(word => /^(?:яйцо|яйца|яиц)$/u.test(word) ? 'яйц' : word);
}

function inferCategory(recipe = {}) {
  if (categoryLabels[recipe.category]) return recipe.category;
  const title = (recipe.title || '').normalize('NFC').toLocaleLowerCase('ru').replace(/ё/g, 'е');
  const has = pattern => pattern.test(title);
  if (has(/(?:^|\s)(?:омлет|каша|сырник|яичниц|гранол|завтрак)/u)) return 'breakfasts';
  if (has(/суп|борщ|щи(?:\s|$)|уха|солянк|окрошк|бульон|харчо|рассольник/u)) return 'soups';
  if (has(/салат|винегрет/u)) return 'salads';
  if (has(/соус|песто|майонез|заправк|гуакамоле|хумус/u)) return 'sauces';
  if (has(/напит|лимонад|смузи|коктейль|компот|морс|чай|кофе|какао/u)) return 'drinks';
  if (has(/пирог|пирож|булоч|хлеб|маффин|печенье|печенья|кекс|вафл|блин|олад|пицц|тесто|синнабон|пончик/u)) return 'baking';
  if (has(/торт|десерт|мусс|панна|желе|трюфел|тирамис|морожен|конфет|чизкейк|брауни|пралине/u)) return 'desserts';
  if (has(/гарнир|ризотто|рис|гречк|картоф|кускус|булгур|киноа|полент|пюре/u)) return 'sides';
  if (has(/куриц|индейк|говядин|свинин|баранин|кролик|рыб|лосос|треск|котлет|тефтел|фрикадел|стейк|запеканк|рагу|паста|кревет|миди|омар|кальмар/u)) return 'mains';
  return 'other';
}

function matchingRecipes(recipes, titleQuery, ingredientQuery) {
  return recipes.filter(recipe => {
    if (activeCategory === 'favorites' && !recipe.favorite) return false;
    if (activeCategory === 'preparations' && !recipe.isPrep) return false;
    if (activeCategory !== 'all' && activeCategory !== 'favorites' && activeCategory !== 'preparations'
        && inferCategory(recipe) !== activeCategory) return false;
    const normalizedTitle = (recipe.title || '').normalize('NFC').toLocaleLowerCase('ru').replace(/ё/g, 'е');
    if (titleQuery.length && !titleQuery.every(term => normalizedTitle.includes(term))) return false;
    if (!ingredientQuery.length) return true;
    return recipe.ingredients.some(ingredient => {
      const words = ingredientSearchWords(ingredient.name);
      return ingredientQuery.every(term => words.some(word => word.startsWith(term)));
    });
  });
}

function renderCategoryFilters() {
  const filter = byId('category-filters');
  filter.replaceChildren();
  for (const [value, label] of [['all', 'Все'], ['favorites', '♥ Избранное'],
    ['preparations', '❄ Заготовки'], ...categoryOptions]) {
    const button = element('button', label);
    button.type = 'button';
    button.className = 'category-filter';
    button.setAttribute('aria-pressed', String(activeCategory === value));
    button.onclick = () => {
      activeCategory = value;
      renderCategoryFilters();
      renderRecipeList();
    };
    filter.append(button);
  }
}

function updateFavoriteButton(button, recipe) {
  button.textContent = recipe.favorite ? '♥' : '♡';
  button.setAttribute('aria-pressed', String(Boolean(recipe.favorite)));
  button.setAttribute('aria-label', recipe.favorite ? 'Убрать из избранного' : 'Добавить в избранное');
}

function favoriteButton(recipe, rerender = false) {
  const button = element('button');
  button.type = 'button';
  button.className = 'favorite-button';
  updateFavoriteButton(button, recipe);
  button.onclick = async event => {
    event.stopPropagation();
    const previous = Boolean(recipe.favorite);
    recipe.favorite = !previous;
    updateFavoriteButton(button, recipe);
    button.disabled = true;
    try {
      await transact('readwrite', store => store.put(recipe));
      if (rerender) renderRecipeList();
    } catch {
      recipe.favorite = previous;
      updateFavoriteButton(button, recipe);
      message('Не удалось изменить избранное.');
    } finally {
      button.disabled = false;
    }
  };
  return button;
}

function renderRecipeList() {
  const titleQuery = ingredientSearchWords(titleSearch.value);
  const ingredientQuery = ingredientSearchWords(ingredientSearch.value);
  const recipes = matchingRecipes(collectionRecipes, titleQuery, ingredientQuery);
  const list = byId('recipes');
  for (const url of tilePhotoURLs) URL.revokeObjectURL(url);
  tilePhotoURLs = [];
  const filtering = titleQuery.length || ingredientQuery.length || activeCategory !== 'all';
  byId('recipe-search-status').textContent = filtering && recipes.length
    ? 'Рецептов найдено — ' + recipes.length : '';
  list.replaceChildren();
  if (!recipes.length) {
    const empty = element('p', filtering ? 'Рецептов по выбранным условиям пока нет.'
      : 'Здесь будут твои рецепты. Добавь первый, чтобы начать.');
    empty.className = 'empty';
    list.append(empty);
  }
  for (const recipe of recipes) {
    const tile = element('article');
    tile.className = 'tile';
    const button = element('button');
    button.className = 'tile-open';
    const media = element('span');
    media.className = 'tile-media';
    if (recipe.photo) {
      const url = URL.createObjectURL(recipe.photo);
      tilePhotoURLs.push(url);
      const image = element('img');
      image.src = url;
      image.alt = '';
      media.append(image);
    } else {
      const placeholder = element('span', '♨');
      placeholder.className = 'tile-placeholder';
      placeholder.setAttribute('aria-hidden', 'true');
      media.append(placeholder);
    }
    const content = element('span');
    content.className = 'tile-content';
    content.append(element('strong', recipe.title));
    const meta = element('small', [recipe.minutes && recipe.minutes + ' мин', recipe.servings + ' порц.']
      .filter(Boolean).join(' · '));
    meta.className = 'tile-meta';
    content.append(meta);
    const category = element('span', categoryLabels[inferCategory(recipe)]);
    category.className = 'category-label';
    content.append(category);
    if (difficultyLabels[recipe.difficulty]) {
      const difficulty = element('span', difficultyLabels[recipe.difficulty]);
      difficulty.className = 'difficulty-label difficulty-' + recipe.difficulty;
      content.append(difficulty);
    }
    if (recipe.isPrep) {
      const prep = element('span', '❄ Заготовка');
      prep.className = 'prep-label';
      content.append(prep);
    }
    button.append(media, content);
    button.onclick = () => viewRecipe(recipe);
    tile.append(button, favoriteButton(recipe, true));
    list.append(tile);
  }
}

ingredientSearch.oninput = renderRecipeList;
titleSearch.oninput = renderRecipeList;
renderCategoryFilters();

async function listRecipes() {
  collectionRecipes = (await transact('readonly', store => store.getAll())).reverse();
  ingredientSearch.disabled = false;
  titleSearch.disabled = false;
  renderRecipeList();
  if (photoURL) URL.revokeObjectURL(photoURL);
  photoURL = undefined;
  current = undefined;
  show('collection');
}

function commentsPanel(recipe) {
  const section = element('section');
  section.className = 'comments-panel';
  section.append(element('h3', 'Мои заметки'));
  const hint = element('p', 'Сохраняй здесь свои изменения, впечатления и идеи для следующего раза.');
  hint.className = 'comments-hint';
  section.append(hint);
  const list = element('div');
  list.className = 'comments-list';
  const commentForm = element('form');
  commentForm.className = 'comment-form';
  const textarea = element('textarea');
  textarea.rows = 3;
  textarea.maxLength = 1000;
  textarea.placeholder = 'Например: в следующий раз добавить меньше сахара';
  textarea.setAttribute('aria-label', 'Новая заметка');
  const submit = element('button', 'Добавить заметку');
  submit.type = 'submit';
  commentForm.append(textarea, submit);

  const draw = () => {
    list.replaceChildren();
    const comments = Array.isArray(recipe.comments) ? recipe.comments : [];
    if (!comments.length) {
      const empty = element('p', 'Заметок пока нет.');
      empty.className = 'comments-empty';
      list.append(empty);
      return;
    }
    for (const comment of [...comments].reverse()) {
      const row = element('article');
      row.className = 'comment';
      const text = element('p', comment.text);
      const meta = element('time', new Date(comment.createdAt).toLocaleDateString('ru-RU'));
      meta.dateTime = comment.createdAt;
      const remove = element('button', 'Удалить');
      remove.type = 'button';
      remove.className = 'comment-remove';
      remove.onclick = async () => {
        remove.disabled = true;
        const previous = recipe.comments;
        recipe.comments = comments.filter(item => item.id !== comment.id);
        try {
          await transact('readwrite', store => store.put(recipe));
          draw();
        } catch {
          recipe.comments = previous;
          remove.disabled = false;
          message('Не удалось удалить заметку.');
        }
      };
      const footer = element('div');
      footer.className = 'comment-footer';
      footer.append(meta, remove);
      row.append(text, footer);
      list.append(row);
    }
  };
  commentForm.onsubmit = async event => {
    event.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    submit.disabled = true;
    const previous = recipe.comments;
    recipe.comments = [...(Array.isArray(previous) ? previous : []), {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      text,
      createdAt: new Date().toISOString()
    }];
    try {
      await transact('readwrite', store => store.put(recipe));
      textarea.value = '';
      draw();
    } catch {
      recipe.comments = previous;
      message('Не удалось сохранить заметку.');
    } finally {
      submit.disabled = false;
    }
  };
  draw();
  section.append(list, commentForm);
  return section;
}

function viewRecipe(recipe) {
  current = recipe;
  const card = byId('card');
  card.replaceChildren();
  if (photoURL) URL.revokeObjectURL(photoURL);
  photoURL = undefined;
  const hero = element('div');
  hero.className = 'recipe-hero';
  if (recipe.photo) {
    photoURL = URL.createObjectURL(recipe.photo);
    const openPhoto = element('button');
    openPhoto.type = 'button';
    openPhoto.className = 'photo-open';
    openPhoto.setAttribute('aria-label', 'Открыть фото полностью');
    const img = element('img');
    img.alt = recipe.title;
    img.src = photoURL;
    openPhoto.append(img);
    openPhoto.onclick = () => {
      byId('photo-full').src = photoURL;
      byId('photo-full').alt = recipe.title;
      byId('photo-dialog').showModal();
    };
    hero.append(openPhoto);
  } else {
    const placeholder = element('span', '♨');
    placeholder.className = 'detail-placeholder';
    placeholder.setAttribute('aria-hidden', 'true');
    hero.append(placeholder);
  }
  hero.append(favoriteButton(recipe));
  card.append(hero);
  card.append(element('h2', recipe.title));
  const badges = element('div');
  badges.className = 'recipe-badges';
  const category = element('span', categoryLabels[inferCategory(recipe)]);
  category.className = 'category-badge';
  badges.append(category);
  if (difficultyLabels[recipe.difficulty]) {
    const difficulty = element('span', 'Сложность · ' + difficultyLabels[recipe.difficulty]);
    difficulty.className = 'difficulty-badge difficulty-' + recipe.difficulty;
    badges.append(difficulty);
  }
  if (recipe.isPrep) {
    const prep = element('span', '❄ Заготовка');
    prep.className = 'prep-badge';
    badges.append(prep);
  }
  card.append(badges);
  if (recipe.minutes) card.append(element('p', 'Время приготовления · ' + recipe.minutes + ' мин'));
  const counter = element('div');
  counter.className = 'counter';
  const label = element('label', 'Порции');
  label.htmlFor = 'portion-count';
  const minus = element('button', '−');
  const plus = element('button', '+');
  minus.setAttribute('aria-label', 'Уменьшить число порций');
  plus.setAttribute('aria-label', 'Увеличить число порций');
  const input = element('input');
  input.id = 'portion-count';
  input.type = 'number';
  input.inputMode = 'numeric';
  input.min = 1;
  input.max = 999;
  const ingredients = element('ul');
  let portions = recipe.servings;
  function render() {
    input.value = portions;
    minus.disabled = portions <= 1;
    plus.disabled = portions >= 999;
    ingredients.replaceChildren(...recipe.ingredients.map(item =>
      element('li', ingredientText(item, recipe.servings, portions))));
  }
  function update(delta) {
    const entered = input.valueAsNumber;
    if (Number.isInteger(entered) && entered >= 1 && entered <= 999) portions = entered;
    portions = Math.max(1, Math.min(999, portions + delta));
    render();
  }
  input.oninput = () => {
    const entered = input.valueAsNumber;
    if (Number.isInteger(entered) && entered >= 1 && entered <= 999) update(0);
  };
  input.onchange = () => update(0);
  minus.onclick = () => update(-1);
  plus.onclick = () => update(1);
  counter.append(label, minus, input, plus);
  ingredients.setAttribute('aria-live', 'polite');
  const steps = element('p', recipe.instructions);
  steps.className = 'steps';
  card.append(counter, element('h3', 'Ингредиенты'), ingredients, element('h3', 'Приготовление'), steps,
    commentsPanel(recipe));
  render();
  show('detail');
}

function ingredientRow(ingredient = {}) {
  const row = byId('ingredient-template').content.firstElementChild.cloneNode(true);
  for (const input of row.querySelectorAll('input')) input.value = ingredient[input.dataset.key] || '';
  row.querySelector('button').onclick = () => {
    row.remove();
    if (!byId('ingredients').childElementCount) ingredientRow();
  };
  byId('ingredients').append(row);
}

let draftPhoto;
function editRecipe(recipe, imported = false, sourceText = '') {
  current = imported ? undefined : recipe;
  draftPhoto = imported ? recipe.photo : undefined;
  byId('import-note').hidden = !imported;
  byId('import-source').hidden = !sourceText;
  byId('import-source').open = false;
  byId('import-source-text').textContent = sourceText;
  form.reset();
  byId('form-title').textContent = recipe && !imported ? 'Редактировать рецепт' : 'Новый рецепт';
  byId('clear-photo').hidden = !(recipe?.photo || draftPhoto);
  for (const field of ['title', 'minutes', 'servings', 'instructions']) {
    if (recipe) fields[field].value = recipe[field] ?? '';
  }
  fields.category.value = recipe ? inferCategory(recipe) : 'other';
  fields.difficulty.value = recipe?.difficulty || '';
  fields.isPrep.checked = Boolean(recipe?.isPrep);
  byId('ingredients').replaceChildren();
  if (recipe?.ingredients.length) recipe.ingredients.forEach(ingredientRow);
  else ingredientRow();
  show('editor');
  fields.title.focus();
}

async function saveRecipe(event) {
  event.preventDefault();
  const title = fields.title.value.trim();
  const instructions = fields.instructions.value.trim();
  const ingredients = [...byId('ingredients').children].map(row =>
    Object.fromEntries([...row.querySelectorAll('input')].map(input => [input.dataset.key, input.value.trim()])));
  if (!title || !instructions || ingredients.some(item => !item.name)) {
    message('Заполни название, инструкцию и названия ингредиентов.');
    return;
  }
  const file = fields.photo.files[0];
  if (file && file.type && !file.type.startsWith('image/')) {
    message('Выбери файл изображения.');
    return;
  }
  const recipe = {
    title,
    category: fields.category.value,
    difficulty: fields.difficulty.value,
    isPrep: fields.isPrep.checked,
    minutes: fields.minutes.valueAsNumber || null,
    servings: fields.servings.valueAsNumber,
    instructions,
    ingredients,
    photo: file || (fields.clearPhoto.checked ? null : current?.photo || draftPhoto || null)
  };
  if (current) {
    recipe.id = current.id;
    recipe.favorite = Boolean(current.favorite);
    recipe.comments = Array.isArray(current.comments) ? current.comments : [];
    if (current.importKey) recipe.importKey = current.importKey;
  }
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  byId('cancel').disabled = true;
  try {
    recipe.id = await transact('readwrite', store => store.put(recipe));
    viewRecipe(recipe);
  } catch {
    message('Не удалось сохранить рецепт. Проверь, есть ли свободное место на устройстве, и попробуй ещё раз.');
  } finally {
    submit.disabled = false;
    byId('cancel').disabled = false;
  }
}

function returnToList() {
  return listRecipes().catch(() => message('Не удалось загрузить список рецептов.'));
}

const addDialog = byId('add-dialog');
byId('add-trigger').onclick = () => addDialog.showModal();
byId('close-add').onclick = () => addDialog.close();
addDialog.onclick = event => { if (event.target === addDialog) addDialog.close(); };
const photoDialog = byId('photo-dialog');
byId('close-photo').onclick = () => photoDialog.close();
photoDialog.onclick = event => { if (event.target === photoDialog) photoDialog.close(); };
byId('add').onclick = () => { addDialog.close(); editRecipe(); };
byId('open-recipes').onclick = returnToList;
byId('edit').onclick = () => editRecipe(current);
byId('back').onclick = returnToList;
byId('cancel').onclick = () => current ? viewRecipe(current) : show('collection');
byId('add-ingredient').onclick = () => ingredientRow();
byId('remove').onclick = async () => {
  if (!confirm('Удалить этот рецепт?')) return;
  const remove = byId('remove');
  remove.disabled = true;
  try {
    await transact('readwrite', store => store.delete(current.id));
    await returnToList();
  } catch {
    message('Не удалось удалить рецепт.');
  } finally {
    remove.disabled = false;
  }
};
form.onsubmit = saveRecipe;

async function start() {
  try {
    database = await openDatabase();
    await listRecipes();
    byId('add').disabled = false;
    byId('add-trigger').disabled = false;
  } catch {
    message('Не удалось открыть хранилище рецептов. Открой приложение в Safari и проверь настройки хранения данных.');
    return;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {
    message('Офлайн-режим пока недоступен. Перезагрузи приложение с интернетом.');
  });
}

start();

byId('open-backups').onclick = () => { if (database) show('backups'); };
