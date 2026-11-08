import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRecipe, parseRecipesFromText, splitCollection, parseRecipesFromJson, parseRecipesFromHtml, findDuplicate } from '../js/parser.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('сборник из трёх рецептов делится по повтору «Ингредиенты»', () => {
  const list = parseRecipesFromText(fx('collection.txt'));
  assert.deepEqual(list.map((r) => r.title), ['Блины на молоке', 'Сырники', 'Борщ']);
});

test('метаданные, ингредиенты и нумерованные шаги', () => {
  const [bliny] = parseRecipesFromText(fx('collection.txt'));
  assert.equal(bliny.servings, 4);
  assert.equal(bliny.time, '40 минут');
  assert.deepEqual(bliny.ingredients, ['молоко 500 мл', 'яйца 2 шт', 'мука 200 г', 'сахар 1 ст. л.', 'соль щепотка']);
  assert.equal(bliny.steps.length, 3);
  assert.equal(bliny.steps[1], 'Влить половину молока, всыпать муку и перемешать до однородности.');
});

test('ингредиенты в строку через запятую и раздел советов', () => {
  const borsch = parseRecipesFromText(fx('collection.txt'))[2];
  assert.deepEqual(borsch.ingredients, ['свёкла', 'капуста', 'картофель', 'морковь', 'лук']);
  assert.equal(borsch.notes, 'Подавать со сметаной.');
});

test('рецепт без заголовков разделов', () => {
  const r = parseRecipe(fx('single-noheaders.txt'));
  assert.equal(r.title, 'Омлет');
  assert.deepEqual(r.ingredients, ['3 яйца', '50 мл молока', 'соль по вкусу']);
  assert.equal(r.steps.length, 2);
});

test('разделитель --- и markdown', () => {
  const text = '# Салат\n## Ингредиенты\n- огурец 1 шт\n## Приготовление\nНарезать.\n---\n# Чай\nИнгредиенты\n- чай 1 ч. л.\nПриготовление\nЗаварить.';
  const list = parseRecipesFromText(text);
  assert.deepEqual(list.map((r) => r.title), ['Салат', 'Чай']);
  assert.deepEqual(list[0].ingredients, ['огурец 1 шт']);
});

test('«Рецепт 1:» в заголовке', () => {
  const parts = splitCollection('Рецепт 1: Каша\nИнгредиенты\nкрупа 100 г\nПриготовление\nВарить.\nРецепт 2: Кисель\nИнгредиенты\nягоды 200 г\nПриготовление\nВарить.');
  assert.equal(parts.length, 2);
  assert.equal(parseRecipe(parts[1]).title, 'Кисель');
});

test('пустой текст и мусор не дают рецептов', () => {
  assert.deepEqual(parseRecipesFromText(''), []);
  assert.deepEqual(parseRecipesFromText('   \n  '), []);
});

test('JSON резервной копии', () => {
  const { recipes, menu } = parseRecipesFromJson(JSON.stringify({ version: 2, recipes: [{ title: 'Суп', ingredients: ['вода'], steps: 'варить\nсолить' }], menu: { mon: [] } }));
  assert.equal(recipes[0].title, 'Суп');
  assert.deepEqual(recipes[0].steps, ['варить', 'солить']);
  assert.deepEqual(menu, { mon: [] });
});

test('битый JSON даёт понятную ошибку', () => {
  assert.throws(() => parseRecipesFromJson('{oops'), /повреждён/);
  assert.throws(() => parseRecipesFromJson('{}'), /не найдено/);
});

test('HTML со schema.org Recipe (JSON-LD, @graph, HowToSection)', () => {
  const ld = { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, { '@type': 'Recipe', name: 'Пирог', recipeYield: '8 порций', totalTime: 'PT1H15M', recipeIngredient: ['мука 300 г', 'яблоки 3 шт'], recipeInstructions: [{ '@type': 'HowToSection', itemListElement: [{ '@type': 'HowToStep', text: 'Замесить тесто.' }] }, { '@type': 'HowToStep', text: 'Выпекать.' }] }] };
  const [r] = parseRecipesFromHtml(`<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head></html>`);
  assert.equal(r.title, 'Пирог');
  assert.equal(r.servings, 8);
  assert.equal(r.time, '1 ч 15 мин');
  assert.deepEqual(r.steps, ['Замесить тесто.', 'Выпекать.']);
});

test('HTML без разметки разбирается как текст', () => {
  const [r] = parseRecipesFromHtml('<h1>Компот</h1><h2>Ингредиенты</h2><ul><li>вишня 300 г</li><li>сахар 100 г</li></ul><h2>Приготовление</h2><p>Варить 10 минут.</p>');
  assert.equal(r.title, 'Компот');
  assert.deepEqual(r.ingredients, ['вишня 300 г', 'сахар 100 г']);
});

test('дубликат по названию без учёта регистра и ё', () => {
  assert.ok(findDuplicate({ title: 'Свёкла  тушёная!' }, [{ title: 'свекла тушеная' }]));
  assert.equal(findDuplicate({ title: 'Другое' }, [{ title: 'свекла' }]), null);
});
