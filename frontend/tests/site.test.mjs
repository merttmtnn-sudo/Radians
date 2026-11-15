// The page holds together: every text exists in both languages, every text the page asks for
// exists, and every script, style sheet, data file and module import points at a file.
// (No browser needed: this reads the source files.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { STRINGS } from '../js/core/i18n.js';

const FRONT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(FRONT, rel), 'utf8');
const walk = (dir) => readdirSync(path.join(FRONT, dir)).flatMap((name) => {
  const rel = `${dir}/${name}`;
  return statSync(path.join(FRONT, rel)).isDirectory() ? walk(rel) : [rel];
});
const SCRIPTS = walk('js').filter(f => f.endsWith('.js'));          // the site's own modules (not planet/, a page of its own)
const html = read('index.html');

test('every text exists in English and in Turkish, with the same placeholders', () => {
  const en = Object.keys(STRINGS.en), tr = Object.keys(STRINGS.tr);
  assert.deepEqual(en.filter(k => !(k in STRINGS.tr)), [], 'missing in Turkish');
  assert.deepEqual(tr.filter(k => !(k in STRINGS.en)), [], 'missing in English');
  const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
  const differ = en.filter(k => holes(STRINGS.en[k]) !== holes(STRINGS.tr[k]));
  assert.deepEqual(differ, [], 'placeholders differ between the languages');
});

test('every text the page and the scripts ask for exists', () => {
  const asked = new Map();                                            // key -> where
  // (a key that ends in '_' is a prefix joined at run time, e.g. 'dir_' + 'north'; 'key' is the example in a comment)
  const note = (key, where) => { if (!asked.has(key) && !key.endsWith('_') && key !== 'key') asked.set(key, where); };
  for (const m of html.matchAll(/data-i18n(?:-title|-ph)?="([^"]+)"/g)) note(m[1], 'index.html');
  for (const file of SCRIPTS) {
    const src = read(file);
    for (const m of src.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) note(m[1], file);                       // t('key', ...)
    for (const m of src.matchAll(/\bt\([^()']*\?\s*'([A-Za-z0-9_]+)'\s*:\s*'([A-Za-z0-9_]+)'/g)) { note(m[1], file); note(m[2], file); }
    for (const m of src.matchAll(/\[\s*'((?:cu|ty)[A-Z][A-Za-z0-9]+)'\s*,/g)) note(m[1], file);          // wording modules: ['cuSpeed', {...}]
    for (const m of src.matchAll(/key:\s*'(f[A-Z][A-Za-z0-9]+)'/g)) note(m[1], file);                    // finds.js: {key: 'fMover'}
  }
  const missing = [...asked].filter(([key]) => !(key in STRINGS.en)).map(([key, where]) => `${key} (${where})`);
  assert.deepEqual(missing, []);
  assert.ok(asked.size > 300, `only ${asked.size} keys found: the patterns above no longer match the code`);
});

test('every module import points at a file', () => {
  const broken = [];
  for (const file of SCRIPTS) {
    for (const m of read(file).matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const target = m[1];
      if (/^https?:/.test(target)) continue;
      if (!existsSync(path.join(FRONT, path.dirname(file), target))) broken.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('every script, style sheet and data file the page names is there', () => {
  const missing = [];
  for (const m of html.matchAll(/(?:src|href)="static\/([^"?#]+)"/g)) if (!existsSync(path.join(FRONT, m[1]))) missing.push(m[1]);
  for (const file of SCRIPTS) {
    for (const m of read(file).matchAll(/[`'"]static\/((?:data|media)\/[A-Za-z0-9_.\/-]+\.[a-z]+)[`'"]/g)) {
      if (!existsSync(path.join(FRONT, m[1]))) missing.push(`${m[1]} (${file})`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every element the scripts look up by id is in the page', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const made = new Set(['suggest']);                                  // created by a script at run time
  const absent = [];
  for (const file of SCRIPTS) {
    for (const m of read(file).matchAll(/\$\('([A-Za-z][A-Za-z0-9_-]*)'\)/g)) {
      if (!ids.has(m[1]) && !made.has(m[1])) absent.push(`${m[1]} (${file})`);
    }
  }
  assert.deepEqual([...new Set(absent)], []);
});
