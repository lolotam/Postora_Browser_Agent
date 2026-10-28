// The settings router: one focused page at a time. The index is a searchable
// list of sections; every section owns one full-width page; the back arrow
// walks the small hierarchy (a provider page returns to the models overview,
// everything else to the index, the index to the chat).
//
// The module owns which page is on the screen and where the focus goes —
// nothing else. The forms inside the pages keep their fields the whole time,
// so an unsaved edit survives moving between pages.

/** The parent each subpage goes back to; the index itself goes back to null. */
export const SECTION_PARENT = {
  models: null,
  fast: null,
  voice: null,
  behavior: null,
  language: null,
  account: null,
  'provider-main': 'models',
  'provider-backup': 'models',
};

/**
 * Creates the router.
 *
 * `pages` maps a section name to its page element; the index element is
 * `index`. `titles` maps a section (or the null index) to its heading text.
 * `onExit` runs when the user backs out of the index — the router only says
 * that settings is leaving, the panel decides what that means.
 */
export function createSettingsNav({ index, pages, title, titles, onExit, search, searchEmpty, rows }) {
  let current = null; // null = the index
  let invoker = null; // the row that opened the current page

  function show(next, { focus = true, from = null } = {}) {
    if (!(next === null || next in pages)) return false;
    invoker = from ?? (next === current ? invoker : null);
    current = next;
    for (const [name, page] of Object.entries(pages)) page.hidden = name !== next;
    index.hidden = next !== null;
    title.textContent = (titles[next] ?? titles.null)();
    if (focus) {
      const heading = (next === null ? index : pages[next]).querySelector('h2[tabindex="-1"]');
      if (heading) heading.focus({ preventScroll: false });
      else (next === null ? search ?? index : title)?.focus?.();
    }
    return true;
  }

  /** Back: a subpage to its parent, the index out of settings. True when it left. */
  function back({ focus = true } = {}) {
    if (current === null) {
      onExit?.();
      return true;
    }
    const parent = SECTION_PARENT[current] ?? null;
    const cameFrom = invoker;
    const leaving = pages[current];
    show(parent, { focus });
    if (focus) {
      // The focus goes back to the row that opened this page, when it is the
      // page the parent shows now.
      if (cameFrom && cameFrom.isConnected && (parent === null ? index : pages[parent]).contains(cameFrom)) {
        cameFrom.focus();
      } else if (leaving) {
        const heading = (parent === null ? index : pages[parent]).querySelector('h2[tabindex="-1"]');
        heading?.focus();
      }
    }
    return false;
  }

  /** The searchable index: rows whose text misses the query are hidden. */
  function filter(query) {
    const q = String(query ?? '').trim().toLowerCase();
    let shown = 0;
    for (const row of rows) {
      const text = `${row.textContent} ${row.dataset.search ?? ''}`.toLowerCase();
      const hit = !q || text.includes(q);
      row.hidden = !hit;
      if (hit) shown += 1;
    }
    if (searchEmpty) searchEmpty.hidden = shown > 0;
    return shown;
  }

  return {
    show,
    back,
    filter,
    section: () => current,
  };
}
