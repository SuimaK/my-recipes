// Сквозные тесты загрузки рецептов в Chromium (Playwright).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const fixture = (name, mimeType = 'text/plain') => ({ name, mimeType, buffer: readFileSync(new URL(`./fixtures/${name}`, import.meta.url)) });
const errors = [];
let server, browser, base;

before(async () => {
  server = await serve(0);
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function freshPage() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/sw\.js|icon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(base);
  await page.waitForFunction(() => !document.getElementById('add-trigger').disabled && document.getElementById('recipes').children.length);
  return page;
}
const titles = page => page.$$eval('#recipes .tile strong', els => els.map(e => e.textContent));
const draftTitles = page => page.$$eval('#pdf-drafts summary', els => els.map(e => e.textContent));

async function openMode(page, button) {
  await page.click('#add-trigger');
  await page.click(button);
}
async function uploadFiles(page, files) {
  await openMode(page, '#open-import');
  await page.setInputFiles('#import-file', files);
  await page.click('#import-submit');
}

test('текст со сборником из 3 рецептов → 3 черновика → сохранение', async () => {
  const page = await freshPage();
  await openMode(page, '#open-text');
  await page.fill('#import-text', readFileSync(new URL('./fixtures/collection.txt', import.meta.url), 'utf8'));
  await page.waitForFunction(() => /Найдено рецептов: 3/.test(document.getElementById('import-hint').textContent));
  await page.click('#import-submit');
  await page.waitForSelector('#pdf-review:not([hidden])');
  const names = await draftTitles(page);
  assert.equal(names.length, 3);
  assert.match(names[2], /Борщ/);
  const borsch = await page.locator('#pdf-drafts textarea').nth(2).inputValue();
  assert.match(borsch, /Ингредиенты:\nсвёкла\nкапуста/);
  await page.click('#pdf-save');
  await page.waitForSelector('#collection:not([hidden])');
  assert.deepEqual((await titles(page)).sort(), ['Блины на молоке', 'Борщ', 'Сырники']);
  // Порции и ингредиенты структурированы.
  await page.click('.tile-open:has-text("Блины")');
  assert.equal(await page.inputValue('#portion-count'), '4');
  assert.equal(await page.locator('#card ul li').count(), 5);
  await page.context().close();
});

test('один рецепт из текста по-прежнему открывает редактор', async () => {
  const page = await freshPage();
  await openMode(page, '#open-text');
  await page.fill('#import-text', readFileSync(new URL('./fixtures/single-noheaders.txt', import.meta.url), 'utf8'));
  await page.click('#import-submit');
  await page.waitForSelector('#editor:not([hidden])');
  assert.equal(await page.inputValue('[name=title]'), 'Омлет');
  await page.context().close();
});

test('несколько файлов: TXT в Windows-1251, HTML со schema.org, PDF, сборник TXT', async () => {
  const maker = await browser.newPage();
  await maker.setContent('<pre style="font:16px sans-serif">Окрошка\nНа 4 порции\nИнгредиенты:\nкефир — 1 л\nогурцы — 2 шт.\nредис — 5 шт.\nПриготовление:\nНарезать овощи и залить кефиром.</pre>');
  const pdf = await maker.pdf();
  await maker.close();
  const page = await freshPage();
  await uploadFiles(page, [fixture('cp1251.txt'), fixture('page.html', 'text/html'),
    { name: 'okroshka.pdf', mimeType: 'application/pdf', buffer: pdf }, fixture('collection.txt')]);
  await page.waitForSelector('#pdf-review:not([hidden])', { timeout: 30000 });
  const names = await draftTitles(page);
  assert.equal(names.length, 6, names.join(' | '));
  assert.ok(names.some(n => /cp1251\.txt · Пельмени/.test(n)));
  assert.ok(names.some(n => /page\.html · Шарлотка/.test(n)));
  assert.ok(names.some(n => /okroshka\.pdf, стр\. 1 · Окрошка/.test(n)));
  assert.ok(names.some(n => /collection\.txt #3 · Борщ/.test(n)));
  const report = await page.$$eval('.file-report-row small', els => els.map(e => e.textContent));
  assert.deepEqual(report, ['Рецептов: 1', 'Рецептов: 1', 'Рецептов: 1', 'Рецептов: 3']);
  await page.click('#pdf-save');
  await page.waitForSelector('#collection:not([hidden])');
  assert.equal((await titles(page)).length, 6);
  await page.click('.tile-open:has-text("Шарлотка")');
  assert.match(await page.textContent('#card'), /Время приготовления · 50 мин/);
  await page.context().close();
});

test('повторная загрузка: повторы найдены и не отмечены', async () => {
  const page = await freshPage();
  for (let round = 0; round < 2; round++) {
    await uploadFiles(page, [fixture('collection.txt')]);
    await page.waitForSelector('#pdf-review:not([hidden])');
    if (round === 1) {
      assert.match(await page.textContent('#pdf-result'), /Уже есть в книге: 3/);
      assert.equal(await page.locator('#pdf-drafts input[type=checkbox]:checked').count(), 0);
      assert.equal(await page.locator('.duplicate-note').count(), 3);
      await page.locator('#pdf-drafts summary').first().click();
      await page.locator('#pdf-drafts input[type=checkbox]').first().check();
    }
    await page.click('#pdf-save');
    await page.waitForSelector('#collection:not([hidden])');
  }
  // Отмеченный повтор совпадает по содержимому и пропускается сборником.
  assert.equal((await titles(page)).length, 3);
  await page.context().close();
});

test('ошибки по каждому файлу, остальные загружаются', async () => {
  const page = await freshPage();
  await uploadFiles(page, [
    { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{oops') },
    { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('просто строка') },
    { name: 'arch.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') },
    fixture('single-noheaders.txt'),
  ]);
  await page.waitForSelector('#pdf-review:not([hidden])');
  const report = await page.$$eval('.file-report-row small', els => els.map(e => e.textContent));
  assert.match(report[0], /JSON повреждён/);
  assert.match(report[1], /рецепт не найден/);
  assert.match(report[2], /формат не поддерживается/);
  assert.match(report[3], /Рецептов: 1/);
  await page.context().close();
});

test('резервная копия, выбранная в «Из файла», открывает восстановление; повторы не дублируются', async () => {
  const page = await freshPage();
  const backup = { format: 'recipekeeper-backup-v1', createdAt: new Date().toISOString(),
    recipes: [{ id: 1, title: 'Суп', category: 'soups', servings: 2, instructions: 'Варить.', ingredients: [{ name: 'вода', amount: '1', unit: 'л' }], comments: [] }],
    menus: [{ id: 1, name: 'Неделя', entries: [{ recipeId: 1, servings: 2 }] }] };
  const file = { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) };
  for (let round = 0; round < 2; round++) {
    await uploadFiles(page, [file]);
    await page.waitForSelector('#backups:not([hidden])');
    await page.waitForFunction(() => !document.getElementById('restore-backup').disabled);
    await page.click('#restore-backup');
    await page.waitForSelector('#collection:not([hidden])');
  }
  assert.match(await page.textContent('#status'), /Добавлено рецептов: 0, уже были в книге: 1/);
  assert.deepEqual(await titles(page), ['Суп']);
  await page.context().close();
});

test('перетаскивание файла в окно запускает загрузку', async () => {
  const page = await freshPage();
  const dt = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(['Морс\nИнгредиенты:\nклюква 300 г\nПриготовление:\nОтжать сок и смешать с водой.'], 'mors.txt', { type: 'text/plain' })); return d; });
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
  await page.waitForSelector('#pdf-review:not([hidden])');
  assert.match((await draftTitles(page))[0], /Морс/);
  await page.context().close();
});

test('ручное добавление и поиск продолжают работать', async () => {
  const page = await freshPage();
  await openMode(page, '#add');
  await page.fill('[name=title]', 'Гренки');
  await page.fill('#ingredients [data-key=name]', 'Хлеб');
  await page.fill('[name=instructions]', 'Обжарить.');
  await page.click('#form [type=submit]');
  await page.waitForSelector('#detail:not([hidden])');
  await page.click('#back');
  await page.fill('#ingredient-search', 'хлеб');
  assert.deepEqual(await titles(page), ['Гренки']);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.context().close();
});


test('по фото: настоящее распознавание на устройстве (Tesseract из vendor/ocr)', { timeout: 240000 }, async () => {
  const maker = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  await maker.setContent('<div style="font:32px/1.5 Georgia,serif;padding:40px;background:#fff;color:#000"><b style="font-size:44px">Гречневая каша</b><br>На 2 порции<br><b>Ингредиенты</b><br>гречка 200 г<br>вода 400 мл<br>соль 1 ч. л.<br>масло сливочное 20 г<br><b>Приготовление</b><br>1. Промыть гречку и залить водой.<br>2. Варить под крышкой 20 минут.<br>3. Добавить масло и перемешать.</div>');
  const image = await maker.screenshot({ type: 'png' });
  await maker.close();
  const page = await freshPage();
  await openMode(page, '#open-photo');
  await page.setInputFiles('#import-photo', { name: 'kasha.png', mimeType: 'image/png', buffer: image });
  await page.click('#import-submit');
  await page.waitForSelector('#ocr-review:not([hidden])', { timeout: 200000 });
  const text = await page.inputValue('#ocr-review-text');
  assert.match(text, /Гречневая каша/);
  assert.match(text, /гречка 200 г/);
  await page.click('#ocr-create');
  await page.waitForSelector('#editor:not([hidden])');
  assert.equal(await page.inputValue('[name=title]'), 'Гречневая каша');
  assert.equal(await page.inputValue('[name=servings]'), '2');
  await page.context().close();
});

test('по фото: несколько страниц одного рецепта распознаются вместе', { timeout: 400000 }, async () => {
  const shot = async html => {
    const maker = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await maker.setContent(`<div style="font:32px/1.5 Georgia,serif;padding:40px;background:#fff;color:#000">${html}</div>`);
    const image = await maker.screenshot({ type: 'png' });
    await maker.close();
    return image;
  };
  const first = await shot('<b style="font-size:44px">Овсяное печенье</b><br>На 4 порции<br><b>Ингредиенты</b><br>овсяные хлопья 200 г<br>сахар 100 г<br>яйцо 2 шт');
  const second = await shot('<b>Приготовление</b><br>1. Смешать хлопья, сахар и яйца.<br>2. Выложить на противень ложкой.<br>3. Выпекать 20 минут при 180 градусах.');
  const page = await freshPage();
  await openMode(page, '#open-photo');
  assert.equal(await page.$eval('#import-photo', el => el.multiple), true);
  await page.setInputFiles('#import-photo', [
    { name: 'page1.png', mimeType: 'image/png', buffer: first },
    { name: 'page2.png', mimeType: 'image/png', buffer: second }
  ]);
  assert.match(await page.textContent('#import-hint'), /Выбрано фото: 2/);
  await page.click('#import-submit');
  await page.waitForSelector('#ocr-review:not([hidden])', { timeout: 380000 });
  const raw = await page.textContent('#ocr-raw');
  assert.match(raw, /Фото 1 \(page1\.png\)/);
  assert.match(raw, /Фото 2 \(page2\.png\)/);
  const text = await page.inputValue('#ocr-review-text');
  assert.match(text, /Овсяное печенье/);
  assert.match(text, /сахар 100 г/);
  assert.match(text, /Выпекать 20 минут/);
  await page.click('#ocr-create');
  await page.waitForSelector('#editor:not([hidden])');
  assert.equal(await page.inputValue('[name=title]'), 'Овсяное печенье');
  assert.match(await page.inputValue('[name=instructions]'), /Смешать хлопья/);
  await page.context().close();
});

test('по фото: скриншоты чата в тёмной теме с узорным фоном', { timeout: 400000 }, async () => {
  const pattern = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><g fill="none" stroke="#4a3a32" stroke-width="3"><path d="M10 60 C30 10 60 110 90 40 S120 90 110 110"/><circle cx="30" cy="30" r="12"/><path d="M60 5 q10 20 0 40 q-10 20 0 40"/></g></svg>');
  const shot = async body => {
    const maker = await browser.newPage({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3 });
    await maker.setContent(`<body style="margin:0;background:#2a211d url('data:image/svg+xml,${pattern}');font:17px/1.45 Helvetica,Arial,sans-serif;color:#f2f2f2;height:874px;overflow:hidden">
      <div style="background:#1e1e1e;padding:12px 24px;font-weight:600">10:34 <span style="float:right">99</span></div>
      <div style="background:#1e1e1e;padding:6px 16px 10px;display:flex;gap:12px;align-items:center"><span style="font-size:26px">‹</span><div style="width:40px;height:40px;border-radius:50%;background:#c96"></div><div><b>Анна Иванова</b><br><span style="color:#aaa;font-size:14px">Бот</span></div></div>
      <div style="margin:12px 70px 0 6px;background:#2c2c2e;padding:12px 10px;border-radius:12px">${body}</div>
      <div style="position:absolute;bottom:0;left:0;right:0;background:#1e1e1e;padding:14px 20px;color:#999">Сообщение</div></body>`);
    const image = await maker.screenshot({ type: 'png' });
    await maker.close();
    return image;
  };
  const first = await shot('<b>Творожная галета с курицей,<br>цукини и песто</b><br><br><b>Ингредиенты на 1 большую галету:</b><br><br>Для теста:<br>Мука пшеничная 250 г<br>Мягкий творог 0% 150 г<br>Шпинат 50 г<br><br>Для начинки:<br>Куриное филе 180 г<br>Цукини 150 г<br>Сулугуни 40 г<br>Прованские травы 3 г<br><br><b>Как готовить:</b><br><br>1. Шпинат бланшировать 30 секунд,<br>остудить и измельчить с яйцом.');
  const second = await shot('Соединить с творогом и мукой.<br>Замесить тесто.<br>2. Курицу нарезать кубиками,<br>цукини тонкими кружками.<br>3. Выпекать 35 минут при 190 градусах.');
  const page = await freshPage();
  await openMode(page, '#open-photo');
  await page.setInputFiles('#import-photo', [
    { name: 'chat1.png', mimeType: 'image/png', buffer: first },
    { name: 'chat2.png', mimeType: 'image/png', buffer: second }
  ]);
  await page.click('#import-submit');
  await page.waitForSelector('#ocr-review:not([hidden])', { timeout: 380000 });
  const text = await page.inputValue('#ocr-review-text');
  assert.match(text, /^Творожная галета с курицей, цукини и песто\n/);
  for (const line of ['Мука пшеничная 250 г', 'Цукини 150 г', 'Сулугуни 40 г', 'Прованские травы 3 г']) {
    assert.ok(text.split('\n').includes(line), line + '\n' + text);
  }
  assert.doesNotMatch(text, /Анна Иванова|Бот|Сообщение|^\s*(?:[|[]|[ШЖ](?=\s|[А-ЯЁ]))/mu);
  assert.match(text, /Замесить тесто/);
  assert.match(text, /Выпекать 35 минут/);
  await page.click('#ocr-create');
  await page.waitForSelector('#editor:not([hidden])');
  assert.equal(await page.inputValue('[name=title]'), 'Творожная галета с курицей, цукини и песто');
  await page.context().close();
});

test('в консоли нет ошибок', () => assert.deepEqual(errors, []));
