// Сквозные тесты загрузки рецептов в настоящем браузере (Playwright + Chromium).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const fx = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const fxBuf = (n, mimeType = 'text/plain') => ({ name: basename(n), mimeType, buffer: readFileSync(fx(n)) });

let server, browser, base;
const errors = [];

before(async () => {
  server = await serve(0);
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function freshPage(viewport = { width: 1100, height: 800 }) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base);
  return page;
}
const titles = (page) => page.$$eval('.card-title', (els) => els.map((e) => e.textContent.trim()));

async function openFileStep(page) {
  await page.click('#add-btn');
  await page.click('[data-method=file]');
}

test('пустое состояние и диалог способов', async () => {
  const page = await freshPage();
  assert.ok(await page.isVisible('#empty'));
  await page.click('#add-btn');
  assert.equal(await page.locator('.method').count(), 4);
  await page.close();
});

test('сборник TXT: 3 рецепта → проверка → сохранение → отмена', async () => {
  const page = await freshPage();
  await openFileStep(page);
  const chooser = page.waitForEvent('filechooser');
  await page.click('#dropzone');
  await (await chooser).setFiles(fx('collection.txt'));
  await page.waitForSelector('.rcard');
  assert.equal(await page.locator('.rcard').count(), 3);
  assert.match(await page.textContent('#import-title'), /3 рецепта/);
  await page.click('[data-save]');
  assert.deepEqual(await titles(page), ['Блины на молоке', 'Сырники', 'Борщ']);
  assert.match(await page.textContent('#toast'), /Добавлено: 3 рецепта/);
  await page.click('#toast button');
  assert.deepEqual(await titles(page), []);
  await page.close();
});

test('повторы определяются и по умолчанию пропускаются; «Заменить» обновляет', async () => {
  const page = await freshPage();
  for (let round = 0; round < 2; round++) {
    await openFileStep(page);
    const chooser = page.waitForEvent('filechooser');
    await page.click('#dropzone');
    await (await chooser).setFiles(fx('collection.txt'));
    await page.waitForSelector('.rcard');
    if (round === 1) {
      assert.equal(await page.locator('.dup').count(), 3);
      assert.ok(await page.isDisabled('[data-save]'));
      await page.selectOption('[data-dup="0"]', 'replace');
    }
    await page.click('[data-save]');
  }
  assert.equal((await titles(page)).length, 3);
  assert.match(await page.textContent('#toast'), /обновлено: 1/);
  await page.close();
});

test('несколько файлов разом: cp1251 TXT, HTML со schema.org, JSON-копия, PDF', async () => {
  // PDF с текстовым слоем делаем тем же Chromium.
  const maker = await browser.newPage();
  await maker.setContent('<pre style="font:16px sans-serif">Окрошка\nИнгредиенты:\nкефир 1 л\nогурцы 2 шт\nредис 5 шт\nПриготовление:\n1. Нарезать овощи.\n2. Залить кефиром.</pre>');
  const pdf = await maker.pdf();
  await maker.close();
  const backup = JSON.stringify({ app: 'my-recipes', version: 2, recipes: [{ title: 'Гречка с грибами', ingredients: ['гречка 200 г', 'грибы 300 г'], steps: ['Отварить гречку', 'Обжарить грибы'], category: 'Ужин' }] });

  const page = await freshPage();
  await openFileStep(page);
  const chooser = page.waitForEvent('filechooser');
  await page.click('#dropzone');
  await (await chooser).setFiles([
    fxBuf('cp1251.txt'), fxBuf('page.html', 'text/html'),
    { name: 'kopiya.json', mimeType: 'application/json', buffer: Buffer.from(backup) },
    { name: 'okroshka.pdf', mimeType: 'application/pdf', buffer: pdf },
  ]);
  await page.waitForSelector('.rcard', { timeout: 20000 });
  const names = await page.$$eval('.rcard-title b', (els) => els.map((e) => e.textContent));
  assert.deepEqual(names, ['Пельмени', 'Шарлотка', 'Гречка с грибами', 'Окрошка']);
  await page.click('[data-save]');
  // Открываем PDF-рецепт и проверяем содержимое.
  await page.click('.card:has-text("Окрошка")');
  assert.equal(await page.locator('#view-body .ing-list li').count(), 3);
  assert.equal(await page.locator('#view-body .steps li').count(), 2);
  await page.click('#view-dlg [data-close]');
  // Категория из HTML и JSON появилась в фильтрах.
  assert.ok(await page.isVisible('.chip[data-cat="Выпечка"]'));
  await page.close();
});

test('ошибочный файл показывает причину, остальные загружаются', async () => {
  const page = await freshPage();
  await openFileStep(page);
  const chooser = page.waitForEvent('filechooser');
  await page.click('#dropzone');
  await (await chooser).setFiles([
    { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{oops') },
    { name: 'list.txt', mimeType: 'text/plain', buffer: Buffer.from('просто строка') },
    { name: 'arch.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') },
    fxBuf('single-noheaders.txt'),
  ]);
  await page.waitForSelector('.file-row.ok');
  await page.waitForFunction(() => !document.querySelector('.file-row.busy'));
  const st = await page.$$eval('.file-row .st', (els) => els.map((e) => e.textContent));
  assert.match(st[0], /повреждён/);
  assert.match(st[1], /Не удалось найти рецепт/);
  assert.match(st[2], /Неподдерживаемый формат/);
  assert.match(st[3], /1 рецепт/);
  // Для текста без рецепта можно перейти к правке.
  await page.click('[data-fix="1"]');
  assert.equal(await page.inputValue('#paste'), 'просто строка');
  await page.close();
});

test('из текста: подсказка с количеством, правка в проверке, валидация', async () => {
  const page = await freshPage();
  await page.click('#add-btn');
  await page.click('[data-method=text]');
  await page.fill('#paste', 'Чай\nИнгредиенты\nчай 1 ч. л.\nПриготовление\nЗаварить.\n---\nКофе\nИнгредиенты\nкофе 2 ч. л.\nПриготовление\nСварить.');
  await page.waitForFunction(() => /2 рецепта/.test(document.querySelector('#paste-hint').textContent));
  await page.click('[data-parse]');
  await page.click('[data-toggle="1"] >> nth=0');
  await page.fill('[data-editor="1"] [data-f=title]', '');
  await page.click('[data-save]');
  assert.match(await page.textContent('.error-box'), /название/);
  await page.fill('[data-editor="1"] [data-f=title]', 'Кофе по-турецки');
  await page.click('[data-save]');
  assert.deepEqual((await titles(page)).sort(), ['Кофе по-турецки', 'Чай']);
  await page.close();
});

test('по фото: распознанный текст превращается в рецепт с фото', async () => {
  const page = await freshPage();
  await page.evaluate(() => { window.__ocr = async () => 'Салат Цезарь\nИнгредиенты:\nкурица 300 г\nсалат 1 пучок\nПриготовление:\nСмешать.'; });
  await page.click('#add-btn');
  await page.click('[data-method=photo]');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const chooser = page.waitForEvent('filechooser');
  await page.click('#dropzone');
  await (await chooser).setFiles({ name: 'scan.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('.rcard');
  await page.click('[data-save]');
  assert.deepEqual(await titles(page), ['Салат Цезарь']);
  assert.match(await page.getAttribute('.card-photo', 'style'), /data:image\/jpeg/);
  await page.close();
});

test('перетаскивание файла в окно открывает загрузку', async () => {
  const page = await freshPage();
  const dt = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(['Морс\nИнгредиенты\nклюква 300 г\nПриготовление\nОтжать и смешать с водой.'], 'mors.txt', { type: 'text/plain' })); return d; });
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
  await page.waitForSelector('.rcard');
  await page.click('[data-save]');
  assert.deepEqual(await titles(page), ['Морс']);
  await page.close();
});

test('вручную, поиск по ингредиентам, меню и список покупок, сохранение после перезагрузки', async () => {
  const page = await freshPage({ width: 390, height: 844 });
  await page.click('#add-btn');
  await page.click('[data-method=manual]');
  await page.fill('[data-f=title]', 'Гренки');
  await page.fill('[data-f=ingredients]', 'хлеб 4 ломтика\nяйцо 1 шт');
  await page.fill('[data-f=steps]', 'Обмакнуть хлеб в яйцо\nОбжарить');
  await page.click('[data-save]');
  await page.fill('#q-ing', 'яйц, хлеб');
  assert.deepEqual(await titles(page), ['Гренки']);
  await page.fill('#q-ing', 'молоко');
  assert.deepEqual(await titles(page), []);
  await page.fill('#q-ing', '');
  await page.click('.card');
  await page.click('[data-act=menu]');
  await page.click('#view-dlg [data-close]');
  await page.click('#tab-menu');
  assert.equal(await page.locator('#shopping li').count(), 2);
  await page.reload();
  assert.deepEqual(await titles(page), ['Гренки']);
  assert.equal(await page.textContent('#menu-badge'), '1');
  // Нет горизонтальной прокрутки на телефоне.
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.close();
});

test('в консоли нет ошибок', () => {
  assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), []);
});
