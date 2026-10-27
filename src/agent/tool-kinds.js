// What each tool's result is, so batching and conversation trimming treat them
// right without knowing every tool:
//   observe     an action whose result is the page state (the last one in a turn reports it)
//   reader      reads the page without changing it (get_text, screenshot, tabs)
//   boundary    ends the turn's batch: the model must see the result before anything else runs
//   bookkeeping short results that never need trimming (note)
//   notes       the whole notebook; only the latest copy is kept in full
//   done        the final report
//
// A read of one selected value is a reader: its result is the value, not a
// page state that a later snapshot replaces. It says nothing about what this
// session may do: that is the authority's business, not this file's.
export const TOOL_KINDS = {
  read_page: 'observe',
  read_field: 'reader',
  navigate: 'observe',
  web_search: 'observe',
  click: 'observe',
  click_at: 'observe',
  type_text: 'observe',
  insert_text: 'observe',
  press_key: 'observe',
  select_option: 'observe',
  hover: 'observe',
  scroll: 'observe',
  history: 'observe',
  wait: 'observe',
  switch_tab: 'observe',
  open_tab: 'observe',
  get_text: 'reader',
  screenshot: 'reader',
  list_tabs: 'reader',
  close_tab: 'reader',
  // @store-strip-start
  run_javascript: 'reader',
  // @store-strip-end
  ask_user: 'boundary',
  choose_suggestion: 'boundary',
  note: 'bookkeeping',
  read_notes: 'notes',
  done: 'done',
};

/** Unknown names count as page observations, the safe default for trimming. */
export function kindOf(name) {
  return TOOL_KINDS[name] ?? 'observe';
}
