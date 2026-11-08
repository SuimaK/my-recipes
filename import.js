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
      /способприготовления|приготовление|риготовление|риготовления|инструкция|шаги|instructions|directions/u.test(key);
  });
  if (ingredientStart < 0 || methodStart < 0) return text;

  const chatLine = /закрепл[её]нное сообщение|переслано от|\bforwarded from\b|^(?:написать\s+)?сообщение\s*$|(?:^|(?:\d+(?:[.,]\d+)?\s*[кkmм]|\d{3,})\s+)\d{1,2}:\d{2}\s*[✓✔/|]*\s*$|^\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)$/iu;
  const recipeMetadata = /(?:рецепт\s+рассчитан|на\s+\d+\s+порци|порции\s*[:：]|количество\s+порций\s*[:：]|(?:активное|общее)\s+время(?:\s+приготовления)?\s*[:：])/iu;
  const preamble = lines.slice(0, ingredientStart).filter(Boolean);
  const title = preamble.map(line => line.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N})]+$/u, ''))
    .find(line => /[а-яё]{4}/iu.test(line) && !chatLine.test(line) && !recipeMetadata.test(line) &&
      !/^(?:рецепты|избранное|recipes|количество|время)$/iu.test(line) && line.length <= 160);

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
    const line = rawLine.replace(/©/g, 'с').replace(/^[^\p{L}\p{N}]+(?=\p{L})/u, '').trim();
    if (!line) {
      separated = true;
      continue;
    }
    if (chatLine.test(line) || /^(?:кбжу|бобовые|птица|рыба|супы|десерты|гарниры)$/iu.test(line)) break;
    const numbered = /^(\d+)[.,)]\s*(.+)$/u.exec(line);
    if (numbered) {
      if (current) steps.push(current);
      current = numbered[1] + '. ' + numbered[2].replace(/^[-–—]\s*/u, '');
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
  const noise = (text.match(/[©®$<>_=]{1,}/g) || []).length * 4;
  return Math.round(cyrillic / letters.length * 65 + useful - noise);
}

function enhancedOCRCanvas(source) {
  const canvas = element('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d', {alpha: false, willReadFrequently: true});
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const w = canvas.width, h = canvas.height, stride = w + 1;
  const sums = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      row += image.data[i] * .299 + image.data[i+1] * .587 + image.data[i+2] * .114;
      sums[(y+1)*stride+x+1] = sums[y*stride+x+1] + row;
    }
  }
  for (let index = 0; index < image.data.length; index += 4) {
    const gray = image.data[index] * 0.299 + image.data[index + 1] * 0.587 + image.data[index + 2] * 0.114;
    const pixel = index / 4, x = pixel % w, y = Math.floor(pixel / w);
    const x0 = Math.max(0,x-25), x1 = Math.min(w,x+26), y0 = Math.max(0,y-25), y1 = Math.min(h,y+26);
    const mean = (sums[y1*stride+x1]-sums[y0*stride+x1]-sums[y1*stride+x0]+sums[y0*stride+x0])/((x1-x0)*(y1-y0));
    const value = gray < mean - 20 ? 0 : 255;
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

function photoRecipeLooksUsable(text) {
  const recipe = parseRecipe(preparePhotoRecipeText(text));
  return Boolean(recipe.title && recipe.title.length >= 3 && recipe.ingredients.length >= 2 &&
    recipe.instructions.length >= 20 && !/время\s+приготовления|ингредиенты|заготовки/iu.test(recipe.title));
}

async function recognizeRecipeRegions(worker, source, fullText) {
  if (source.height < source.width * 1.08) return '';
  const regions = [
    ['верхнюю часть', 0.02, 0.01, 0.96, 0.31],
    ['ингредиенты', 0.02, 0.27, 0.50, 0.36],
    ['данные о порциях', 0.48, 0.27, 0.50, 0.36],
    ['приготовление', 0.01, 0.62, 0.98, 0.29]
  ];
  const parts = [];
  await worker.setParameters({tessedit_pageseg_mode: '6', preserve_interword_spaces: '1'});
  try {
    for (const [name, left, top, width, height] of regions) {
      message('Уточняю ' + name + '…');
      const crop = cropOCRCanvas(source, left, top, width, height);
      try {
        const result = (await worker.recognize(crop)).data.text.trim();
        parts.push(result);
      } finally {
        crop.width = crop.height = 0;
      }
    }
  } finally {
    await worker.setParameters({tessedit_pageseg_mode: '3', preserve_interword_spaces: '1'});
  }
  const metadata = [];
  const metadataText = fullText + '\n' + (parts[2] || '');
  const lines = metadataText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const portions = /(?:рецепт\s+рассчитан[^\n]{0,50}?|(?:^|\s)на\s+)(\d+)\s*(?:[-–—]\s*\d+\s*)?порци[ийюя]/iu.exec(metadataText);
  const time = lines.find(line => /общее\s+время(?:\s+приготовления)?/iu.test(line));
  if (time) metadata.push(time);
  if (portions) metadata.push('На ' + portions[1] + ' порций');
  return [parts[0], ...metadata, parts[1], parts[3]].filter(Boolean).join('\n');
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

async function readPDF(file) {
  const lib = await import('./vendor/pdf/pdf.min.mjs');
  const path = new URL('./vendor/pdf/', location.href).href;
  lib.GlobalWorkerOptions.workerSrc = path + 'pdf.worker.min.mjs';
  const task = lib.getDocument({
    data: await file.arrayBuffer(),
    cMapUrl: path + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: path + 'standard_fonts/',
    wasmUrl: path + 'wasm/',
    isEvalSupported: false
  });
  let worker;
  try {
    const pdf = await task.promise;
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      message('Читаю страницу ' + number + ' из ' + pdf.numPages + '…');
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      let text = '';
      let previous;
      for (const item of content.items) {
        if (!item.str) {
          if (item.hasEOL) text += '\n';
          continue;
        }
        const y = item.transform[5];
        if (previous !== undefined && !text.endsWith('\n')) text += Math.abs(y - previous) > 2 ? '\n' : ' ';
        text += item.str + (item.hasEOL ? '\n' : '');
        previous = y;
      }
      if (text.trim().length < 35) {
        worker ??= await createOCR();
        const original = page.getViewport({scale: 1});
        const viewport = page.getViewport({scale: Math.min(3, 2400 / Math.max(original.width, original.height))});
        const canvas = element('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({canvasContext: canvas.getContext('2d'), viewport}).promise;
        const {data} = await worker.recognize(canvas);
        if (data.text.trim().length > text.trim().length) text = data.text;
        canvas.width = canvas.height = 0;
      }
      pages.push(text);
      page.cleanup();
    }
    return pages.join('\n');
  } finally {
    await task.destroy();
    if (worker) await worker.terminate();
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

async function importCollection(file) {
  if (file.size > 25 * 1024 * 1024) throw new Error('Максимальный размер сборника — 25 МБ.');
  const recipes = readCollection(JSON.parse(await file.text()));
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
  message('Сборник сохранён. Добавлено: ' + added + '. Уже в книге: ' + (recipes.length - added) + '.');
}

const importModes = {
  text: {button: 'open-text', input: 'import-text', title: 'Рецепт из текста',
    hint: 'Вставь рецепт целиком. Если есть заголовки «Ингредиенты» и «Приготовление», оставь их в тексте.',
    action: 'Создать черновик', missing: 'Вставь текст рецепта.'},
  photo: {button: 'open-photo', input: 'import-photo', title: 'Рецепт по фото',
    hint: 'Выбери чёткое фото или скриншот, на котором видны ингредиенты и шаги. Распознавание выполняется на устройстве.',
    action: 'Распознать фото', missing: 'Выбери фото или снимок экрана.'},
  file: {button: 'open-import', input: 'import-file', title: 'Рецепт из файла',
    hint: 'Выбери PDF, текстовый файл или готовый сборник рецептов.',
    action: 'Импортировать', missing: 'Выбери файл.'}
};
let activeImport;
let pendingPhoto;
let pendingPhotoPrep = false;
byId('ocr-create').onclick = () => {
  const text = byId('ocr-review-text').value.trim();
  if (!text) { message('Добавь текст рецепта.'); return; }
  const recipe = parseRecipe(text);
  recipe.isPrep = pendingPhotoPrep || /заготовк[аи]/iu.test(text);
  editRecipe({...recipe, photo: pendingPhoto}, true, text);
};

for (const [key, mode] of Object.entries(importModes)) {
  byId(mode.button).onclick = () => {
    if (!database) return;
    byId('add-dialog').close();
    activeImport = key;
    importForm.reset();
    resetPDFReview();
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
  };
}
byId('import-back').onclick = returnToList;
importForm.onsubmit = async event => {
  event.preventDefault();
  const mode = importModes[activeImport];
  if (!mode) return;
  const input = byId(mode.input);
  const submit = byId('import-submit');
  if (submit.disabled) return;
  const file = input.files?.[0];
  let text = activeImport === 'text' ? input.value.trim() : '';
  let photoSourceText = '';
  let photo;
  if (!text && !file) {
    message(mode.missing);
    return;
  }
  const controls = [input, submit, byId('import-back')];
  for (const control of controls) control.disabled = true;
  try {
    if (activeImport === 'photo') {
      message('Подготавливаю фото к распознаванию…');
      const canvas = await imageCanvas(file);
      let worker;
      let enhanced;
      try {
        message('Загружаю модуль распознавания…');
        worker = await createOCR();
        message('Распознаю текст на фото…');
        text = (await worker.recognize(canvas)).data.text;
        let quality = ocrQuality(text);
        {
          message('Улучшаю изображение и распознаю повторно…');
          enhanced = enhancedOCRCanvas(canvas);
          await worker.setParameters({tessedit_pageseg_mode: '6'});
          const retry = (await worker.recognize(enhanced)).data.text;
          const retryQuality = ocrQuality(retry);
          if (retryQuality >= quality || photoRecipeLooksUsable(retry)) {
            const originalTitle = text.split(/\r?\n/).find(line => line.trim().length > 5);
            text = originalTitle ? originalTitle + '\n' + retry : retry;
            quality = retryQuality;
          }
        }
        photoSourceText = text;
        if (!photoRecipeLooksUsable(text)) {
          message('Разделяю страницу на название, ингредиенты и приготовление…');
          await worker.setParameters({tessedit_pageseg_mode: '6'});
          const regionalText = (await worker.recognize(canvas)).data.text;
          if (regionalText && (photoRecipeLooksUsable(regionalText) || ocrQuality(regionalText) >= quality)) {
            text = regionalText;
            quality = ocrQuality(regionalText);
          }
        }
        photo = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.88));
      } finally {
        if (enhanced) enhanced.width = enhanced.height = 0;
        canvas.width = canvas.height = 0;
        if (worker) await worker.terminate();
      }
    } else if (file) {
      message('Читаю файл на устройстве…');
      if (file.type === 'application/json' || /\.json$/i.test(file.name)) {
        await importCollection(file);
        return;
      }
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) { await convertPDF(file); return; }
      else if (file.type === 'text/plain' || /\.txt$/i.test(file.name)) text = await file.text();
      else throw new Error('Поддерживаются PDF, TXT и сборники JSON.');
    }
    if (!text.trim()) throw new Error('Текст не распознан. Попробуй более чёткое фото или вставь текст вручную.');
    if (activeImport === 'photo') {
      pendingPhoto = photo;
      pendingPhotoPrep = /заготовк[аи]/iu.test(photoSourceText + '\n' + text);
      byId('ocr-raw').textContent = text;
      byId('ocr-review-text').value = preparePhotoRecipeText(text);
      byId('ocr-review').hidden = false;
      message('Текст распознан. Проверь его перед созданием рецепта: особенно количества и конец инструкции.');
      return;
    }
    const recipe = parseRecipe(text);
    if (activeImport === 'photo') recipe.isPrep = /можно\s+использовать\s+как\s+заготовк|заготовк[аи]/iu.test(photoSourceText + '\n' + text);
    if (activeImport === 'photo' && !photoRecipeLooksUsable(text)) {
      throw new Error('Не удалось уверенно разделить название, ингредиенты и приготовление. Сфотографируй страницу ровнее и ближе.');
    }
    if (!recipe.instructions && !recipe.ingredients.length) recipe.instructions = text.trim();
    editRecipe({...recipe, photo}, true, text.trim());
  } catch (error) {
    message(error?.name === 'PasswordException' ? 'Этот PDF защищён паролем. Выбери копию без пароля.' :
      'Импорт не завершён. ' + (error?.message || 'Попробуй другой файл или вставь текст.'));
  } finally {
    for (const control of controls) control.disabled = false;
  }
};
