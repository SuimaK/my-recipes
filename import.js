'use strict';

const importForm = byId('import-form');
const singleQuantity = String.raw`(?:\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d*\s*[¼½¾⅓⅔⅛⅜⅝⅞]|\d+(?:[.,]\d+)?)`;
const quantityPattern = singleQuantity + '(?:\\s*[-–—]\\s*' + singleQuantity + ')?';
const unitsPattern = String.raw`(?:ст\.?\s*л\.?|ч\.?\s*л\.?|кг|мг|грамм(?:а|ов)?|г|мл|литр(?:а|ов)?|л|шт\.?|штук(?:а|и)?|стакан(?:а|ов)?|щепотк[аи]|зубчик(?:а|ов)?|головк[аи]|стебл(?:и|я|ей)?|пуч(?:ок|ка)|веточк[аи]|лист(?:а|ов|ьев)?|банк[аи]|упаковк[аи])`;
const leadingQuantity = new RegExp('^(' + quantityPattern + ')\\s*(' + unitsPattern + ')?(?=\\s|$)\\s*(.*)$', 'iu');
const trailingQuantity = new RegExp('^(.*?)\\s*[-–—:]\\s*(' + quantityPattern + ')\\s*(' + unitsPattern + ')?\\s*$', 'iu');
const endingQuantity = new RegExp('^(.+?)\\s+(' + quantityPattern + ')\\s*(' + unitsPattern + ')?\\s*$', 'iu');
const descriptiveQuantity = new RegExp('^(.+?)\\s+(' + quantityPattern + ')\\s+((?:(?:небольш|средн|крупн)\\p{L}*\\s+)?(?:головк|луковиц|стебл|пуч|веточк|лист|почат|дольк)\\p{L}*)\\s*$', 'iu');
const fractionMap = {'¼':'1/4','½':'1/2','¾':'3/4','⅓':'1/3','⅔':'2/3','⅛':'1/8','⅜':'3/8','⅝':'5/8','⅞':'7/8'};

function stripRecipeMarker(line) {
  return line.replace(/^\s*(?:[-–—•●▪·🔹🔸🔷🔶✅✔☑]+[\uFE0F\s]*)+/u, '').trim();
}

function parseIngredient(line) {
  const notes = [];
  const cleaned = stripRecipeMarker(line).replace(/\([^)]*\)/gu, match => { notes.push(match); return ''; }).trim();
  const special = /^(.*?)\s*[-–—:]\s*(на кончике ножа|по вкусу)$/iu.exec(cleaned);
  if (special) return {name: [special[1], ...notes].join(' '), amount: special[2], unit: ''};
  const toTaste = /^(.*?)[\s–—:-]+(по вкусу|опционально|по желанию)$/iu.exec(cleaned);
  if (toTaste) return {name: [toTaste[1], ...notes].join(' '), amount: toTaste[2], unit: ''};
  const first = leadingQuantity.exec(cleaned);
  const ending = endingQuantity.exec(cleaned) || descriptiveQuantity.exec(cleaned);
  const last = ending && /[-–—]/u.test(ending[2]) ? ending : trailingQuantity.exec(cleaned) || ending;
  let name = cleaned;
  let amount = '';
  let unit = '';
  if (first?.[3]) [, amount, unit = '', name] = first;
  else if (last) {
    [, name, amount, unit = ''] = last;
    if (last === ending) name = name.replace(/\s*[-–—:]\s*$/u, '');
  }
  amount = amount.replace(/[¼½¾⅓⅔⅛⅜⅝⅞]/g, char => ' ' + fractionMap[char]).trim().replace(/\s+/g, ' ');
  if (/^(?:крупн\p{L}*|мелк\p{L}*|средн\p{L}*)?\s*(?:яйцо|яйца|яиц)$/iu.test(name.trim())) unit = 'шт.';
  if (/^грамм/iu.test(unit)) unit = 'г';
  if (/^ч\.?\s*л\.?$/iu.test(unit)) unit = 'ч.л.';
  return {name: [name.trim(), ...notes].join(' '), amount, unit};
}

function parseRecipe(text) {
  const lines = text.replace(/\u00a0/g, ' ').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let title = '';
  const totalTime = /общее\s+время(?:\s+приготовления)?\s*[:–—-]?\s*(?:(\d+)\s*(?:ч(?:ас(?:а|ов)?)?\.?)\s*)?(?:(\d+)\s*(?:мин(?:ут(?:а|ы)?)?\.?))?/iu.exec(text);
  let minutes = totalTime && (totalTime[1] || totalTime[2]) ? (+totalTime[1] || 0) * 60 + (+totalTime[2] || 0) : null;
  const sourcePortions = /(?:рецепт\s+рассчитан[^\n]{0,40}?|(?:^|\s)на\s+)(\d+)\s*(?:[-–—]\s*\d+\s*)?порци[ийюя]/iu.exec(text);
  let servings = sourcePortions ? +sourcePortions[1] : 4;
  let yieldNote = '';
  let section = '';
  const ingredients = [];
  const steps = [];
  for (const source of lines) {
    const markedStep = /^[✔✅☑]/u.test(source);
    const markedIngredient = /^[🔹🔸🔷🔶•●▪·]/u.test(source);
    const line = stripRecipeMarker(source.replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '')).replace(/^[«“]|[»”]$/gu, '').trim();
    if (!line) continue;
    const yieldHeader = /^(?:на|выход\s*:?)\s*(\d+(?:\s*[-–—]\s*\d+)?)\s*(шт\.?|штук[аи]?|порци[ийюя])(?:\s+(?:понадобится|потребуется|нужно))?\s*:?$/iu.exec(line);
    if (yieldHeader) {
      if (/^порци/iu.test(yieldHeader[2])) servings = parseInt(yieldHeader[1], 10);
      else {
        if (!sourcePortions) servings = 1;
        yieldNote = 'Выход: ' + yieldHeader[1] + ' шт. Количества указаны на 1 партию.';
      }
      section = 'ingredients';
      continue;
    }
    if (/^(?:нам\s+)?(?:понадобится|потребуется|нужно)\s*:$/iu.test(line)) { section = 'ingredients'; continue; }
    if (markedStep || (ingredients.length && /^(?:взби(?:ваем|ть)|добав(?:ляем|ить)|перемеш(?:иваем|ать)|жар(?:им|ить)|смеш(?:иваем|ать)|разогре(?:ваем|ть)|выпека(?:ем|ть)|остав(?:ляем|ить))(?=\s|,)/iu.test(line))) {
      section = 'steps'; steps.push(line); continue;
    }
    if (/^(?:способ\s+)?приготовлени[ея](?:\s|:|$)/iu.test(line) && !/^приготовление\s*:\s*\S/iu.test(line)) {
      section = 'steps';
      continue;
    }
    const header = /^(ингредиенты|продукты|состав|ingredients|приготовление|способ приготовления|инструкция|шаги|instructions|directions)(?:\s*[:：]\s*(.*)|\s*)$/iu.exec(line);
    if (header) {
      section = /^(ингредиенты|продукты|состав|ingredients)$/iu.test(header[1]) ? 'ingredients' : 'steps';
      if (header[2]) {
        if (section === 'ingredients') ingredients.push(...header[2].split(';').map(parseIngredient));
        else steps.push(header[2]);
      }
      continue;
    }
    const portions = /^(?:количество\s+порций\s*[:–—-]?\s*|порции\s*[:–—-]?\s*|на\s+)(\d+)(?:\s+порци[ийюя])?$/iu.exec(line)
      || /^(\d+)\s+порци[ийя]$/iu.exec(line);
    if (portions && +portions[1] >= 1 && +portions[1] <= 999) {
      servings = +portions[1];
      continue;
    }
    const duration = /^(?:(?:общее\s+)?время(?:\s+приготовления)?\s*[:–—-]?\s*)?(?:(\d+)\s*(?:ч(?:ас(?:а|ов)?)?\.?)\s*)?(?:(\d+)\s*(?:мин(?:ут(?:а|ы)?)?\.?))?$/iu.exec(line);
    if (duration && (duration[1] || duration[2])) {
      minutes = (+duration[1] || 0) * 60 + (+duration[2] || 0);
      continue;
    }
    if (!section && /(?:активное|общее)\s+время|рецепт\s+рассчитан|можно\s+использовать|до\s+\d+\s+месяц/iu.test(line)) continue;
    if (!title && !section) {
      title = line.replace(/^название\s*:\s*/iu, '').replace(/[\p{Extended_Pictographic}\uFE0F]+/gu, '').trim().slice(0, 160);
      continue;
    }
    if (section === 'ingredients' && !/^(?:шаг\s*\d+|\d+[.)])\s*/iu.test(line)) {
      ingredients.push(parseIngredient(line));
    } else if (!section && (markedIngredient || /^(?:[-–—•●▪]\s|\S.*\s[-–—:]\s*\d)/u.test(line) || parseIngredient(line).unit)) {
      ingredients.push(parseIngredient(line));
    } else {
      section = 'steps';
      steps.push(line);
    }
  }
  return {title, minutes, servings, ingredients: ingredients.filter(item => item.name), instructions: [yieldNote, ...steps].filter(Boolean).join('\n')};
}

function preparePhotoRecipeText(text) {
  const lines = text.replace(/\u00a0/g, ' ').split(/\r?\n/).map(line => line.trim());
  const headingKey = line => line.toLocaleLowerCase('ru').replace(/[^а-яёa-z]/giu, '');
  const ingredientStart = lines.findIndex(line => /ингре[дл]иент|продукт|состав/u.test(headingKey(line)));
  const methodStart = lines.findIndex((line, index) => {
    const key = headingKey(line);
    return index > ingredientStart && !/время/u.test(key) &&
      /способприготовления|приготовление|риготовление|риготовления|какготовить|инструкция|шаги|instructions|directions/u.test(key);
  });
  if (ingredientStart < 0 || methodStart < 0) return text;

  const chatLine = /закрепл[её]нное сообщение|переслано от|\bforwarded from\b|^(?:написать\s+)?сообщение[^\p{L}\p{N}]*$|(?:^|(?:\d+(?:[.,]\d+)?\s*[кkmм]|\d{3,})\s+)\d{1,2}:\d{2}\s*[✓✔/|]*\s*$|^\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)$/iu;
  const recipeMetadata = /(?:рецепт\s+рассчитан|на\s+\d+\s+порци|порции\s*[:：]|количество\s+порций\s*[:：]|(?:активное|общее)\s+время(?:\s+приготовления)?\s*[:：])/iu;
  const preamble = lines.slice(0, ingredientStart).filter(Boolean);
  const titleLine = preamble.map(line => line.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N})]+$/u, ''))
    .find(line => /[а-яё]{4}/iu.test(line) && !chatLine.test(line) && !recipeMetadata.test(line) &&
      !/^(?:рецепты|избранное|recipes|количество|время)$/iu.test(line) && line.length <= 160);
  let title = titleLine;
  const titleIndex = preamble.findIndex(line => line.includes(titleLine));
  const nextTitleLine = titleIndex >= 0 && preamble[titleIndex + 1];
  // Длинное название часто переносится: «Творожная галета с курицей,» + «цукини и песто».
  if (title && nextTitleLine && (/[,–—-]$/u.test(preamble[titleIndex]) || /^[а-яё]/u.test(nextTitleLine)) &&
      /^[\p{L}\s,–—-]{3,60}$/u.test(nextTitleLine) && !chatLine.test(nextTitleLine)) {
    title = (title.replace(/[,\s]+$/u, '') + (/[,]$/u.test(preamble[titleIndex]) ? ', ' : ' ') + nextTitleLine).slice(0, 160);
  }

  const exactIngredient = new RegExp('^(.{2,100}?)\\s+(' + quantityPattern + ')\\s*(' + unitsPattern + ')(?=\\s|$)', 'iu');
  const descriptiveIngredient = new RegExp('^(.{2,100}?)\\s+(' + quantityPattern + ')\\s+((?:(?:небольш|средн|крупн)\\p{L}*\\s+)?(?:головк|луковиц|стебл|пуч|веточк|лист|почат|дольк)\\p{L}*)', 'iu');
  const ingredients = [];
  for (let line of lines.slice(ingredientStart + 1, methodStart)) {
    if (!line || chatLine.test(line)) continue;
    line = line.replace(/^[^\p{L}\p{N}+]+/u, '').trim();
    if (!line) continue;
    line = line.replace(/сел\s+ьдерей/iu, 'Сельдерей');
    if (/^[^\s]{0,4}\s+и?\s*перец\s+по\s+вкусу$/iu.test(line)) line = 'Соль и перец по вкусу';
    if (/^[м]?асло\s+для\s+жарки(?:\s|$)/iu.test(line)) line = 'Масло для жарки';
    const lower = line.toLocaleLowerCase('ru');
    const stop = lower.search(/(?:рецепт\s+рассчитан|можно\s+использовать|до\s+\d+\s+месяц|в\s+морозил|в\s+холодильник)/u);
    if (stop >= 0) line = line.slice(0, stop).trim();
    if (!line || /^(?:заготовки?|кбжу|ккал|белки|жиры|углеводы)(?:\s|$)/iu.test(line)) continue;
    const toTaste = /^(.{2,100}?\sпо\s+вкусу)(?:\s|$)/iu.exec(line);
    const measured = exactIngredient.exec(line) || descriptiveIngredient.exec(line);
    if (toTaste) line = toTaste[1];
    else if (measured) line = line.slice(0, measured[0].length);
    else if (/^\+?\s*[^.!?]{2,80}\sдля\s+(?:жарки|подачи|смазывания)(?:\s|$)/iu.test(line)) {
      line = line.replace(/\s+на\s+\d+\s+порци.*$/iu, '').trim();
    } else continue;
    if (line && !ingredients.includes(line)) ingredients.push(line);
  }

  const rawSteps = lines.slice(methodStart + 1);
  const steps = [];
  let current = '';
  let separated = false;
  for (const rawLine of rawSteps) {
    const line = rawLine.replace(/©/g, 'с').replace(/^[^\p{L}\p{N}]+(?=[\p{L}\p{N}])/u, '').trim();
    if (!line) {
      separated = true;
      continue;
    }
    if (chatLine.test(line) || /^(?:кбжу|бобовые|птица|рыба|супы|десерты|гарниры)$/iu.test(line)) break;
    // «1. Шаг», «1) Шаг», а также номер из кружка без точки: «4, Шаг», «6 — Шаг», «7: Шаг», «3 ° Шаг».
    // Цифру в кружке распознавание иногда принимает за похожую букву или знак: «з» — 3, «б» — 6, «$» — 3.
    const numbered = /^(\d{1,2})[.,)]\s*(.+)$/u.exec(line)
      || /^(\d{1,2}|[зЗб$§])\s*[^\p{L}\p{N}\s]{0,3}\s+([А-ЯЁ].+)$/u.exec(line);
    if (numbered) {
      if (current) steps.push(current);
      // Шаги нумеруются по порядку: цифру в кружке распознавание иногда путает («1» → «7»).
      current = (steps.length + 1) + '. ' + numbered[2].replace(/^[-–—]\s*/u, '');
      separated = false;
    } else if (current && !separated && /[а-яё]{3}/iu.test(line)) {
      current += ' ' + line;
    }
  }
  if (current) steps.push(current);
  if (!steps.length) {
    const prose = rawSteps.map(rawLine => rawLine.replace(/©/g, 'с')
      .replace(/^[^\p{L}\p{N}]+(?=\p{L})/u, '').trim())
      .filter(line => /[а-яё]{3}/iu.test(line) && !chatLine.test(line) &&
        !/^(?:кбжу|бобовые|птица|рыба|супы|десерты|гарниры)$/iu.test(line));
    if (prose.join(' ').length >= 20) steps.push(prose.join(' '));
  }
  for (let index = 0; index < steps.length; index++) steps[index] = steps[index].replace(/\s+[:;]\s*$/u, '').trim();
  const metadata = [];
  const timeLine = lines.find(line => /общее\s+время(?:\s+приготовления)?/iu.test(line));
  if (timeLine) metadata.push(timeLine);
  const portions = /(?:^|\s)на\s+(\d+)\s*(?:[-–—]\s*\d+\s*)?порци[ийюя]/iu.exec(text);
  if (portions) metadata.push('На ' + portions[1] + ' порций');
  return [title, ...metadata, 'Ингредиенты:', ...ingredients, 'Приготовление:', ...steps].filter(Boolean).join('\n');
}

function ocrQuality(text) {
  const letters = text.match(/[a-zа-яё]/giu) || [];
  if (!letters.length) return 0;
  const cyrillic = letters.filter(letter => /[а-яё]/iu.test(letter)).length;
  const useful = /ингредиент/iu.test(text) && /приготовлен/iu.test(text) ? 35 : 0;
  const noise = (text.match(/[©®$<>_=]{1,}/g) || []).length * 4 +
    (text.match(/^\s*(?:[|\[\]{}]|[ШЖЩ](?=\s|[А-ЯЁ]))/gmu) || []).length * 3;
  return Math.round(cyrillic / letters.length * 65 + useful - noise);
}

function grayLevels(image) {
  const gray = new Uint8ClampedArray(image.data.length / 4);
  for (let pixel = 0, index = 0; pixel < gray.length; pixel++, index += 4) {
    gray[pixel] = image.data[index] * .299 + image.data[index + 1] * .587 + image.data[index + 2] * .114;
  }
  return gray;
}

function grayHistogram(gray) {
  const histogram = new Uint32Array(256);
  for (const value of gray) histogram[value]++;
  return histogram;
}

function histogramPercentile(histogram, total, share) {
  let seen = 0;
  for (let value = 0; value < 256; value++) {
    seen += histogram[value];
    if (seen >= total * share) return value;
  }
  return 255;
}

function otsuThreshold(histogram, total) {
  let sum = 0;
  for (let value = 0; value < 256; value++) sum += value * histogram[value];
  let background = 0, backgroundSum = 0, best = 0, threshold = 127;
  for (let value = 0; value < 256; value++) {
    background += histogram[value];
    if (!background) continue;
    const foreground = total - background;
    if (!foreground) break;
    backgroundSum += value * histogram[value];
    const difference = backgroundSum / background - (sum - backgroundSum) / foreground;
    const variance = background * foreground * difference * difference;
    if (variance > best) { best = variance; threshold = value; }
  }
  return threshold;
}

// Цветные заливки на скриншотах сайтов (кружки с номерами шагов, кнопка «наверх», значки) превращаются
// в белый фон, а светлые цифры и буквы внутри них — в тёмные. Иначе зелёный кружок с «3» читается как «(5)»,
// «©» или «СЭ». Заливка отличается от цветного текста плотностью: в окне вокруг точки почти всё цветное.
function flattenColorBadges(image) {
  const {width: w, height: h, data} = image;
  const colored = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < colored.length; p++, i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    colored[p] = max - min > 35 && max > 70 ? 1 : 0;
  }
  const radius = Math.max(4, Math.round(w / 110));
  const stride = w + 1;
  const sums = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += colored[y * w + x];
      sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1] + row;
    }
  }
  const windowSum = (table, x, y) => {
    const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
    const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
    return [table[y1 * stride + x1] - table[y0 * stride + x1] - table[y1 * stride + x0] + table[y0 * stride + x0],
      (x1 - x0) * (y1 - y0)];
  };
  const blob = new Uint8Array(w * h);
  for (let p = 0; p < blob.length; p++) {
    const x = p % w, y = (p - x) / w;
    const [sum, area] = windowSum(sums, x, y);
    blob[p] = sum / area >= 0.6 ? 1 : 0;
  }
  const blobSums = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += blob[y * w + x];
      blobSums[(y + 1) * stride + x + 1] = blobSums[y * stride + x + 1] + row;
    }
  }
  let changed = 0;
  for (let p = 0, i = 0; p < colored.length; p++, i += 4) {
    const x = p % w, y = (p - x) / w;
    if (!blob[p]) {
      // Край заливки (сглаживание по контуру кружка) тоже убираем, иначе он читается как скобки.
      if (colored[p] && windowSum(blobSums, x, y)[0] > 0) { data[i] = data[i + 1] = data[i + 2] = 255; changed++; }
      continue;
    }
    const luma = data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
    let value;
    if (colored[p]) value = 255;
    else if (luma > 150) value = 0;
    else continue;
    data[i] = data[i + 1] = data[i + 2] = value;
    changed++;
  }
  return changed;
}

// Готовит фото к распознаванию: оттенки серого, светлый текст на тёмном фоне
// (тёмная тема мессенджеров) переворачивается в тёмный на светлом, контраст растягивается.
function normalizedOCRCanvas(source) {
  const canvas = element('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d', {alpha: false, willReadFrequently: true});
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  flattenColorBadges(image);
  const gray = grayLevels(image);
  let histogram = grayHistogram(gray);
  const dark = histogramPercentile(histogram, gray.length, .5) < 110;
  if (dark) {
    for (let pixel = 0; pixel < gray.length; pixel++) gray[pixel] = 255 - gray[pixel];
    histogram = grayHistogram(gray);
  }
  const low = histogramPercentile(histogram, gray.length, .01);
  const high = Math.max(low + 1, histogramPercentile(histogram, gray.length, .99));
  for (let pixel = 0, index = 0; pixel < gray.length; pixel++, index += 4) {
    const value = (gray[pixel] - low) * 255 / (high - low);
    image.data[index] = image.data[index + 1] = image.data[index + 2] = value;
  }
  ctx.putImageData(image, 0, 0);
  canvas.dark = dark;
  return canvas;
}

// Чёрно-белая версия для повторного распознавания. Порог считается по окрестности пикселя,
// а на тёмном фоне с узором дополнительно отсекается всё светлее общего порога Оцу,
// чтобы линии узора не превращались в буквы «Ш», «Ж» и «|» в начале строк.
function enhancedOCRCanvas(source) {
  const canvas = element('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d', {alpha: false, willReadFrequently: true});
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const gray = grayLevels(image);
  const gate = source.dark ? otsuThreshold(grayHistogram(gray), gray.length) : 255;
  const w = canvas.width, h = canvas.height, stride = w + 1;
  const sums = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      sums[(y+1)*stride+x+1] = sums[y*stride+x+1] + row;
    }
  }
  for (let pixel = 0, index = 0; pixel < gray.length; pixel++, index += 4) {
    const x = pixel % w, y = Math.floor(pixel / w);
    const x0 = Math.max(0,x-25), x1 = Math.min(w,x+26), y0 = Math.max(0,y-25), y1 = Math.min(h,y+26);
    const mean = (sums[y1*stride+x1]-sums[y0*stride+x1]-sums[y1*stride+x0]+sums[y0*stride+x0])/((x1-x0)*(y1-y0));
    const value = gray[pixel] < mean - 20 && gray[pixel] < gate ? 0 : 255;
    image.data[index] = image.data[index + 1] = image.data[index + 2] = value;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function cropOCRCanvas(source, left, top, width, height) {
  const sx = Math.max(0, Math.round(source.width * left));
  const sy = Math.max(0, Math.round(source.height * top));
  const sw = Math.max(1, Math.min(source.width - sx, Math.round(source.width * width)));
  const sh = Math.max(1, Math.min(source.height - sy, Math.round(source.height * height)));
  const scale = Math.max(1, Math.min(2, 1800 / sw));
  const canvas = element('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d', {alpha: false});
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// У «3» с плоским верхом (частый шрифт на сайтах) русская модель Tesseract видит «5».
// У настоящей «5» слева вверху есть вертикальная черта, у такой «3» там пусто — проверяем по изображению.
function looksLikeFlatTopThree(canvas, {x0, y0, x1, y1}) {
  const w = x1 - x0, h = y1 - y0;
  if (w < 6 || h < 10) return false;
  const pixels = canvas.getContext('2d', {willReadFrequently: true}).getImageData(x0, y0, w, h).data;
  const luma = index => pixels[index] * .299 + pixels[index + 1] * .587 + pixels[index + 2] * .114;
  let min = 255, max = 0;
  for (let index = 0; index < pixels.length; index += 4) { const v = luma(index); min = Math.min(min, v); max = Math.max(max, v); }
  if (max - min < 60) return false;
  const threshold = (min + max) / 2;
  const box = (left, right, top, bottom) => {
    let dark = 0, total = 0;
    for (let y = Math.floor(h * top); y < Math.ceil(h * bottom); y++) {
      for (let x = Math.floor(w * left); x < Math.ceil(w * right); x++) {
        total++;
        if (luma((y * w + x) * 4) < threshold) dark++;
      }
    }
    return total ? dark / total : 0;
  };
  // Левая четверть, полоса между верхней перекладиной и серединой: у «5» там вертикальная черта.
  return box(0, 0.25, 0.2, 0.4) < 0.08 && box(0, 1, 0, 0.15) > 0.2;
}

/** Распознаёт изображение и исправляет «5», которые на самом деле «3» с плоским верхом. */
async function recognizeText(worker, canvas, onData) {
  const {data} = await worker.recognize(canvas, {}, {text: true, blocks: true});
  onData?.(data);
  let text = data.text;
  let cursor = 0;
  for (const block of data.blocks || []) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) {
    let lineText = line.text;
    let wordCursor = 0;
    for (const word of line.words) {
      if (!word.symbols.some(symbol => symbol.text === '5')) continue;
      const fixed = word.symbols.map(symbol =>
        symbol.text === '5' && looksLikeFlatTopThree(canvas, symbol.bbox) ? '3' : symbol.text).join('');
      const at = lineText.indexOf(word.text, wordCursor);
      if (fixed === word.text || at < 0) continue;
      lineText = lineText.slice(0, at) + fixed + lineText.slice(at + word.text.length);
      wordCursor = at + fixed.length;
    }
    const at = text.indexOf(line.text, cursor);
    if (at < 0) continue;
    text = text.slice(0, at) + lineText + text.slice(at + line.text.length);
    cursor = at + lineText.length;
  }
  return text;
}

function photoRecipeLooksUsable(text) {
  const recipe = parseRecipe(preparePhotoRecipeText(text));
  return Boolean(recipe.title && recipe.title.length >= 3 && recipe.ingredients.length >= 2 &&
    recipe.instructions.length >= 20 && !/время\s+приготовления|ингредиенты|заготовки/iu.test(recipe.title));
}

function loadOCR() {
  if (window.Tesseract) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = element('script');
    script.src = './vendor/ocr/tesseract.min.js';
    script.onload = resolve;
    script.onerror = () => { script.remove(); reject(new Error('Не удалось загрузить модуль распознавания. Проверь подключение к интернету.')); };
    document.head.append(script);
  });
}

async function createOCR() {
  await loadOCR();
  const path = new URL('./vendor/ocr/', location.href).href;
  let reportFailure;
  const failure = new Promise((_, reject) => { reportFailure = reject; });
  const startup = window.Tesseract.createWorker('rus', 1, {
    workerPath: path + 'worker.min.js',
    corePath: path + 'tesseract-core-lstm.wasm.js',
    langPath: path,
    workerBlobURL: false,
    errorHandler: () => reportFailure(new Error('Сбой распознавания. Проверь интернет и попробуй снова.'))
  });
  const worker = await Promise.race([startup, failure]);
  await worker.setParameters({tessedit_pageseg_mode: '3', preserve_interword_spaces: '1', user_defined_dpi: '300'});
  return worker;
}

async function imageCanvas(file) {
  const img = element('img');
  const url = URL.createObjectURL(file);
  try {
    img.src = url;
    await img.decode();
    const scale = Math.min(2, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = element('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d', {alpha: false});
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch {
    throw new Error('Не удалось открыть фото. Попробуй выбрать JPEG, PNG или снимок экрана.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function readCollection(value) {
  if (value?.format !== 'recipekeeper-collection-v1' || !Array.isArray(value.recipes)
      || !value.recipes.length || value.recipes.length > 500) {
    throw new Error('Выбери файл сборника «Мои рецепты».');
  }
  const keys = new Set();
  return value.recipes.map(recipe => {
    const {importKey, title, category, minutes, servings, instructions, ingredients, photo} = recipe ?? {};
    const hasText = value => typeof value === 'string' && value.trim().length > 0;
    if (!hasText(importKey) || importKey.length > 160 || keys.has(importKey)
        || !hasText(title) || title.length > 160 || !hasText(instructions)
        || !Number.isInteger(servings) || servings < 1 || servings > 999
        || (minutes != null && (!Number.isInteger(minutes) || minutes < 1))
        || !Array.isArray(ingredients) || !ingredients.length || ingredients.some(item =>
          !hasText(item?.name) || typeof item.amount !== 'string' || typeof item.unit !== 'string')
        || (category != null && (typeof category !== 'string' ||
          !['breakfasts', 'soups', 'salads', 'mains', 'sides', 'baking', 'desserts', 'sauces', 'drinks', 'other'].includes(category)))
        || (photo != null && (typeof photo !== 'string' || !photo.startsWith('/9j/')))) {
      throw new Error('В сборнике есть повреждённая карточка.');
    }
    keys.add(importKey);
    const image = photo ? new Blob([Uint8Array.from(atob(photo), character => character.charCodeAt(0))],
      {type: 'image/jpeg'}) : null;
    return {importKey, title, category, minutes, servings, instructions,
      ingredients: ingredients.map(({name, amount, unit}) => ({name, amount, unit})), photo: image};
  });
}

/** Сохраняет уже разобранный сборник. Рецепты с тем же importKey повторно не добавляются. */
async function importCollectionData(value) {
  const recipes = readCollection(value);
  let added = 0;
  await transact('readwrite', store => {
    const request = store.getAll();
    request.onsuccess = () => {
      const existing = new Set(request.result.map(recipe => recipe.importKey));
      for (const recipe of recipes.slice().reverse()) {
        if (existing.has(recipe.importKey)) continue;
        store.add(recipe);
        added++;
      }
    };
    return request;
  });
  await listRecipes();
  const result = 'Сборник сохранён. Добавлено: ' + added + '. Уже в книге: ' + (recipes.length - added) + '.';
  message(result);
  return result;
}

const maxCollectionSize = 25 * 1024 * 1024;

const maxPhotos = 10;

// Убирает со скриншота переписки строку состояния, шапку чата («Имя» + «Бот»/«в сети»)
// и поле «Сообщение» внизу, чтобы при склейке нескольких скриншотов они не попадали в рецепт.
function stripChatChrome(text) {
  let lines = text.split(/\r?\n/);
  const words = line => (line.toLocaleLowerCase('ru').match(/[а-яёa-z]{2,}/gu) || []);
  const filled = lines.map((line, index) => [line, index]).filter(([line]) => line.trim());
  const header = filled.slice(0, 6).filter(([line]) => {
    const list = words(line);
    const main = list.filter(word => word.length > 2);
    return main.length && main.length <= 3 &&
      /^(?:бот|bot|онлайн|online|печатает|был|была|были|сети)$/u.test(main[0]);
  }).pop();
  if (header) lines = lines.slice(header[1] + 1);
  else if (filled.length && /^\W*\d{1,2}:\d{2}(?:\s|$)/u.test(filled[0][0])) lines = lines.slice(filled[0][1] + 1);
  const footer = lines.map((line, index) => [line, index]).filter(([line]) => line.trim()).slice(-4)
    .find(([line]) => {
      const list = words(line);
      return list.includes('сообщение') && list.filter(word => word.length > 2).length <= 2;
    });
  if (footer) lines = lines.slice(0, footer[1]);
  // Одиночные значки узора справа от текста: «растопленным      м».
  return lines.map(line => line.replace(/\s{4,}\S{1,2}\s*$/u, '')
    // «ьте» в некоторых шрифтах читается как «ыее» или «ысе»; в русском слова так не заканчиваются.
    .replace(/(\p{L}{2,})(?:ыее|ысе)(?=$|[^\p{L}])/gu, '$1ьте')
    // «добавые», «оставые», «достаные» — тоже «ьте»; настоящих слов с такими основами нет.
    .replace(/(^|[^\p{L}])((?:до|у|о|при|вы|от|на|за|под|раз)(?:став|бав|стан))ые(?=$|[^\p{L}])/giu, '$1$2ьте')).join('\n').trim();
}

const lettersOnly = line => line.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Убирает с распознанного скриншота сайта то, что не относится к рецепту:
 * адрес сайта, строки из одних значков, одиночные значки по краям строк (кнопка «наверх»)
 * и обрезанную нижнюю строку, от которой остаются заглавные обрывки вроде «К ЭСТ РН ПН МУН».
 */
function cleanScreenshotText(text) {
  const lines = text.split(/\r?\n/).map(line => line
    .replace(/^\s*[@|+©®°<>=_~*#•^›‹]+(?=\s)/u, '')
    .replace(/\s+(?=\S*[@|+©®°<>=_~*#•^›‹])[^\p{L}\p{N}\s]{1,3}\s*$/u, '')
    .replace(/\s+$/u, ''));
  const kept = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^\S{2,40}\.(?:ru|ги|com|соm|сот|net|org|рф|info)$/iu.test(trimmed)) return false; // адресная строка
    return /\p{L}{3}/u.test(trimmed) || /\d/.test(trimmed) && /\p{L}/u.test(trimmed);
  });
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  const last = kept.at(-1)?.trim() || '';
  const tokens = last.split(/\s+/);
  const words = tokens.filter(token => /^[«(]?[а-яё]{3,}/u.test(token)).length;
  if (tokens.length >= 3 && words / tokens.length < 0.34) kept.pop();
  return kept.join('\n').trim();
}

/**
 * Склеивает текст нескольких скриншотов. Если начало следующего скриншота повторяет конец предыдущего
 * (страницу прокрутили с перекрытием), повтор убирается.
 */
function mergeScreenshotTexts(pages) {
  const similar = (a, b) => {
    const x = lettersOnly(a), y = lettersOnly(b);
    if (x.length < 8 || y.length < 8) return false;
    if (x === y) return true;
    const longer = x.length >= y.length ? x : y, shorter = longer === x ? y : x;
    if (shorter.length / longer.length < 0.75) return false;
    let previous = Array.from({length: shorter.length + 1}, (_, index) => index);
    for (let i = 1; i <= longer.length; i++) {
      const current = [i];
      for (let j = 1; j <= shorter.length; j++) {
        current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (longer[i - 1] === shorter[j - 1] ? 0 : 1));
      }
      previous = current;
    }
    return previous[shorter.length] / longer.length <= 0.2;
  };
  let merged = [];
  for (const page of pages) {
    const next = page.split('\n');
    const filled = lines => lines.map((line, index) => [line, index]).filter(([line]) => line.trim());
    const tail = filled(merged).slice(-25);
    const head = filled(next).slice(0, 25);
    let cut = 0;
    search:
    for (const [tailIndex, [tailLine]] of tail.entries()) {
      for (const [headIndex, [headLine]] of head.entries()) {
        if (!similar(tailLine, headLine)) continue;
        // Совпадение должно продолжаться до самого конца предыдущего скриншота.
        const rest = tail.slice(tailIndex + 1);
        if (rest.every(([line], offset) => head[headIndex + 1 + offset] && similar(line, head[headIndex + 1 + offset][0]))) {
          cut = (head[headIndex + rest.length]?.[1] ?? head[headIndex][1]) + 1;
          break search;
        }
      }
    }
    merged = merged.concat(next.slice(cut));
  }
  return merged.join('\n').trim();
}

// Скриншоты приложений доставки наборов для готовки: экран «Мы привезем» с сеткой продуктов
// (круглое фото, под ним название и количество) и экраны шагов «Шаг 3/7» с фото сверху и кнопками внизу.
// Общий разбор страницы путает колонки сетки и не видит светло-серое «Шаг N/M», поэтому
// такие экраны распознаются отдельно: сетка — по колонкам, шаг — только белая панель с текстом.
const mealKitMarker = /мы\s*прив[её]з[её]м/iu;
const mealKitStepCue = /запустить\s*та[йи]мер|шаг\s*\d{1,2}\s*[\/|]\s*\d{1,2}/iu;
const mealKitQuantity = /^([\dЗзОоOo]{1,5}(?:[.,]\d+)?)\s*(шт|гр|г|кг|мл|л|уп|пачк\p{L}*|упаковк\p{L}*|бут\p{L}*)\.?$/iu;

function mealKitName(line) {
  return line.replace(/^[^\p{L}\p{N}(]+/u, '').replace(/\.{3}|…/gu, '…')
    // «(Набор консервов:) Ол…» → «Набор консервов: Ол…»; обрезанное «(Набор свежей зелени:…» — без скобки.
    .replace(/^\(([^()]{2,40})\)\s*/u, '$1 ').replace(/^\((?=[^)]*$)/u, '').trim();
}

function looksLikeMealKitName(line, share = 0.6) {
  // Уточнение в скобках («Мандарин (100-150 г)») не считаем: в нём почти одни цифры.
  const bare = line.replace(/\([^)]*\)/gu, '');
  const main = /\p{L}{3}/u.test(bare) ? bare : line;
  const letters = main.match(/\p{L}/gu) || [];
  return /\p{L}{3}/u.test(main) && letters.length >= main.replace(/\s/gu, '').length * share &&
    !mealKitMarker.test(line) && !/^(?:рецепт|назад)$/iu.test(line.replace(/[^\p{L}]/gu, ''));
}

/** Одна колонка сетки «Мы привезем»: строка с названием, под ней количество («1 шт», «1000 гр»). */
function parseMealKitColumn(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const items = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const quantity = mealKitQuantity.exec(lines[index + 1] || '');
    if (quantity && looksLikeMealKitName(line, 0.5)) {
      const amount = quantity[1].replace(/[Зз]/gu, '3').replace(/[ОоOo]/gu, '0');
      items.push({name: mealKitName(line), amount, unit: /^гр$/iu.test(quantity[2]) ? 'г' : quantity[2].toLowerCase()});
      index++;
    } else if (index === lines.length - 1 && looksLikeMealKitName(line) && line.length >= 6) {
      // Нижний ряд обрезан краем экрана: название видно, количество — нет.
      items.push({name: mealKitName(line), amount: '', unit: ''});
    }
  }
  return items;
}

/** Верхняя граница белой панели с текстом шага (под большим фото). Доля высоты, 0 — если не нашлась. */
function mealKitPanelTop(canvas) {
  const {width, height} = canvas;
  const pixels = canvas.getContext('2d', {willReadFrequently: true}).getImageData(0, 0, width, height).data;
  const run = Math.max(8, Math.round(height / 200));
  let start = -1;
  for (let y = Math.round(height * 0.2); y < height * 0.9; y++) {
    let light = 0, total = 0;
    for (let x = 0; x < width; x += 2, total++) {
      const index = (y * width + x) * 4;
      if (pixels[index] * .299 + pixels[index + 1] * .587 + pixels[index + 2] * .114 > 230) light++;
    }
    // Кнопка микрофона заходит на панель справа, поэтому хватает 80% светлых точек.
    if (light / total >= 0.8) {
      if (start < 0) start = y;
      if (y - start >= run) return Math.max(0, start - 4) / height;
    } else start = -1;
  }
  return 0;
}

function binarizeCanvas(canvas, threshold) {
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < image.data.length; index += 4) {
    const luma = image.data[index] * .299 + image.data[index + 1] * .587 + image.data[index + 2] * .114;
    image.data[index] = image.data[index + 1] = image.data[index + 2] = luma < threshold ? 0 : 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Если фото — экран приложения доставки наборов, распознаёт его по-особому.
 * Возвращает {mealKit: 'ingredients', title, items} или {mealKit: 'step', number, total, body}, иначе null.
 */
async function recognizeMealKitPage(worker, canvas, text, layout, batch, prefix) {
  if (mealKitMarker.test(text)) {
    message(prefix + 'распознаю список продуктов…');
    let top = 0.3;
    for (const block of layout?.blocks || []) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) {
      if (mealKitMarker.test(line.text)) top = (line.bbox.y1 + 6) / canvas.height;
    }
    const lines = text.split(/\r?\n/).map(line => line.trim());
    const tabs = lines.findIndex(line => mealKitMarker.test(line));
    const title = lines.slice(0, tabs).filter(line => /[а-яё]{3}/iu.test(line) && !/^\W*назад\W*$/iu.test(line))
      .join(' ').replace(/\s+/gu, ' ').trim().slice(0, 160);
    await worker.setParameters({tessedit_pageseg_mode: '6'});
    const columns = [];
    for (const left of [0, 0.5]) {
      const crop = cropOCRCanvas(canvas, left, top, 0.5, 1 - top);
      columns.push(parseMealKitColumn((await worker.recognize(crop)).data.text));
      crop.width = crop.height = 0;
    }
    // Порядок как на экране: слева направо, ряд за рядом.
    const items = [];
    for (let row = 0; row < Math.max(columns[0].length, columns[1].length); row++) {
      for (const column of columns) if (column[row]) items.push(column[row]);
    }
    return {mealKit: 'ingredients', title, items,
      text: [title, 'Мы привезем:', ...items.map(mealKitIngredientLine)].filter(Boolean).join('\n')};
  }
  if (!batch.mealKit && !mealKitStepCue.test(text)) return null;
  message(prefix + 'распознаю шаг рецепта…');
  const top = mealKitPanelTop(canvas);
  // «Шаг 3/7» набрано светло-серым: после жёсткого порога оно становится чёрным и читается.
  const crop = binarizeCanvas(cropOCRCanvas(canvas, 0, top, 1, 1 - top), 225);
  await worker.setParameters({tessedit_pageseg_mode: '6'});
  const panel = (await worker.recognize(crop)).data.text;
  crop.width = crop.height = 0;
  let number = null, total = null;
  const body = [];
  for (const raw of panel.split(/\r?\n/)) {
    const line = raw.trim();
    const step = /^\W{0,3}шаг\s*(\d{1,2})(?:\s*[\/|]\s*(\d{1,2}))?/iu.exec(line);
    if (step && number == null) {
      // Всё, что выше «Шаг N/M», — край фото.
      number = +step[1]; total = step[2] ? +step[2] : null; body.length = 0; continue;
    }
    if (/запустить\s*та[йи]мер|^\W*назад\W*$/iu.test(line) || !/\p{L}{3}/u.test(line)) continue;
    // Обрывки от края фото над текстом: короткие строки до начала самого шага.
    if (!body.length && line.replace(/[^\p{L}\p{N}]/gu, '').length < 10) continue;
    body.push(line.replace(/^[^\p{L}\p{N}«(]+/u, ''));
  }
  const joined = body.join(' ').replace(/\s+/gu, ' ').trim();
  if (joined.length < 20) return null;
  return {mealKit: 'step', number, total, body: joined, text: (number ? 'Шаг ' + number + '\n' : '') + joined};
}

function mealKitIngredientLine(item) {
  return item.amount ? item.name + ' — ' + item.amount + ' ' + item.unit : item.name;
}

/** Собирает рецепт из распознанных экранов: название, продукты без повторов, шаги по номерам. */
function mealKitRecipeText(pages) {
  const title = pages.find(page => page.mealKit === 'ingredients' && page.title)?.title || '';
  const ingredients = [];
  const seen = new Set();
  for (const page of pages) for (const item of page.mealKit === 'ingredients' ? page.items : []) {
    const key = lettersOnly(item.name);
    const same = ingredients.find(other => lettersOnly(other.name) === key);
    if (same) { if (!same.amount && item.amount) Object.assign(same, item); continue; }
    if (!seen.has(key)) { seen.add(key); ingredients.push({...item}); }
  }
  const steps = pages.filter(page => page.mealKit === 'step').map(page => ({...page}));
  // Номер не всегда читается: берём его от соседнего шага, а если номеров нет совсем — по порядку фото.
  for (let index = 1; index < steps.length; index++) {
    if (steps[index].number == null && steps[index - 1].number != null) steps[index].number = steps[index - 1].number + 1;
  }
  for (let index = steps.length - 2; index >= 0; index--) {
    if (steps[index].number == null && steps[index + 1].number != null) steps[index].number = Math.max(1, steps[index + 1].number - 1);
  }
  steps.forEach((step, index) => { if (step.number == null) step.number = index + 1; });
  const unique = [];
  for (const step of steps.sort((a, b) => a.number - b.number)) {
    const same = unique.find(other => other.number === step.number);
    if (!same) unique.push(step);
    else if (step.body.length > same.body.length) same.body = step.body;
  }
  if (!ingredients.length && !unique.length) return {text: '', missing: []};
  const total = Math.max(0, ...steps.map(step => step.total || 0));
  const missing = [];
  for (let number = 1; number <= total; number++) if (!unique.some(step => step.number === number)) missing.push(number);
  const text = [title, 'Ингредиенты:', ...ingredients.map(mealKitIngredientLine),
    'Приготовление:', ...unique.map(step => step.number + '. ' + step.body)].filter(Boolean).join('\n');
  return {text, missing};
}

// Распознаёт одно фото. Страницы многостраничного рецепта распознаются по очереди одним модулем OCR.
async function recognizePhoto(worker, file, prefix, keepTitle, batch = {}) {
  message(prefix + 'подготавливаю фото к распознаванию…');
  const original = await imageCanvas(file);
  const canvas = normalizedOCRCanvas(original);
  let enhanced;
  try {
    await worker.setParameters({tessedit_pageseg_mode: '3'});
    message(prefix + 'распознаю текст на фото…');
    let layout;
    let text = await recognizeText(worker, canvas, data => { layout = data; });
    const mealKit = await recognizeMealKitPage(worker, canvas, text, layout, batch, prefix);
    if (mealKit) {
      const photo = keepTitle ? await new Promise(resolve => original.toBlob(resolve, 'image/jpeg', 0.88)) : null;
      return {...mealKit, sourceText: text, photo};
    }
    let quality = ocrQuality(text);
    message(prefix + 'улучшаю изображение и распознаю повторно…');
    enhanced = enhancedOCRCanvas(canvas);
    await worker.setParameters({tessedit_pageseg_mode: '6'});
    const retry = await recognizeText(worker, enhanced);
    const retryQuality = ocrQuality(retry);
    if (retryQuality >= quality || photoRecipeLooksUsable(retry)) {
      const originalTitle = keepTitle && text.split(/\r?\n/).find(line => line.trim().length > 5);
      text = originalTitle ? originalTitle + '\n' + retry : retry;
      quality = retryQuality;
    }
    const sourceText = text;
    if (!photoRecipeLooksUsable(text)) {
      // Последняя попытка: исходное (не чёрно-белое) изображение в режиме «один блок текста».
      message(prefix + 'пробую другой способ разбора страницы…');
      const blockText = await recognizeText(worker, canvas);
      if (blockText && (photoRecipeLooksUsable(blockText) || ocrQuality(blockText) >= quality)) text = blockText;
    }
    const photo = keepTitle ? await new Promise(resolve => original.toBlob(resolve, 'image/jpeg', 0.88)) : null;
    return {text: cleanScreenshotText(stripChatChrome(text)), sourceText, photo};
  } finally {
    if (enhanced) enhanced.width = enhanced.height = 0;
    canvas.width = canvas.height = 0;
    original.width = original.height = 0;
  }
}

const importModes = {
  text: {button: 'open-text', input: 'import-text', title: 'Рецепт из текста',
    hint: 'Вставь один рецепт или сразу несколько. Рецепты разделяй строкой «---» или начинай каждый с названия и заголовка «Ингредиенты».',
    action: 'Создать черновик', missing: 'Вставь текст рецепта.'},
  photo: {button: 'open-photo', input: 'import-photo', title: 'Рецепт по фото',
    hint: 'Выбери чёткое фото или скриншот, на котором видны ингредиенты и шаги. Если рецепт на нескольких страницах, выбери все фото сразу — текст объединится по порядку выбора. Распознавание выполняется на устройстве.',
    action: 'Распознать фото', missing: 'Выбери одно или несколько фото.'},
  file: {button: 'open-import', input: 'import-file', title: 'Рецепт из файла',
    hint: 'Выбери один или несколько файлов: PDF, TXT, MD, HTML (сохранённая страница рецепта) или сборник JSON. Файлы можно просто перетащить в окно.',
    action: 'Импортировать', missing: 'Выбери файлы.'}
};
let activeImport;
let pendingPhoto;
let pendingPhotoPrep = false;

byId('ocr-create').onclick = async () => {
  const text = byId('ocr-review-text').value.trim();
  if (!text) { message('Добавь текст рецепта.'); return; }
  const recipe = parseRecipe(text);
  recipe.isPrep = pendingPhotoPrep || /заготовк[аи]/iu.test(text);
  editRecipe({...recipe, photo: pendingPhoto}, true, text);
  await markEditorDuplicate();
};

/** Открывает экран добавления в нужном режиме: text, photo или file. */
function openImportMode(key) {
  if (!database) return;
  const mode = importModes[key];
  byId('add-dialog').close();
  activeImport = key;
  importForm.reset();
  resetPDFReview();
  clearFileReport();
  byId('pdf-range').hidden = key !== 'file';
  pendingPhoto = null;
  pendingPhotoPrep = false;
  byId('ocr-review').hidden = true;
  for (const [otherKey, other] of Object.entries(importModes)) {
    byId(other.input + '-field').hidden = otherKey !== key;
    byId(other.input).disabled = otherKey !== key;
  }
  byId('import-title').textContent = mode.title;
  byId('import-hint').textContent = mode.hint;
  byId('import-submit').textContent = mode.action;
  show('importer');
}

for (const [key, mode] of Object.entries(importModes)) byId(mode.button).onclick = () => openImportMode(key);
byId('import-back').onclick = returnToList;

async function recognizePhotos(photos) {
  if (photos.length > maxPhotos) throw new Error('Можно выбрать до ' + maxPhotos + ' фото за раз.');
  const pages = [];
  const sources = [];
  const mealKitPages = [];
  const batch = {mealKit: false};
  let photo;
  let worker;
  try {
    message('Загружаю модуль распознавания…');
    worker = await createOCR();
    for (const [index, source] of photos.entries()) {
      const prefix = photos.length > 1 ? 'Фото ' + (index + 1) + ' из ' + photos.length + ': ' : '';
      const page = await recognizePhoto(worker, source, prefix, index === 0, batch);
      if (page.mealKit) batch.mealKit = true;
      mealKitPages.push(page);
      pages.push(page.text);
      sources.push(page.sourceText);
      if (index === 0) photo = page.photo;
    }
  } finally {
    if (worker) await worker.terminate();
  }
  const mealKit = batch.mealKit ? mealKitRecipeText(mealKitPages) : {text: '', missing: []};
  const mealKitText = mealKit.text;
  const text = mealKitText || mergeScreenshotTexts(pages.map(page => page.trim()).filter(Boolean));
  if (!text.trim()) throw new Error('Текст не распознан. Попробуй более чёткое фото или вставь текст вручную.');
  pendingPhoto = photo;
  pendingPhotoPrep = /заготовк[аи]/iu.test(sources.join('\n') + '\n' + text);
  byId('ocr-raw').textContent = photos.length > 1
    ? pages.map((page, index) => '— Фото ' + (index + 1) + ' (' + photos[index].name + ') —\n' + page.trim()).join('\n\n')
    : text;
  byId('ocr-review-text').value = mealKitText || preparePhotoRecipeText(text);
  byId('ocr-review').hidden = false;
  message((photos.length > 1 ? 'Текст с ' + photos.length + ' фото объединён. ' : 'Текст распознан. ')
    + 'Проверь его перед созданием рецепта: особенно количества и конец инструкции.'
    + (mealKit.missing.length ? ' Нет скриншотов шагов: ' + mealKit.missing.join(', ') + '.' : ''));
}

async function importPastedText(text) {
  const drafts = textDrafts(text, '');
  if (drafts.length > 1) {
    await showDrafts(drafts, text, 'Вставленный текст');
    message('В тексте несколько рецептов. Проверь черновики и выбери, что сохранить.');
    return;
  }
  const draft = drafts[0]?.text || text;
  const recipe = parseRecipe(draft);
  if (!recipe.instructions && !recipe.ingredients.length) recipe.instructions = draft.trim();
  editRecipe(recipe, true, draft.trim());
  await markEditorDuplicate();
}

importForm.onsubmit = async event => {
  event.preventDefault();
  const mode = importModes[activeImport];
  if (!mode) return;
  const input = byId(mode.input);
  const submit = byId('import-submit');
  if (submit.disabled) return;
  clearFileReport();
  const text = activeImport === 'text' ? input.value.trim() : '';
  const files = activeImport === 'text' ? [] : [...input.files];
  if (!text && !files.length) {
    message(mode.missing);
    return;
  }
  const controls = [input, submit, byId('import-back')];
  for (const control of controls) control.disabled = true;
  try {
    if (activeImport === 'photo') await recognizePhotos(files);
    else if (activeImport === 'file') {
      resetPDFReview();
      await importFiles(files);
    } else await importPastedText(text);
  } catch (error) {
    message(error?.name === 'PasswordException' ? 'Этот PDF защищён паролем. Выбери копию без пароля.' :
      'Импорт не завершён. ' + (error?.message || 'Попробуй другой файл или вставь текст.'));
  } finally {
    for (const control of controls) control.disabled = false;
  }
};
