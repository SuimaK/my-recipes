// Чтение файлов разных форматов → рецепты. Работает в браузере.
import { parseRecipesFromText, parseRecipesFromJson, parseRecipesFromHtml } from './parser.js';

export const MAX_FILE_MB = 25;
export const ACCEPT = '.txt,.md,.text,.json,.html,.htm,.pdf,image/*';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

function ext(name) {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export function detectKind(file) {
  const e = ext(file.name);
  if (file.type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'heic', 'gif', 'bmp'].includes(e)) return 'image';
  if (e === 'pdf' || file.type === 'application/pdf') return 'pdf';
  if (e === 'json' || file.type === 'application/json') return 'json';
  if (e === 'html' || e === 'htm' || file.type === 'text/html') return 'html';
  if (['txt', 'md', 'text', 'markdown'].includes(e) || file.type.startsWith('text/')) return 'text';
  return 'unknown';
}

/** Текст в UTF-8, с откатом на Windows-1251 (частый случай для старых .txt). */
export async function readTextSmart(file) {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const broken = (utf8.match(/�/g) || []).length;
  if (broken > 3 || (broken && broken / utf8.length > 0.001)) {
    try { return new TextDecoder('windows-1251').decode(buf); } catch { /* нет декодера */ }
  }
  return utf8.replace(/^﻿/, '');
}

let pdfjsPromise;
function loadPdfJs() {
  pdfjsPromise ??= import('../vendor/pdfjs/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    return m;
  });
  return pdfjsPromise;
}

export async function extractPdfText(file, onProgress) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    onProgress?.(`Страница ${p} из ${doc.numPages}`, p / doc.numPages);
    const content = await (await doc.getPage(p)).getTextContent();
    let page = '';
    let lastY = null;
    for (const item of content.items) {
      const y = item.transform ? Math.round(item.transform[5]) : lastY;
      if (lastY !== null && y !== lastY && !page.endsWith('\n')) page += '\n';
      page += item.str;
      if (item.hasEOL) page += '\n';
      lastY = y;
    }
    pages.push(page);
  }
  return pages.join('\n\n');
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Не удалось загрузить модуль распознавания. Проверьте интернет.'));
    document.head.append(s);
  });
}

/** Распознавание текста на фото. window.__ocr позволяет подменить движок в тестах. */
export async function recognizeImage(file, onProgress) {
  if (typeof window !== 'undefined' && window.__ocr) return window.__ocr(file);
  if (!window.Tesseract) {
    onProgress?.('Загружаю модуль распознавания…', 0);
    await loadScript(TESSERACT_URL);
  }
  const { data } = await window.Tesseract.recognize(file, 'rus+eng', {
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress?.(`Распознаю текст… ${Math.round(m.progress * 100)}%`, m.progress);
      else if (m.status) onProgress?.('Готовлю распознавание…', 0);
    },
  });
  return data.text;
}

export async function imageToDataUrl(file, maxSide = 1200) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, maxSide / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Читает один файл. Возвращает { recipes, menu, text, kind } или бросает Error
 * с понятным пользователю сообщением.
 */
export async function importFile(file, onProgress) {
  if (file.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`Файл больше ${MAX_FILE_MB} МБ`);
  if (file.size === 0) throw new Error('Файл пустой');
  const kind = detectKind(file);
  let text = '';
  let recipes = [];
  let menu = null;
  switch (kind) {
    case 'text':
      text = await readTextSmart(file);
      recipes = parseRecipesFromText(text);
      break;
    case 'json': {
      const res = parseRecipesFromJson(await readTextSmart(file));
      recipes = res.recipes;
      menu = res.menu;
      break;
    }
    case 'html':
      recipes = parseRecipesFromHtml(await readTextSmart(file));
      break;
    case 'pdf':
      text = await extractPdfText(file, onProgress);
      if (!text.trim()) throw new Error('В PDF нет текстового слоя (скан). Сохраните страницы как фото и загрузите через «По фото».');
      recipes = parseRecipesFromText(text);
      break;
    case 'image': {
      text = await recognizeImage(file, onProgress);
      recipes = parseRecipesFromText(text);
      if (recipes.length === 1) {
        try { recipes[0].photo = await imageToDataUrl(file); } catch { /* не страшно */ }
      }
      break;
    }
    default:
      throw new Error('Неподдерживаемый формат. Подойдут TXT, MD, PDF, JSON, HTML или фото.');
  }
  if (!recipes.length) {
    const err = new Error('Не удалось найти рецепт в файле');
    err.text = text;
    throw err;
  }
  return { recipes, menu, text, kind };
}
