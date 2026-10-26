// The voice path's claim on a tab.
//
// A claim is a soft claim: it says that one command is reading or changing
// this tab, so a task that starts at the same moment does not work on the
// same page. The claims live in the worker, so two panels cannot hold the
// same tab and a panel cannot take the claim of another one.
//
// The claim is not ownership: the tab stays the user's, and the session that
// holds it keeps its own work.

const claims = new Map(); // tabId → { panelId, sessionId, owner }

/**
 * Takes the claim on a tab. The panel that holds it may take it again; any
 * other panel is refused, and the one that holds it is named.
 */
export function claimTab(tabId, { panelId, sessionId, owner = 'voice control' } = {}) {
  const held = claims.get(tabId);
  if (held && held.panelId !== panelId) return { ok: false, owner: held.owner };
  claims.set(tabId, { panelId, sessionId, owner });
  return { ok: true };
}

/** Gives the claim on a tab back. Only the panel that holds it may give it back. */
export function releaseTab(tabId, panelId) {
  const held = claims.get(tabId);
  if (!held) return false;
  if (panelId && held.panelId !== panelId) return false;
  claims.delete(tabId);
  return true;
}

/** Gives every claim of a panel back: it was closed, or its command ended. */
export function releasePanel(panelId) {
  const released = [];
  for (const [tabId, held] of [...claims]) {
    if (held.panelId === panelId) {
      claims.delete(tabId);
      released.push(tabId);
    }
  }
  return released;
}

/** The claim on a tab, or null. */
export function claimOf(tabId) {
  return claims.get(tabId) ?? null;
}

/**
 * The name of the one that holds the claim on a tab, or null when the tab is
 * free. `exceptPanelId` leaves the claim of that panel out: it is the panel's
 * own tab.
 */
export function holderOf(tabId, { exceptPanelId = null } = {}) {
  const held = claimOf(tabId);
  if (!held) return null;
  if (exceptPanelId && held.panelId === exceptPanelId) return null;
  return held.owner;
}

/**
 * The one that is working in a tab, when it is not the session asking: another
 * session's task, or the claim of the voice path. A tab that is held is not
 * free, whoever holds it.
 */
export function tabHolder(sessionOwner, tab, { sessionId = null, exceptPanelId = null } = {}) {
  const owner = sessionOwner?.(sessionId, tab) ?? null;
  if (owner) return owner;
  return holderOf(tab.id, { exceptPanelId });
}
