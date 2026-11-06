import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentDirection } from '../src/sidepanel/content-direction.js';

test('Arabic prose is RTL even after English commands; code alone does not change prose direction', () => {
  assert.equal(contentDirection('npm run build\nتم البناء بنجاح'), 'rtl');
  assert.equal(contentDirection('Build passed.\n```js\nconst x = "عربي";\n```'), 'auto');
  assert.equal(contentDirection('English with `عربي` as a code example.'), 'auto');
  assert.equal(contentDirection('تم تشغيل `npm install` بنجاح.'), 'rtl');
});
