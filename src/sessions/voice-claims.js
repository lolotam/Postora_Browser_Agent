// The leases the browser paths take on a tab.
//
// A lease says that one command is reading or changing this tab, so a task
// that starts at the same moment does not work on the same page. The leases
// live in the worker, so two panels cannot hold the same tab and a panel
// cannot take the lease of another one.
//
// The lease is not ownership: the tab stays the user's, and the session that
// holds it keeps its own work.
//
// Two kinds of lease share one registry, so the regular task path and the
// voice path consult the same boundary:
//   - a voice lease, taken by a panel for the time of one command;
//   - a session lease, reserved by a session while it takes a tab into its
//     group. The reservation closes the window between "the tab looks free"
//     and "the tab is in my group".
//
// A lease is given back in two steps. The authorization is withdrawn first, so
// that no further input may be sent, and the tab stays busy until the input
// that is still running has drained and the debugger is detached. Only then is
// the tab free. Every lease carries a token, so a cleanup that arrives late
// cannot give back a lease that replaced it.

const leases = new Map(); // tabId → lease

let counter = 0;

/** A token that names one lease. It is never given to the page. */
function nextToken() {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  counter += 1;
  return `lease-${counter}`;
}

/** The lease on a tab, or null. */
export function claimOf(tabId) {
  return leases.get(tabId) ?? null;
}

/**
 * True when the lease on the tab is the one that is named, and it may still be
 * used: a lease whose authorization was withdrawn is busy, but it is not
 * authorized any more.
 *
 * The lease is used only by the panel that holds it, and only under the token
 * that names it. A request without a token or without a panel is refused: the
 * lease is never used by whoever asks.
 *
 * The command may be named as well: a lease belongs to the command that took
 * it, so an action of another command may not act under it. A request without
 * a command is refused too when the lease belongs to one.
 */
export function isAuthorized(tabId, { panelId = null, token = null, commandId = null } = {}) {
  const held = leases.get(tabId);
  if (!held) return false;
  if (held.state !== 'active') return false;
  if (!panelId || held.panelId !== panelId) return false;
  if (!token || held.token !== token) return false;
  if (held.commandId && held.commandId !== commandId) return false;
  return true;
}

/**
 * Takes the voice lease on a tab. The panel that holds it may take it again
 * and keeps the same lease; any other panel is refused, and the one that holds
 * it is named.
 *
 * A lease belongs to the command that took it. The same command may take it
 * again and keeps its token, but another command of the same panel is
 * refused: the tab stays busy until the old lease is given back and its
 * cleanup is over. A lease that was retagged would let the late cleanup of
 * the old command free the lease of the new one, because both would carry
 * the same token.
 */
export function claimTab(tabId, { panelId, sessionId, commandId = null, owner = 'voice control' } = {}) {
  if (typeof panelId !== 'string' || !panelId.trim()) return { ok: false, owner: null };
  const held = leases.get(tabId);
  if (held) {
    if (held.kind === 'voice' && held.panelId === panelId && held.state === 'active') {
      // Another session's lease is not this panel's to take.
      if (sessionId != null && held.sessionId != null && held.sessionId !== sessionId) {
        return { ok: false, owner: held.owner };
      }
      // Another command of this panel holds the tab: it has to give it back
      // first, so that the late cleanup of the old command cannot free the
      // lease of the new one.
      if (held.commandId && commandId && held.commandId !== commandId) {
        return { ok: false, owner: held.owner };
      }
      if (sessionId != null) held.sessionId = sessionId;
      // A lease that was taken without a command belongs to the first command
      // that claims it. A lease that has one is never retagged.
      if (commandId && !held.commandId) held.commandId = commandId;
      return { ok: true, token: held.token };
    }
    // A lease whose authorization was withdrawn still holds the tab: the
    // input of the old command may not be over yet.
    return { ok: false, owner: held.owner };
  }
  const lease = {
    token: nextToken(),
    kind: 'voice',
    tabId,
    panelId,
    sessionId: sessionId ?? null,
    commandId: commandId ?? null,
    owner,
    state: 'active',
  };
  leases.set(tabId, lease);
  return { ok: true, token: lease.token };
}

/**
 * Reserves a tab for a session that is taking it into its group. The tab is
 * busy from this moment: the voice path may not take it while the session is
 * grouping it.
 */
export function reserveTab(tabId, { sessionId, controllerId, owner = 'this session' } = {}) {
  const held = leases.get(tabId);
  if (held) {
    // The same controller asks again: it keeps the reservation it has.
    if (held.kind === 'session' && held.controllerId === controllerId) {
      return { ok: true, token: held.token };
    }
    return { ok: false, owner: held.owner };
  }
  const lease = {
    token: nextToken(),
    kind: 'session',
    tabId,
    sessionId: sessionId ?? null,
    controllerId: controllerId ?? null,
    owner,
    state: 'reserved',
  };
  leases.set(tabId, lease);
  return { ok: true, token: lease.token };
}

/**
 * The adapter a browser controller uses to reserve a tab while it groups it.
 * The controller stays free of the worker's state: it only asks this.
 */
export function tabReservation({ sessionId, controllerId, owner = 'this session' } = {}) {
  return {
    async reserve(tabId) {
      const res = reserveTab(tabId, { sessionId, controllerId, owner });
      return res.ok ? { ok: true, token: res.token } : { ok: false, owner: res.owner };
    },
    async release(tabId, token) {
      return releaseReservation(tabId, token);
    },
  };
}

/** Gives a session reservation back. Only the reservation itself may do it. */
export function releaseReservation(tabId, token) {
  const held = leases.get(tabId);
  if (!held || held.kind !== 'session' || held.token !== token) return false;
  leases.delete(tabId);
  return true;
}

/**
 * Withdraws the authorization of a lease: no further input may be sent, but
 * the tab stays busy until the cleanup is over.
 *
 * Only the panel that holds the lease, and only under the token that names
 * it, may withdraw it. A request without them is refused, so a message that
 * lost its token cannot take the authorization of a lease away.
 */
export function revokeTab(tabId, { panelId = null, token = null } = {}) {
  const held = leases.get(tabId);
  if (!held) return null;
  if (!panelId || held.panelId !== panelId) return null;
  if (!token || held.token !== token) return null;
  if (held.state !== 'active') return held;
  held.state = 'revoking';
  return held;
}

/**
 * Withdraws the authorization of every lease of a panel at once. The tabs stay
 * busy; each one is given back when its own cleanup is over.
 *
 * This is the cleanup of a panel that goes away: it names the panel and needs
 * no token, because it does not free anything by itself.
 */
export function revokePanel(panelId) {
  const revoked = [];
  for (const held of leases.values()) {
    if (held.kind !== 'voice' || held.panelId !== panelId) continue;
    if (held.state === 'active') held.state = 'revoking';
    revoked.push(held);
  }
  return revoked;
}

/**
 * Gives a lease back: the tab is free again. Only the lease that is named may
 * do it, so a cleanup that arrives late cannot free a tab that another lease
 * holds by now.
 *
 * The token and the panel that hold the lease are both required: a request
 * without them frees nothing.
 */
export function releaseTab(tabId, { panelId = null, token = null } = {}) {
  const held = leases.get(tabId);
  if (!held) return false;
  if (!panelId || held.panelId !== panelId) return false;
  if (!token || held.token !== token) return false;
  leases.delete(tabId);
  return true;
}

/**
 * The name of the one that holds the lease on a tab, or null when the tab is
 * free. `exceptPanelId` leaves the lease of that panel out: it is the panel's
 * own tab. A lease whose authorization was withdrawn stays busy, whoever holds
 * it, so a tab that is still being cleaned up is not taken by anybody.
 */
export function holderOf(tabId, { exceptPanelId = null, exceptSessionId = null } = {}) {
  const held = claimOf(tabId);
  if (!held) return null;
  if (held.kind === 'voice') {
    if (exceptPanelId && held.panelId === exceptPanelId && held.state !== 'revoking') return null;
    return held.owner;
  }
  // A session lease: the session that holds it is not blocked by itself.
  if (exceptSessionId != null && held.sessionId === exceptSessionId) return null;
  return held.owner;
}

/**
 * The one that is working in a tab, when it is not the session asking: another
 * session's task, or a lease of the voice path. A tab that is held is not
 * free, whoever holds it.
 */
export function tabHolder(sessionOwner, tab, { sessionId = null, exceptPanelId = null } = {}) {
  const owner = sessionOwner?.(sessionId, tab) ?? null;
  if (owner) return owner;
  return holderOf(tab.id, { exceptPanelId, exceptSessionId: sessionId });
}
