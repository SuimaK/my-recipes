// Разбор текста рецептов. Чистые функции без DOM — их тестирует node:test.

const SECTION_PATTERNS = {
  ingredients: /^(ингредиенты|ингридиенты|продукты|состав|список продуктов|что нужно|нам понадобится|вам понадобится|понадобится|ingredients)(?![\p{L}\p{N}])/iu,
  steps: /^(приготовление|способ приготовления|как приготовить|как готовить|инструкция|рецепт приготовления|шаги|ход приготовления|процесс|directions|instructions|method|preparation|steps)(?![\p{L}\p{N}])/iu,
  notes: /^(заметки|примечания?|советы?|совет повара|подача|notes|tips)(?![\p{L}\p{N}])/iu,
};

const META_PATTERNS = {
  servings: /^(порции|порций|количество порций|кол-во порций|на \d+ порц\p{L}*|выход|servings|serves|yield)(?![\p{L}\p{N}])/iu,
  time: /^(время( приготовления)?|общее время|prep time|cook time|total time|time)(?![\p{L}\p{N}])/iu,
  category: /^(категория|раздел|тип блюда|category)(?![\p{L}\p{N}])/iu,
  source: /^(источник|ссылка|source)(?![\p{L}\p{N}])/iu,
};

const SEPARATOR = /^\s*(?:-{3,}|\*{3,}|={3,}|_{3,}|~{3,}|#{3,}\s*$|\f)\s*$/;
const UNITS = 'г|гр|грамм|граммов|грамма|кг|мл|л|литр|литра|ст\\.?\\s?л|ч\\.?\\s?л|ст|стак|стакан|стакана|стаканов|шт|штук|штуки|зубч|зубчика|зубчик|пуч|пучок|щепотка|щепотки|по вкусу|упак|банка|банки|g|kg|ml|l|tbsp|tsp|cup|cups|oz|lb|pcs';
const NB = '(?![\\p{L}\\p{N}])';
const QUANTITY_LINE = new RegExp(`[\\d½¼¾⅓⅔]|(?<![\\p{L}\\p{N}])(${UNITS})${NB}|по вкусу|щепотк`, 'iu');
const BULLET = /^\s*(?:[-–—•·*▪◦●○✓✔]|\d+[.)]\s|\(\d+\)|[a-zа-я]\))\s*/i;
const NUMBERED = /^\s*(?:шаг\s*)?(\d{1,2})\s*[.):\-–]\s*/i;

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function stripMarkdown(line) {
  return line.replace(/^#{1,6}\s+/, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').trim();
}

function headerOf(line) {
  const clean = stripMarkdown(line).replace(/[:：]\s*$/, '').trim();
  for (const [key, re] of Object.entries(SECTION_PATTERNS)) {
    if (re.test(clean)) {
      // «Ингредиенты: мука, сахар» — заголовок со списком в той же строке.
      const m = stripMarkdown(line).match(/^[^:：]+[:：]\s*(.+)$/);
      return { key, rest: m ? m[1].trim() : '' , short: clean.length < 40 || !!m };
    }
  }
  return null;
}

function metaOf(line) {
  const clean = stripMarkdown(line);
  for (const [key, re] of Object.entries(META_PATTERNS)) {
    if (re.test(clean)) {
      const m = clean.match(/^[^:：\-–—]+[:：\-–—]\s*(.+)$/);
      const value = (m ? m[1] : clean).trim();
      if (clean.length <= 80) return { key, value };
    }
  }
  return null;
}

function stripBullet(line) {
  return line.replace(BULLET, '').trim();
}

function looksLikeIngredient(line) {
  const t = line.trim();
  if (!t || t.length > 90) return false;
  if (/[.!?]$/.test(t) && t.split(' ').length > 6) return false;
  return QUANTITY_LINE.test(t) || /^[-–—•*]/.test(t);
}

function splitInline(list) {
  return list
    .split(/[;,](?![^()]*\))/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isTitleCandidate(line) {
  const t = stripMarkdown(line);
  if (!t || t.length > 80) return false;
  if (headerOf(t) || metaOf(t)) return false;
  if (/[.!?;]$/.test(t) && t.split(' ').length > 5) return false;
  if (QUANTITY_LINE.test(t) && /^\s*[-–•*\d]/.test(t)) return false;
  return true;
}

function cleanTitle(line) {
  return stripMarkdown(line)
    .replace(/^(рецепт|recipe)\s*(№?\s*\d+)?\s*[:.\-–—]\s*/i, '')
    .replace(/^\d{1,3}\s*[.)]\s+/, '')
    .replace(/[:：]\s*$/, '')
    .trim();
}

function parseServings(value) {
  const m = String(value).match(/\d+/);
  return m ? Number(m[0]) : null;
}

/** Разбирает текст одного рецепта. */
export function parseRecipe(text) {
  const lines = normalizeText(text).split('\n');
  const recipe = { title: '', ingredients: [], steps: [], notes: '', servings: null, time: '', category: '', source: '' };
  const notes = [];
  let section = null;
  let i = 0;

  // Заголовок — первая подходящая непустая строка.
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && isTitleCandidate(lines[i])) {
    recipe.title = cleanTitle(lines[i]);
    i++;
  }

  const body = [];
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { body.push({ type: 'blank' }); continue; }
    const h = headerOf(line);
    if (h && h.short) {
      section = h.key;
      if (h.rest) body.push({ type: 'text', section, text: h.rest, inline: true });
      continue;
    }
    const meta = metaOf(line);
    if (meta && section !== 'steps') {
      if (meta.key === 'servings') recipe.servings = parseServings(meta.value);
      else recipe[meta.key] = meta.value;
      continue;
    }
    body.push({ type: 'text', section, text: line });
  }

  const hasSections = body.some((b) => b.section);

  if (hasSections) {
    for (const b of body) {
      if (b.type !== 'text') continue;
      const sec = b.section ?? (looksLikeIngredient(b.text) ? 'ingredients' : 'steps');
      if (sec === 'ingredients') {
        if (b.inline && /[,;]/.test(b.text)) recipe.ingredients.push(...splitInline(b.text));
        else recipe.ingredients.push(stripBullet(b.text));
      } else if (sec === 'steps') {
        recipe.steps.push(b.text);
      } else {
        notes.push(b.text);
      }
    }
  } else {
    // Без заголовков: ведущий блок строк «с количеством» — ингредиенты, остальное — шаги.
    let phase = 'ingredients';
    for (const b of body) {
      if (b.type === 'blank') { if (phase === 'ingredients' && recipe.ingredients.length) phase = 'steps'; continue; }
      if (phase === 'ingredients' && looksLikeIngredient(b.text)) recipe.ingredients.push(stripBullet(b.text));
      else { phase = 'steps'; recipe.steps.push(b.text); }
    }
  }

  recipe.steps = mergeSteps(recipe.steps);
  recipe.ingredients = recipe.ingredients.filter(Boolean);
  recipe.notes = notes.join('\n');
  if (!recipe.title) recipe.title = guessTitle(recipe);
  return recipe;
}

/** Объединяет строки-продолжения в шаги и убирает нумерацию. */
function mergeSteps(lines) {
  const numbered = lines.some((l) => NUMBERED.test(l));
  const out = [];
  for (const l of lines) {
    if (numbered) {
      if (NUMBERED.test(l) || !out.length) out.push(l.replace(NUMBERED, '').replace(BULLET, '').trim());
      else out[out.length - 1] += ' ' + l.trim();
    } else {
      out.push(stripBullet(l));
    }
  }
  return out.filter(Boolean);
}

function guessTitle(recipe) {
  const first = recipe.ingredients[0] || recipe.steps[0] || '';
  return first ? `Рецепт: ${first.slice(0, 40)}` : 'Без названия';
}

/**
 * Делит сборник на отдельные рецепты.
 * Признаки границы: строка-разделитель (---, ***, ===), «Рецепт №N»,
 * или повтор раздела «Ингредиенты» — тогда заголовок нового рецепта —
 * строка(и) перед ним.
 */
export function splitCollection(text) {
  const norm = normalizeText(text);
  if (!norm) return [];

  // 1) Явные разделители.
  const bySep = norm.split('\n').reduce((acc, line) => {
    if (SEPARATOR.test(line)) acc.push([]);
    else acc[acc.length - 1].push(line);
    return acc;
  }, [[]]).map((l) => l.join('\n').trim()).filter(Boolean);
  if (bySep.length > 1) return bySep.flatMap((chunk) => splitCollection(chunk));

  const lines = norm.split('\n');

  // 2) «Рецепт 1», «Рецепт №2: ...»
  const recipeMarks = lines.map((l, idx) => (/^\s*#*\s*(рецепт|recipe)\s*№?\s*\d+/i.test(l) ? idx : -1)).filter((x) => x >= 0);
  if (recipeMarks.length > 1) return cutAt(lines, recipeMarks);

  // 3) Повторяющиеся «Ингредиенты».
  const ingHeaders = lines.map((l, idx) => { const h = headerOf(l.trim()); return h && h.key === 'ingredients' && h.short ? idx : -1; }).filter((x) => x >= 0);
  if (ingHeaders.length > 1) {
    const starts = ingHeaders.map((idx) => findTitleStart(lines, idx));
    if (starts[0] > 0 && !lines.slice(0, starts[0]).some((l) => l.trim())) starts[0] = 0;
    return cutAt(lines, starts[0] === 0 ? starts : [0, ...starts]).filter((c) => c.trim());
  }

  // 4) Markdown-заголовки «# Название» при наличии нескольких.
  const mdHeads = lines.map((l, idx) => (/^#{1,2}\s+\S/.test(l) && !headerOf(l) ? idx : -1)).filter((x) => x >= 0);
  if (mdHeads.length > 1) return cutAt(lines, mdHeads);

  return [norm];
}

function findTitleStart(lines, headerIdx) {
  // Поднимаемся вверх: пропускаем пустые и мета-строки, берём заголовок.
  let j = headerIdx - 1;
  while (j >= 0 && (!lines[j].trim() || metaOf(lines[j].trim()))) j--;
  if (j >= 0 && isTitleCandidate(lines[j]) && (j === 0 || !lines[j - 1].trim() || SEPARATOR.test(lines[j - 1]))) return j;
  // Не нашли отдельной строки-заголовка: граница прямо перед разделом.
  return j >= 0 && isTitleCandidate(lines[j]) ? j : headerIdx;
}

function cutAt(lines, starts) {
  const sorted = [...new Set(starts)].sort((a, b) => a - b);
  const chunks = [];
  if (sorted[0] > 0) {
    const head = lines.slice(0, sorted[0]).join('\n').trim();
    if (head) chunks.push(head);
  }
  sorted.forEach((s, k) => {
    chunks.push(lines.slice(s, sorted[k + 1] ?? lines.length).join('\n').trim());
  });
  return chunks.filter(Boolean);
}

/** Текст (один рецепт или сборник) → массив рецептов. */
export function parseRecipesFromText(text) {
  return splitCollection(text)
    .map(parseRecipe)
    .filter((r) => r.ingredients.length || r.steps.length);
}

// ---------- JSON / HTML (schema.org) ----------

function asArray(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }

function flattenInstructions(ins) {
  return asArray(ins).flatMap((s) => {
    if (typeof s === 'string') return s.split(/\n+/).map((t) => t.trim()).filter(Boolean);
    if (s && s['@type'] === 'HowToSection') return flattenInstructions(s.itemListElement);
    return s && s.text ? [String(s.text).trim()] : [];
  });
}

function parseIsoDuration(v) {
  const m = String(v || '').match(/^P(?:T)?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m || (!m[1] && !m[2])) return String(v || '');
  const parts = [];
  if (m[1]) parts.push(`${m[1]} ч`);
  if (m[2]) parts.push(`${m[2]} мин`);
  return parts.join(' ');
}

function fromSchemaOrg(obj) {
  return {
    title: String(obj.name || '').trim() || 'Без названия',
    ingredients: asArray(obj.recipeIngredient || obj.ingredients).map(String).map((s) => s.trim()).filter(Boolean),
    steps: flattenInstructions(obj.recipeInstructions),
    servings: parseServings(asArray(obj.recipeYield)[0] ?? '') ,
    time: parseIsoDuration(obj.totalTime || obj.cookTime || obj.prepTime),
    category: asArray(obj.recipeCategory)[0] || '',
    notes: typeof obj.description === 'string' ? obj.description : '',
    source: typeof obj.url === 'string' ? obj.url : '',
  };
}

function findSchemaRecipes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => findSchemaRecipes(n, out)); return out; }
  const type = asArray(node['@type']).map(String);
  if (type.includes('Recipe')) out.push(fromSchemaOrg(node));
  if (node['@graph']) findSchemaRecipes(node['@graph'], out);
  return out;
}

function coerceOwn(r) {
  const toList = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((s) => String(s).trim()).filter(Boolean);
  return {
    title: String(r.title || r.name || '').trim() || 'Без названия',
    ingredients: toList(r.ingredients),
    steps: toList(r.steps || r.instructions),
    servings: r.servings != null && r.servings !== '' ? parseServings(r.servings) : null,
    time: String(r.time || ''),
    category: String(r.category || ''),
    notes: String(r.notes || ''),
    source: String(r.source || ''),
    photo: typeof r.photo === 'string' && r.photo.startsWith('data:image/') ? r.photo : undefined,
    favorite: !!r.favorite,
  };
}

/** JSON резервной копии приложения, массив рецептов или schema.org Recipe. */
export function parseRecipesFromJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Файл JSON повреждён или имеет неверный формат'); }
  const schema = findSchemaRecipes(data);
  if (schema.length) return { recipes: schema, menu: null };
  const list = Array.isArray(data) ? data : asArray(data.recipes);
  if (!list.length) throw new Error('В файле JSON не найдено рецептов');
  return { recipes: list.filter((r) => r && typeof r === 'object').map(coerceOwn), menu: Array.isArray(data) ? null : data.menu ?? null };
}

/** Ищет schema.org Recipe в JSON-LD сохранённой веб-страницы. */
export function parseRecipesFromHtml(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { findSchemaRecipes(JSON.parse(m[1].trim()), out); } catch { /* пропускаем битый блок */ }
  }
  if (out.length) return out;
  const text = html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return parseRecipesFromText(text.split('\n').map((l) => l.trim()).join('\n'));
}

// ---------- Дубликаты ----------

export function normalizeTitle(t) {
  return String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function findDuplicate(recipe, existing) {
  const key = normalizeTitle(recipe.title);
  if (!key) return null;
  return existing.find((r) => normalizeTitle(r.title) === key) || null;
}
