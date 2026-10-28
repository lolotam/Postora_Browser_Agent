// The searchable model dialog: one full-width menu for every model field —
// the quick control beside the composer and the four settings slots. It reads
// its state through `get` on every render, so the list it shows is always the
// caller's own, and it never applies a choice itself: `onPick` and `onManual`
// own the field the model id lands in.
//
// The dialog is a native <dialog>: the browser gives it the focus trap, the
// Escape key and the focus it hands back when it closes. The search field is
// a combobox for the listbox below it: the keyboard cursor is announced with
// aria-activedescendant, not only drawn.

import { t } from './i18n.js';
import { escapeAttr, filterModels } from './model-picker.js';

export function createModelDialog(elements) {
  const {
    dialog, title, searchRow, search, list, empty, status, manual, manualInput, manualSave,
    manualBtn, refresh, configure, close, hint,
  } = elements;
  let state = null; // what the caller opened with
  let refreshing = false;
  let activeIndex = -1; // keyboard cursor into the rendered rows
  let manualOpen = false; // the id field, opened by hand for a listed provider
  let generation = 0;

  /** Everything the current screen is drawn from. */
  function snapshot() {
    const snap = state.get();
    const models = Array.isArray(snap.models) ? snap.models : [];
    return {
      current: typeof snap.current === 'string' ? snap.current.trim() : '',
      models,
      loading: Boolean(snap.loading) || refreshing,
      error: snap.error ?? '',
      manualOnly: Boolean(snap.manualOnly),
      query: search.value.trim(),
    };
  }

  function setLoading(on) {
    refreshing = on;
    render();
  }

  /** The rows: the chosen model first when the list does not know it. */
  function rowsOf(snap) {
    const shown = filterModels(snap.models, snap.query, snap.current);
    const known = shown.some((m) => m.id === snap.current);
    const rows = snap.current && !snap.manualOnly && !known && !snap.query
      ? [{ id: snap.current, name: snap.current, pinned: true }]
      : [];
    return rows.concat(shown.map((m) => ({ ...m, pinned: false })));
  }

  function activeId() {
    const rows = [...list.children];
    return activeIndex >= 0 && activeIndex < rows.length ? rows[activeIndex].id : null;
  }

  function render() {
    if (!state) return;
    const snap = snapshot();
    const rows = rowsOf(snap);
    title.textContent = state.title();
    status.hidden = !(snap.loading || snap.error);
    status.textContent = snap.loading ? t('model.loading') : snap.error;
    status.classList.toggle('error', Boolean(snap.error) && !snap.loading);
    const listShown = !snap.manualOnly;
    list.hidden = !listShown || snap.loading;
    searchRow.hidden = snap.manualOnly; // nothing to search where there is no list
    if (activeIndex >= rows.length) activeIndex = -1;
    const matches = snap.query ? filterModels(snap.models, snap.query, null) : rows;
    const noResults = listShown && !snap.loading && !matches.length;
    empty.hidden = !noResults;
    list.innerHTML = rows.map((m, i) => {
      const chosen = m.id === snap.current;
      const detail = m.pinned
        ? t('model.manualAction')
        : (m.name && m.name !== m.id ? escapeAttr(m.id) : '');
      const tag = m.hidden ? `<span class="model-tag">${escapeAttr(t('model.hiddenGroup'))}</span>` : '';
      return `<li role="option" id="modelDialogOption${i}" aria-selected="${chosen}" data-value="${escapeAttr(m.id)}" class="model-option${chosen ? ' chosen' : ''}${i === activeIndex ? ' active' : ''}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 9 5v10l-9 5-9-5V7l9-5M3 7l9 5 9-5M12 12v10"/></svg>
        <span class="grow"><strong>${escapeAttr(m.name ?? m.id)}</strong>${detail ? `<small dir="ltr">${detail}</small>` : ''}</span>${tag}
        <svg class="model-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>
      </li>`;
    }).join('');
    // The keyboard cursor is announced, not only painted.
    const announced = activeId();
    list.setAttribute('aria-activedescendant', announced ?? '');
    search.setAttribute('aria-activedescendant', announced ?? '');
    search.setAttribute('aria-expanded', String(listShown && !snap.loading));
    // The manual path: offered for its own, and forced when the provider serves no list.
    manualBtn.hidden = snap.manualOnly;
    manual.hidden = !snap.manualOnly && !manualOpen;
    // A provider with no list has no list to refresh either.
    refresh.hidden = snap.manualOnly || !state.onRefresh;
    refresh.disabled = snap.loading;
    configure.hidden = !state.onConfigure;
    if (hint) hint.hidden = false;
  }

  function showManual(open) {
    manualOpen = open;
    if (open) {
      manualInput.value = state?.get().current ?? '';
      render();
      manualInput.focus();
    } else {
      render();
    }
  }

  function pickRow(row) {
    const id = row?.dataset?.value;
    if (!id) return;
    dialog.close();
    state.onPick(id);
  }

  /** The keyboard cursor, kept inside the rendered rows. */
  function move(step) {
    const rows = [...list.querySelectorAll('.model-option')];
    if (!rows.length) return;
    activeIndex = activeIndex < 0 ? (step > 0 ? 0 : rows.length - 1) : (activeIndex + step + rows.length) % rows.length;
    rows.forEach((row, i) => row.classList.toggle('active', i === activeIndex));
    rows[activeIndex].scrollIntoView({ block: 'nearest' });
    const announced = rows[activeIndex].id;
    list.setAttribute('aria-activedescendant', announced);
    search.setAttribute('aria-activedescendant', announced);
  }

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.model-option');
    if (row) pickRow(row);
  });
  list.addEventListener('mousemove', (e) => {
    const row = e.target.closest('.model-option');
    if (!row) return;
    const index = [...list.children].indexOf(row);
    if (index !== activeIndex) {
      activeIndex = index;
      render();
    }
  });
  search.addEventListener('input', () => {
    activeIndex = -1;
    render();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (snapshot().loading) return;
      // A row the user moved onto is the choice. Otherwise Enter commits the
      // first real match of the query — the chosen model is kept visible in
      // the list, but it is never picked just because it is the current one.
      if (activeIndex >= 0) {
        pickRow([...list.querySelectorAll('.model-option')][activeIndex]);
        return;
      }
      const query = search.value.trim();
      if (!query) return;
      const [first] = filterModels(snapshot().models, query, null);
      if (first) pickRow({ dataset: { value: first.id } });
    }
  });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  });
  manualBtn.addEventListener('click', () => showManual(true));
  manualSave.addEventListener('click', () => {
    const id = manualInput.value.trim();
    if (!id) return;
    dialog.close();
    state.onManual(id);
  });
  manualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      manualSave.click();
    }
  });
  refresh.addEventListener('click', async () => {
    if (!state?.onRefresh) return;
    const started = generation;
    setLoading(true);
    try {
      await state.onRefresh();
    } catch {
      // The caller reported the failure where the field is; the dialog only
      // has to stop waiting.
    } finally {
      if (started === generation) setLoading(false);
    }
  });
  configure?.addEventListener('click', () => {
    dialog.close();
    state.onConfigure?.();
  });
  close.addEventListener('click', () => dialog.close());

  return {
    /** Opens the dialog for one field. `get` is read again on every render. */
    open(options) {
      generation += 1;
      state = options;
      manualOpen = false;
      refreshing = false;
      activeIndex = -1;
      search.value = '';
      // The id field starts from this slot's own current model, never from
      // what an earlier dialog left behind.
      manualInput.value = state.get().current ?? '';
      render();
      dialog.showModal();
      (searchRow.hidden ? manualInput : search).focus();
      state.onOpen?.();
    },
    update: render,
    isOpen: () => dialog.open,
  };
}
