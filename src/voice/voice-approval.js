// The question the user answers before a step that can send, buy, delete or
// submit. It is shown in the voice screen, with a yes and a no; it is never a
// browser dialog.

const APPROVE_TEXT = {
  click: 'voice.approveClick',
  type_text: 'voice.approveType',
  press_enter: 'voice.approveEnter',
  close_tab: 'voice.approveClose',
};

/**
 * What the user is asked to approve, in words that say what will happen: the
 * text that is going to be written, and whether it is going to be sent.
 */
export function approvalText(what, t) {
  if (what.action === 'type_text') {
    return t(what.submit ? 'voice.approveTypeSubmit' : 'voice.approveType', { label: what.label ?? '', text: what.text ?? '' });
  }
  return t(APPROVE_TEXT[what.action] ?? 'voice.approveTitle', { label: what.label ?? '' });
}
