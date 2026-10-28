// Shared model-list helpers: attribute escaping and query filtering. The model
// <select> of the old settings form is gone — the choices are made in the
// searchable dialog (model-dialog.js), and the id input stays the canonical
// state of each field.

export function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// The selected model stays listed while searching, so filtering never changes the choice.
export function filterModels(list, query, current) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((m) => m.id === current || words.every((w) => `${m.id} ${m.name ?? ''}`.toLowerCase().includes(w)));
}
