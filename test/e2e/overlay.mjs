import assert from 'node:assert/strict';
import { overlayCommand } from '../../src/browser/overlay.js';

export async function runOverlayScenario(context) {
  const page = await context.newPage();
  try {
    await page.setContent('<button id="target" style="position:absolute;left:100px;top:100px;width:120px;height:40px">Target</button>');
    const cmd = { texts: { working: 'Working', stop: 'Stop' }, dir: 'ltr', x: 160, y: 120 };
    const before = await page.locator('#target').boundingBox();
    await page.evaluate(overlayCommand, { ...cmd, op: 'move', rect: before });
    assert.equal(await page.evaluate(() => window.__agentOverlay.box.classList.contains('on')), false, 'hover must not highlight');
    assert.equal(await page.evaluate(() => window.__agentOverlay.cursor.querySelector('svg').getAttribute('width')), '16');
    await page.evaluate(overlayCommand, { ...cmd, op: 'click' });
    const highlight = await page.evaluate(() => {
      const { box, wrap } = window.__agentOverlay;
      return { on: box.classList.contains('on'), width: box.style.width, left: box.style.left, rings: wrap.querySelectorAll('.ripple').length };
    });
    assert.deepEqual(highlight, { on: true, width: '126px', left: '97px', rings: 1 });
    assert.deepEqual(await page.locator('#target').boundingBox(), before, 'the actual target must not scale or move');
    await page.waitForFunction(() => !window.__agentOverlay.box.classList.contains('on') && !window.__agentOverlay.wrap.querySelector('.ripple'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(overlayCommand, { ...cmd, op: 'click' });
    assert.equal(await page.evaluate(() => getComputedStyle(window.__agentOverlay.wrap.querySelector('.ripple')).animationName), 'none');
    await page.evaluate(overlayCommand, { op: 'remove' });
    console.log('OVERLAY PASSED: smaller cursor, click-only target outline/pulse, stable page layout, reduced motion.');
    return [];
  } catch (error) { return [`Overlay: ${error.stack ?? error}`]; }
  finally { await page.close(); }
}
