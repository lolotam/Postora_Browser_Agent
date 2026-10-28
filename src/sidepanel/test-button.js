// A "Test connection" button: neutral while the test runs, green with what came
// back, red with the error. Editing a field inside `scope` clears the result,
// since it described the values that were tested; a test still running then, or
// one overtaken by a newer click, is ignored when it finishes.

import { t } from './i18n.js';

export function bindTestButton({ button, result, scope, run }) {
  let generation = 0;
  const show = (state, text) => {
    button.dataset.state = state;
    result.dataset.state = state;
    result.textContent = text;
  };
  ['input', 'change'].forEach((type) => scope.addEventListener(type, (e) => {
    if (e.target === button) return;
    generation += 1;
    if (button.dataset.state || result.textContent) show('', '');
  }));
  button.addEventListener('click', async () => {
    const mine = ++generation;
    show('', t('fast.testing'));
    try {
      const text = await run();
      if (mine === generation) show('ok', text);
    } catch (err) {
      if (mine === generation) show('fail', `✗ ${err.message}`);
    }
  });
  return (state, text) => {
    generation += 1; // a programmatic field edit also invalidates an in-flight test
    show(state, text);
  };
}
