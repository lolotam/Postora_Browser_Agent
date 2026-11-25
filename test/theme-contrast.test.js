import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../src/sidepanel/panel.css', import.meta.url), 'utf8');
const themes = [...css.matchAll(/:root\s*\{([^}]+)\}/g)].map(([, block]) =>
  Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[\da-f]{6});/gi)].map(([, key, value]) => [key, value])));

function luminance(hex) {
  const [r, g, b] = hex.slice(1).match(/../g).map((byte) => parseInt(byte, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

for (const [name, colors] of [['light', themes[0]], ['dark', { ...themes[0], ...themes[1] }]]) {
  test(`${name} UI labels, risk text and action glyphs meet normal-text contrast`, () => {
    for (const [foreground, background] of [
      ['--muted', '--bg'], ['--muted', '--surface'], ['--muted', '--surface-2'],
      ['--accent-text', '--bg'], ['--warn', '--warn-bg'],
      ['--on-danger', '--danger'], ['--on-accent', '--accent'],
    ]) {
      const a = luminance(colors[foreground]);
      const b = luminance(colors[background]);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
    }
    const focusFg = luminance(colors['--accent-text']);
    const focusBg = luminance(colors['--bg']);
    const focusRatio = (Math.max(focusFg, focusBg) + 0.05) / (Math.min(focusFg, focusBg) + 0.05);
    assert.ok(focusRatio >= 3, `focus ring (--accent-text on --bg): ${focusRatio.toFixed(2)}:1`);
  });
}

test('side panel stylesheets enforce >=11px minimum font size, >=3:1 focus ring, and direction-inheriting totals', () => {
  const workspaceCss = fs.readFileSync(new URL('../src/sidepanel/workspace.css', import.meta.url), 'utf8');
  for (const [label, sheet] of [['panel.css', css], ['workspace.css', workspaceCss]]) {
    const pxSizes = [...sheet.matchAll(/font(?:-size)?:\s*(?:\d+\s+)?(\d+(?:\.\d+)?)px/g)].map(([, n]) => Number(n));
    assert.ok(pxSizes.length > 0, `${label} should declare font sizes`);
    for (const size of pxSizes) {
      assert.ok(size >= 11, `${label} font size ${size}px must be at least 11px`);
    }
  }
  assert.match(css, /:focus-visible\s*\{\s*outline:\s*2px solid var\(--accent-text\)/);
  assert.match(workspaceCss, /\.totals\s*\{\s*direction:\s*inherit;/);
});
