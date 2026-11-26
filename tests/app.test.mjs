// Сквозные тесты офлайн-режима, резервных копий, меню и фото (Playwright, Chromium).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
let server, browser, base;

before(async () => {
  server = await serve(0);
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function freshPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => !document.getElementById('add-trigger').disabled);
  return page;
}
/** Ждёт, пока асинхронное условие в странице станет истинным (waitForFunction не ждёт промисы). */
async function waitUntil(page, condition, arg, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.evaluate(condition, arg)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Условие не выполнилось: ' + condition);
}
const titles = page => page.$$eval('#recipes .tile:not([hidden]) strong', els => els.map(e => e.textContent));

async function waitForServiceWorker(page) {
  await waitUntil(page, async () => (await navigator.serviceWorker.ready).active?.state === 'activated');
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
}

/** PNG указанного размера, нарисованный в браузере. */
async function pngFile(page, width, height) {
  const base64 = await page.evaluate(([w, h]) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#c84'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#284'; ctx.fillRect(w / 4, h / 4, w / 2, h / 2);
    return canvas.toDataURL('image/png').split(',')[1];
  }, [width, height]);
  return { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}

test('приложение открывается и работает без интернета', async () => {
  const page = await freshPage();
  await waitForServiceWorker(page);
  await page.context().setOffline(true);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('add-trigger').disabled, null, { timeout: 5000 });
  await page.click('#add-trigger');
  await page.click('#add');
  await page.fill('[name=title]', 'Чай');
  await page.fill('#ingredients [data-key=name]', 'Заварка');
  await page.fill('[name=instructions]', 'Залить кипятком.');
  await page.click('#form [type=submit]');
  await page.waitForSelector('#detail:not([hidden])');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('обновление версии не удаляет кэш библиотек vendor', async () => {
  const page = await freshPage();
  await waitForServiceWorker(page);
  await page.evaluate(() => fetch('./vendor/ocr/tesseract.min.js').then(r => r.blob()));
  const before = await page.evaluate(() => caches.keys());
  const source = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const version = Number(/const VERSION = (\d+);/.exec(source)[1]);
  server.overrides.set('/sw.js', source.replace(/const VERSION = \d+;/, `const VERSION = ${version + 1};`));
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
  });
  await waitUntil(page, v => caches.keys().then(keys => keys.some(key => key.endsWith('-v' + v))), version + 1);
  await waitUntil(page, v => caches.keys().then(keys => !keys.some(key => key.endsWith('-v' + v))), version);
  const afterUpdate = await page.evaluate(() => caches.keys());
  server.overrides.clear();
  const vendor = before.find(key => key.includes('-vendor-'));
  assert.ok(vendor, 'кэш vendor создан: ' + before.join(', '));
  assert.ok(afterUpdate.includes(vendor), 'кэш vendor сохранился: ' + afterUpdate.join(', '));
  assert.ok(await page.evaluate(name => caches.open(name).then(c => c.match('./vendor/ocr/tesseract.min.js')).then(Boolean), vendor));
  await page.context().close();
});

test('восстановление копии дважды: без повторов меню, importKey сохраняется', async () => {
  const page = await freshPage();
  const collection = { format: 'recipekeeper-collection-v1', recipes: [{ importKey: 'set-1', title: 'Борщ', servings: 4,
    instructions: 'Варить.', ingredients: [{ name: 'Свёкла', amount: '1', unit: 'шт.' }] }] };
  const collectionFile = { name: 'set.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(collection)) };
  const upload = async file => {
    await page.click('#add-trigger');
    await page.click('#open-import');
    await page.setInputFiles('#import-file', [file]);
    await page.click('#import-submit');
    await page.waitForFunction(() => document.querySelector('.file-report-row.ok, .file-report-row.error'));
  };
  await upload(collectionFile);
  await page.evaluate(async () => {
    const [recipe] = await transact('readonly', s => s.getAll());
    await transact('readwrite', s => s.add({ name: 'Неделя', entries: [{ recipeId: recipe.id, servings: 4 }] }), 'menus');
  });
  // Копия из текущей базы.
  await page.click('#import-back');
  await page.waitForSelector('#collection:not([hidden])');
  await page.click('#open-backups');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-backup')]);
  const backup = readFileSync(await download.path());
  // Очищаем базу и восстанавливаем копию два раза.
  await page.evaluate(async () => {
    await transact('readwrite', s => s.clear());
    await transact('readwrite', s => s.clear(), 'menus');
  });
  for (let round = 0; round < 2; round++) {
    await page.click('#open-backups');
    await page.setInputFiles('#restore-file', { name: 'backup.json', mimeType: 'application/json', buffer: backup });
    await page.waitForFunction(() => !document.getElementById('restore-backup').disabled);
    await page.click('#restore-backup');
    await page.waitForSelector('#collection:not([hidden])');
  }
  assert.match(await page.textContent('#status'), /Меню уже были в книге: 1/);
  const state = await page.evaluate(async () => ({
    recipes: await transact('readonly', s => s.getAll()),
    menus: await transact('readonly', s => s.getAll(), 'menus')
  }));
  assert.equal(state.recipes.length, 1);
  assert.equal(state.menus.length, 1);
  assert.equal(state.recipes[0].importKey, 'set-1');
  assert.equal(state.menus[0].entries[0].recipeId, state.recipes[0].id);
  // Тот же сборник после восстановления не добавляет рецепт повторно.
  await upload(collectionFile);
  assert.match(await page.textContent('.file-report-row small'), /Добавлено: 0/);
  assert.equal(await page.evaluate(() => transact('readonly', s => s.count())), 1);
  await page.context().close();
});

test('копия: повторы внутри самой копии добавляются один раз', async () => {
  const page = await freshPage();
  const recipe = { title: 'Суп', servings: 2, instructions: 'Варить.', ingredients: [{ name: 'вода', amount: '1', unit: 'л' }] };
  const backup = { format: 'recipekeeper-backup-v1', recipes: [{ id: 1, ...recipe }, { id: 2, ...recipe }],
    menus: [{ id: 1, name: 'Обед', entries: [{ recipeId: 2, servings: 2 }] }] };
  await page.click('#open-backups');
  await page.setInputFiles('#restore-file', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await page.waitForFunction(() => !document.getElementById('restore-backup').disabled);
  await page.click('#restore-backup');
  await page.waitForSelector('#collection:not([hidden])');
  const state = await page.evaluate(async () => ({
    recipes: await transact('readonly', s => s.getAll()),
    menus: await transact('readonly', s => s.getAll(), 'menus')
  }));
  assert.equal(state.recipes.length, 1);
  assert.equal(state.menus[0].entries[0].recipeId, state.recipes[0].id);
  await page.context().close();
});

test('меню: отметка «куплено» сохраняется при изменении порций', async () => {
  const page = await freshPage();
  await page.evaluate(async () => {
    const id = await transact('readwrite', s => s.add({ title: 'Блины', servings: 2, instructions: 'Жарить.',
      ingredients: [{ name: 'Мука', amount: '200', unit: 'г' }, { name: 'Молоко', amount: '0,5', unit: 'л' }] }));
    await transact('readwrite', s => s.add({ name: 'Неделя', entries: [{ recipeId: id, servings: 2 }] }), 'menus');
  });
  await page.click('#open-menus');
  await page.locator('#shopping-list label', { hasText: 'Мука' }).locator('input').check();
  await page.waitForFunction(() => /Куплено 1 из 2/.test(document.getElementById('shopping-progress').textContent));
  await page.fill('.menu-dish input', '4');
  await page.dispatchEvent('.menu-dish input', 'change');
  await page.waitForFunction(() => /Мука — 400 г/.test(document.getElementById('shopping-list').textContent));
  assert.ok(await page.locator('#shopping-list label', { hasText: 'Мука' }).locator('input').isChecked());
  assert.match(await page.textContent('#shopping-progress'), /Куплено 1 из 2/);
  const purchased = await page.evaluate(async () => (await transact('readonly', s => s.getAll(), 'menus'))[0].purchased);
  assert.equal(purchased.length, 1);
  await page.context().close();
});

test('перетаскивание текста в поле ввода не перехватывается', async () => {
  const page = await freshPage();
  await page.click('#add-trigger');
  await page.click('#open-text');
  const prevented = await page.evaluate(() => {
    const target = document.getElementById('import-text');
    const data = new DataTransfer();
    data.setData('text/plain', 'Омлет');
    const over = new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true });
    const drop = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true });
    target.dispatchEvent(over);
    target.dispatchEvent(drop);
    return [over.defaultPrevented, drop.defaultPrevented, !document.querySelector('.drop-overlay').hidden];
  });
  assert.deepEqual(prevented, [false, false, false]);
  await page.context().close();
});

test('фото: уменьшается до 1600 px, для плитки готовится миниатюра', async () => {
  const page = await freshPage();
  await page.click('#add-trigger');
  await page.click('#add');
  await page.fill('[name=title]', 'Пирог');
  await page.fill('#ingredients [data-key=name]', 'Мука');
  await page.fill('[name=instructions]', 'Испечь.');
  await page.setInputFiles('[name=photo]', await pngFile(page, 3200, 2400));
  await page.click('#form [type=submit]');
  await page.waitForSelector('#detail:not([hidden])');
  const sizes = await page.evaluate(async () => {
    const [recipe] = await transact('readonly', s => s.getAll());
    const side = async blob => { const b = await createImageBitmap(blob); return Math.max(b.width, b.height); };
    return { photo: await side(recipe.photo), thumb: await side(recipe.thumb), type: recipe.photo.type };
  });
  assert.deepEqual(sizes, { photo: 1600, thumb: 480, type: 'image/jpeg' });
  await page.click('#back');
  assert.equal(await page.getAttribute('#recipes .tile img', 'loading'), 'lazy');
  await page.context().close();
});

test('фото: миниатюры для старых рецептов создаются в фоне', async () => {
  const page = await freshPage();
  const photo = await pngFile(page, 1200, 900);
  await page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    await transact('readwrite', s => s.add({ title: 'Старый', servings: 2, instructions: 'Готовить.', ingredients: [],
      photo: new Blob([bytes], { type: 'image/png' }) }));
    await listRecipes();
  }, photo.buffer.toString('base64'));
  await waitUntil(page, async () => Boolean((await transact('readonly', s => s.getAll()))[0].thumb));
  await page.context().close();
});

test('поиск скрывает плитки, а не создаёт их заново', async () => {
  const page = await freshPage();
  await page.evaluate(async () => {
    for (const title of ['Борщ', 'Блины', 'Салат']) {
      await transact('readwrite', s => s.add({ title, servings: 2, instructions: 'Готовить.', ingredients: [{ name: 'соль', amount: '', unit: '' }] }));
    }
    await listRecipes();
    window.firstTile = document.querySelector('#recipes .tile');
  });
  await page.fill('#title-search', 'бл');
  assert.deepEqual(await titles(page), ['Блины']);
  await page.fill('#title-search', 'нет такого');
  assert.deepEqual(await titles(page), []);
  assert.ok(await page.isVisible('#recipes-empty'));
  await page.fill('#title-search', '');
  assert.equal((await titles(page)).length, 3);
  assert.ok(await page.evaluate(() => document.body.contains(window.firstTile)));
  await page.context().close();
});

test('копия не содержит миниатюр и снова восстанавливается', async () => {
  const page = await freshPage();
  await page.click('#add-trigger');
  await page.click('#add');
  await page.fill('[name=title]', 'Кекс');
  await page.fill('#ingredients [data-key=name]', 'Мука');
  await page.fill('[name=instructions]', 'Испечь.');
  await page.setInputFiles('[name=photo]', await pngFile(page, 800, 600));
  await page.click('#form [type=submit]');
  await page.waitForSelector('#detail:not([hidden])');
  await page.click('#back');
  await page.click('#open-backups');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-backup')]);
  const data = JSON.parse(readFileSync(await download.path(), 'utf8'));
  assert.equal(data.format, 'recipekeeper-backup-v1');
  assert.equal(data.recipes.length, 1);
  assert.ok(!('thumb' in data.recipes[0]));
  assert.match(data.recipes[0].photo, /^data:image\/jpeg;base64,/);
  await page.context().close();
});

test('по фото: «3» с плоским верхом не читается как «5»', async () => {
  const page = await freshPage();
  const result = await page.evaluate(() => {
    const draw = paint => {
      const canvas = document.createElement('canvas');
      canvas.width = 60; canvas.height = 80;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 60, 80);
      ctx.strokeStyle = ctx.fillStyle = '#333'; ctx.lineWidth = 6;
      paint(ctx);
      return looksLikeFlatTopThree(canvas, { x0: 5, y0: 5, x1: 55, y1: 75 });
    };
    // «3» с плоским верхом: перекладина, диагональ к середине, нижняя чаша.
    const flatThree = draw(ctx => {
      ctx.beginPath(); ctx.moveTo(10, 9); ctx.lineTo(48, 9); ctx.lineTo(26, 34); ctx.stroke();
      ctx.beginPath(); ctx.arc(30, 52, 18, -Math.PI / 2, Math.PI * 0.85); ctx.stroke();
    });
    // «5»: перекладина, вертикальная черта слева, нижняя чаша.
    const five = draw(ctx => {
      ctx.beginPath(); ctx.moveTo(48, 9); ctx.lineTo(13, 9); ctx.lineTo(10, 36); ctx.stroke();
      ctx.beginPath(); ctx.arc(30, 52, 18, -Math.PI * 0.75, Math.PI * 0.85); ctx.stroke();
    });
    const fontFive = draw(ctx => { ctx.font = '70px sans-serif'; ctx.textBaseline = 'top'; ctx.fillText('5', 10, 4); });
    return { flatThree, five, fontFive };
  });
  assert.deepEqual(result, { flatThree: true, five: false, fontFive: false });
  await page.context().close();
});

test('по фото: два скриншота сайта с номерами шагов в зелёных кружках', { timeout: 300000 }, async () => {
  const maker = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  const circle = n => `<span style="display:inline-grid;place-items:center;flex:none;width:30px;height:30px;border-radius:50%;background:#4aa55a;color:#fff;font-size:17px">${n}</span>`;
  const step = (n, text) => `<li style="display:flex;gap:14px;margin:0 0 26px">${circle(n)}<span>${text}</span></li>`;
  await maker.setContent(`<body style="margin:0;font:20px/1.45 sans-serif;color:#333">
    <header style="position:sticky;top:0;background:#fff;padding:12px 0;text-align:center;box-shadow:0 2px 6px #0002">
      <span style="display:inline-block;padding:6px 18px;border-radius:20px;background:#f2f2f2;font-size:15px">kashi.ru</span></header>
    <main style="padding:10px 22px 400px">
      <h2 style="margin:18px 0">Ингредиенты:</h2>
      <ul style="padding-left:20px;margin:0 0 20px">
        <li>Пшено 1 стакан</li><li>Молоко 3 стакана</li><li>Вода 1 стакан</li><li>Сахар 2 ст. л.</li><li>Соль 1 ч. л.</li></ul>
      <h2>Приготовление:</h2>
      <ol style="list-style:none;padding:0">
        ${step(1, 'Промойте пшено в тёплой воде несколько раз.')}
        ${step(2, 'Залейте пшено водой и доведите до кипения.')}
        ${step(3, 'Влейте горячее молоко и хорошо перемешайте кашу ложкой.')}
        ${step(4, 'Добавьте сахар и соль, убавьте огонь до минимума.')}
        ${step(5, 'Варите кашу под крышкой около двадцати минут.')}
        ${step(6, 'Снимите кастрюлю с огня и оставьте кашу на десять минут.')}
      </ol></main>
    <button style="position:fixed;right:-14px;bottom:60px;width:86px;height:64px;border:0;border-radius:32px 0 0 32px;background:#4aa55a;color:#fff;font-size:34px">↑</button>
    </body>`);
  const first = await maker.screenshot({ type: 'png' });
  // Второй скриншот начинается с шага 3, который уже был внизу первого.
  await maker.evaluate(() => {
    const third = document.querySelectorAll('ol li')[2];
    window.scrollTo(0, third.getBoundingClientRect().top + scrollY - 90);
  });
  const second = await maker.screenshot({ type: 'png' });
  await maker.close();

  const page = await freshPage();
  await page.click('#add-trigger');
  await page.click('#open-photo');
  await page.setInputFiles('#import-photo', [
    { name: 'site-1.png', mimeType: 'image/png', buffer: first },
    { name: 'site-2.png', mimeType: 'image/png', buffer: second }]);
  await page.click('#import-submit');
  await page.waitForSelector('#ocr-review:not([hidden])', { timeout: 280000 });
  const text = await page.inputValue('#ocr-review-text');
  assert.doesNotMatch(text, /kashi|\.ru/, text);
  assert.match(text, /Молоко 3 стакана/, text);
  const steps = text.split('Приготовление:')[1].trim().split('\n');
  assert.deepEqual(steps.map(line => line.slice(0, 3)), ['1. ', '2. ', '3. ', '4. ', '5. ', '6. '], text);
  assert.equal(text.match(/Влейте горячее молоко/g).length, 1, text);
  assert.match(steps[5], /оставьте кашу на десять минут\.$/, text);
  await page.context().close();
});
