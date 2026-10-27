// The fast layer's own execution of a spoken command.
//
// The command is planned by the fast layer's decision client — the provider,
// model, endpoint and key the user configured — and every step that can send,
// buy, delete or submit is decided by the worker, which asks the session's
// access authority. The panel does not decide anything: it plans the step and
// hands it to the worker, and the worker asks the user (or does not, under
// Full access) before anything changes.
//
// Three rules hold for every step:
//   - the tab the command started on stays its target; nothing is retargeted
//     behind the user's back, and a tab another session or another panel is
//     working in is refused (a lookup that cannot answer stops the step);
//   - the command holds a claim on the tab it reads or changes, so a task
//     that starts at the same moment cannot work on the same page;
//   - the command is checked for cancellation before every change it makes,
//     and the worker checks the grant again after every step that took time.
//
// The page is only read. A click, a keystroke and Enter are real input, sent
// through the worker to the debugger: a site that ignores untrusted events
// cannot tell them from a user's.

import { chooseElement, planStep, shouldSubmit, splitCommand } from './voice-brain.js';
import { secretRule } from './voice-safety.js';
import * as page from './voice-page.js';

/**
 * Runs one spoken command.
 *
 * `ask` is the fast layer's ask (`{state, questions, signal}` → `{answers}`),
 * `browser` is the browser the steps run on, `emit` reports what the command
 * did, `signal` stops it, and `t` turns a message key into the panel's
 * language.
 *
 * `approve` is accepted so that the callers that still pass it keep working,
 * but it is not a permission decision any more: nothing of this path decides
 * what may run. The worker asks the session's access authority, and the user
 * answers through the same card the chat uses.
 */
export async function runFastCommand({ ask, browser, command, emit = () => {}, approve, signal, secretTokens = [], t = (key) => key }) {
  const cancelled = () => ({ ok: false, say: t('voice.sayCancelled'), cancelled: true });
  if (signal?.aborted) return cancelled();
  const base = secretRule();
  const rule = { ...base, tokens: [...base.tokens, ...secretTokens] };
  const target = await browser.currentTab();
  if (!target) return { ok: false, say: t('voice.sayNoTab') };

  // The claim is taken before the page is read and given back when the command
  // ends, whatever happened to it. The claim also hands back the command the
  // worker holds for this panel: every later step names it, so a step that
  // was planned under an older mode cannot run under a newer one.
  const claims = new Set();
  let command_ = null;
  let releasing = Promise.resolve();
  const claim = async (tabId) => {
    const res = await browser.claim(tabId);
    if (res?.ok) {
      claims.add(tabId);
      if (res.command) {
        // The worker holds another command now: the context this step was
        // planned under is gone, and nothing of it may run.
        if (command_ && res.command.id !== command_.id) {
          return { ok: false, errorKey: 'voice.sayCancelled' };
        }
        command_ = res.command;
      }
    }
    return res;
  };
  const releaseAll = () => {
    const tabs = [...claims];
    claims.clear();
    // Revoke every lease immediately; waiting for the first tab's debugger
    // cleanup must not leave queued input on another tab authorised.
    releasing = Promise.all([releasing, ...tabs.map((tabId) => browser.release(tabId).catch(() => {}))]);
    return releasing;
  };
  const revoke = () => {
    // The command is over: the worker drops the context it held for it, so
    // the question that may be waiting is withdrawn and nothing of it may run
    // any more.
    void browser.cancel?.();
    void releaseAll();
  };
  signal?.addEventListener('abort', revoke, { once: true });

  try {
    let owner;
    try {
      owner = await browser.ownerOf(target.id);
    } catch {
      // The lookup could not answer: the command does not act on a tab whose
      // owner it does not know.
      return { ok: false, say: t('voice.sayOwnerUnknown') };
    }
    if (owner) return { ok: false, say: t('voice.sayTabTaken', { owner }) };
    let held;
    try {
      held = await claim(target.id);
    } catch {
      // The worker could not answer: the claim is unknown, so nothing is read
      // and nothing is changed.
      return { ok: false, say: t('voice.sayOwnerUnknown') };
    }
    if (!held?.ok) return { ok: false, say: claimRefused(held, t) };

    const { steps } = await splitCommand(ask, command, { signal });
    let last = null;
    let current = target;
    for (const step of steps) {
      if (signal?.aborted) return { ok: false, say: t('voice.sayCancelled'), cancelled: true };
      // A click, form submission or the user can navigate without returning an
      // explicit replacement target. Refresh that same tab, never the active one.
      let fresh;
      try {
        fresh = await browser.getTab(current.id);
      } catch {
        // The tab the command was on is gone: the chain ends here, and no
        // other tab is picked up in its place.
        return { ok: false, say: t('voice.sayTabGone'), cancelled: true, closedTarget: true };
      }
      current = { ...current, ...fresh };
      // The context is built again for every step, from the tab the command is
      // on: a step that moved on tells the next one where it is.
      const ctx = await buildContext(browser, current);
      if (signal?.aborted) return { ok: false, say: t('voice.sayCancelled'), cancelled: true };
      last = await runStep({ ask, browser, ctx, target: current, command: step, emit, signal, rule, claim, t });
      if (signal?.aborted) return cancelled();
      emit({ kind: 'result', command: step, ...last });
      if (last.target) current = last.target; // a step that moved on names its new target
      if (!last.ok || last.stopListening || last.closedTarget) break;
    }
    return last ? { ...last, ...(!last.closedTarget ? { target: current } : {}) } : { ok: false, say: t('voice.sayNothingToDo') };
  } finally {
    await releaseAll();
    // The command is over: the worker drops the context it held for it, so
    // the next command of this panel starts under a context of its own.
    if (!signal?.aborted) await browser.cancel?.();
    signal?.removeEventListener('abort', revoke);
  }
}

/**
 * Why a claim was refused: the worker may name the reason itself, and it does
 * when the tab it was asked for is gone.
 */
function claimRefused(held, t) {
  return t(held?.errorKey ?? 'voice.sayTabTaken', { owner: held?.owner || '' });
}

/** What the decision client needs to know about the browser: the tab, and the other tabs by title. */
async function buildContext(browser, target) {
  const tabs = await browser.tabsInWindow(target.windowId);
  return {
    tab: target,
    url: target.url || '',
    title: target.title || '',
    // Only the title of the other tabs: their addresses can carry searches,
    // tokens and private pages that the model has no business reading.
    tabs: tabs.map((tab) => ({
      id: tab.id,
      title: tab.title || '',
      url: tab.id === target.id ? (tab.url || '') : '',
      active: tab.id === target.id,
    })),
  };
}

async function runStep({ ask, browser, ctx, target, command, emit, signal, rule, claim, t }) {
  const started = performance.now();
  const plan = await planStep(ask, command, ctx, { signal });
  const ms = Math.round(performance.now() - started);
  emit({ kind: 'decision', command, action: plan.action, confidence: plan.confidence, text: plan.text, model: plan.model, ms });

  const cancelled = { ok: false, say: t('voice.sayCancelled'), cancelled: true, action: plan.action, confidence: plan.confidence, ms };
  const failed = (say) => ({ ok: false, say, action: plan.action, confidence: plan.confidence, ms });

  if (plan.errorKey) return failed(t(plan.errorKey, { action: plan.action }));
  if (plan.unclear) return failed(t('voice.sayUnclear'));
  if (plan.action === 'unknown') return failed(t('voice.sayNotACommand'));

  // Every change asks who owns the tab it is about to change, and takes the
  // claim on it. A lookup that cannot answer stops the step: it fails closed.
  const guard = async (tabId) => {
    if (signal?.aborted) return cancelled;
    let owner;
    try {
      owner = await browser.ownerOf(tabId);
    } catch {
      return failed(t('voice.sayOwnerUnknown'));
    }
    if (signal?.aborted) return cancelled;
    if (owner) return failed(t('voice.sayTabTaken', { owner }));
    let held;
    try {
      held = await claim(tabId);
    } catch {
      return failed(t('voice.sayOwnerUnknown'));
    }
    if (signal?.aborted) return cancelled;
    if (!held?.ok) return failed(claimRefused(held, t));
    return { ok: true };
  };

  /** What the worker checks the element against, so a twin is not the same field. */
  const identity = (element) => ({
    kind: element?.kind ?? null,
    // The label the element really had when it was collected: the label the
    // model reads may be a fallback ("an unnamed field") or a merged one.
    label: element?.identityLabel ?? element?.label ?? null,
  });

  /** Closes a tab that was opened but never shown, so it does not stay behind. */
  const discardTab = async (tabId) => {
    try {
      await browser.removeTab(tabId, { orphan: true });
    } catch {
      // The tab is gone already.
    }
  };

  let outcome;
  try {
    outcome = await act();
  } catch (err) {
    // A command that was cancelled while a page call was on its way changes
    // nothing.
    if (signal?.aborted) return cancelled;
    if (err?.code === 'voice.pageRestricted' || /voice\.pageRestricted/.test(String(err?.message ?? ''))) {
      return failed(t('voice.sayPageRestricted'));
    }
    throw err;
  }
  return outcome;

  async function act() {
    // A command that was cancelled while the model was thinking changes nothing.
    if (signal?.aborted) return cancelled;
    switch (plan.action) {
      case 'navigate': {
        if (!plan.url) return failed(t('voice.sayNoSite'));
        const free = await guard(target.id);
        if (!free.ok) return free;
        const res = await browser.updateTab(target.id, { url: plan.url });
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayNoSite'));
        await browser.waitForLoad(target.id, { signal });
        const tab = await browser.getTab(target.id);
        return {
          ok: true,
          say: t('voice.sayOpened', { what: plan.text || plan.url }),
          action: plan.action,
          confidence: plan.confidence,
          ms,
          target: { ...target, url: tab?.url || plan.url, title: tab?.title ?? target.title },
        };
      }

      case 'new_tab': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        // The tab is opened without the focus, claimed and bound to this
        // session, and only then shown: a tab that appears out of nowhere
        // must not take the session with it.
        const created = await browser.openTab({ url: plan.url, windowId: target.windowId, tabId: target.id });
        if (!created?.id) return failed(t('voice.sayCannotDo'));
        let shown = false;
        try {
          const held = await claim(created.id);
          if (!held?.ok) return failed(claimRefused(held, t));
          const bound = await browser.bindSession(created.id);
          if (!bound.ok) return failed(t('voice.sayOwnerUnknown'));
          // Finish requested navigation before capturing the activation target.
          // Do not weaken document/URL checks to activate a still-loading page.
          if (plan.url) await browser.waitForLoad(created.id, { signal });
          if (signal?.aborted) return cancelled;
          const res = await browser.activateTab(created.id);
          if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayOwnerUnknown'));
          shown = true;
          const tab = await browser.getTab(created.id);
          return {
            ok: true,
            say: plan.url ? t('voice.sayOpenedNewTab', { what: plan.text || plan.url }) : t('voice.sayNewTab'),
            action: plan.action,
            confidence: plan.confidence,
            ms,
            target: { ...target, id: created.id, url: tab?.url || plan.url || '', title: tab?.title ?? '' },
          };
        } finally {
          // A tab that was not shown is an orphan: it is closed again. A tab
          // that was shown belongs to the session and stays.
          if (!shown) await discardTab(created.id);
        }
      }

      case 'web_search': {
        if (!plan.url) return failed(t('voice.sayNoSearch'));
        const free = await guard(target.id);
        if (!free.ok) return free;
        const res = await browser.updateTab(target.id, { url: plan.url });
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayNoSearch'));
        await browser.waitForLoad(target.id, { signal });
        const tab = await browser.getTab(target.id);
        return {
          ok: true,
          say: t('voice.saySearched', { site: plan.searchSite || 'Google', text: plan.text }),
          action: plan.action,
          confidence: plan.confidence,
          ms,
          target: { ...target, url: tab?.url || plan.url, title: tab?.title ?? target.title },
        };
      }

      case 'click': {
        const elements = await browser.inject(target.id, page.pageProbe, ['collect', { purpose: 'click' }, rule], { signal });
        if (elements?.errorKey) return failed(t(elements.errorKey));
        if (!elements?.length) return failed(t('voice.sayNoElements'));
        const pick = await chooseElement(ask, command, ctx, elements, 'click', plan.text, { signal });
        emit({ kind: 'element', label: pick?.element?.label ?? null, confidence: pick?.confidence, candidates: elements.length });
        if (!pick?.element) return failed(t('voice.sayNotFound', { text: plan.text || '' }));
        const free = await guard(target.id);
        if (!free.ok) return free;
        // The click is real input, and the page sees what a user's hand does.
        // The element travels with it: the worker finds it again after the
        // queue, so a page that replaced it does not get the click.
        const res = await browser.input(target.id, [{ op: 'click', element: pick.element.id }], {
          element: pick.element.id,
          expected: identity(pick.element),
          action: 'click',
        });
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayClickFailed'));
        await browser.waitForLoad(target.id, { signal });
        return { ok: true, say: t('voice.sayClicked', { label: pick.element.label }), action: plan.action, confidence: plan.confidence, ms };
      }

      case 'type_text': {
        // The field the text goes into is chosen from the page, never from
        // whatever happens to have the focus: a command that names a field
        // must not land in another one.
        const fields = await browser.inject(target.id, page.pageProbe, ['collect', { purpose: 'type' }, rule], { signal });
        if (fields?.errorKey) return failed(t(fields.errorKey));
        if (!fields?.length) return failed(t('voice.sayNoTextField'));
        // The model picks the field, even when there is only one: a command
        // that names a field that is not on the page must not land in it.
        const pick = await chooseElement(ask, command, ctx, fields, 'type', plan.text, { signal });
        emit({ kind: 'element', label: pick?.element?.label ?? null, confidence: pick?.confidence, candidates: fields.length });
        if (!pick?.element) return failed(t('voice.sayNoFieldFound'));
        const submit = await shouldSubmit(ask, command, { signal });
        const free = await guard(target.id);
        if (!free.ok) return free;
        // The text is written with real keys: the field is clicked, what was
        // in it is selected, and the text is inserted. The worker checks that
        // the same field still has the focus before every one of them, so a
        // page that moves the focus to a password box gets nothing.
        const steps = [
          { op: 'click', element: pick.element.id },
          { op: 'selectAll' },
          { op: 'text', text: plan.text ?? '' },
        ];
        if (submit) steps.push({ op: 'key', key: 'Enter' });
        const res = await browser.input(target.id, steps, {
          element: pick.element.id,
          expected: identity(pick.element),
          action: 'type_text',
        });
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayTypeFailed'));
        // A text that was sent may have started a page: the next step of the
        // chain waits for it.
        if (submit) await browser.waitForLoad(target.id, { signal });
        return { ok: true, say: t(submit ? 'voice.sayTypedSubmit' : 'voice.sayTyped'), action: plan.action, confidence: plan.confidence, ms };
      }

      case 'read_field': {
        // The value of one field, and only of that one: the user asked for
        // it, and the worker reads it only after the user allowed that read.
        const fields = await browser.inject(target.id, page.pageProbe, ['collect', { purpose: 'read' }, rule], { signal });
        if (fields?.errorKey) return failed(t(fields.errorKey));
        if (!fields?.length) return failed(t('voice.sayNoTextField'));
        const pick = await chooseElement(ask, command, ctx, fields, 'read', plan.text, { signal });
        emit({ kind: 'element', label: pick?.element?.label ?? null, confidence: pick?.confidence, candidates: fields.length });
        if (!pick?.element) return failed(t('voice.sayNoFieldFound'));
        const free = await guard(target.id);
        if (!free.ok) return free;
        const res = await browser.readField(target.id, pick.element.id, { expected: identity(pick.element) });
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayCannotDo'));
        // The value belongs in the result of the command and nowhere else: it
        // is never a caption, an audit line or a label.
        return { ok: true, say: t('voice.sayFound', { text: res.value }), action: plan.action, confidence: plan.confidence, ms };
      }

      case 'insert_text': {
        // The text goes into the field that has the focus right now, without
        // naming it: a terminal takes the focus itself.
        const free = await guard(target.id);
        if (!free.ok) return free;
        const res = await browser.insertText(target.id, plan.text ?? '');
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayTypeFailed'));
        return { ok: true, say: t('voice.sayTyped'), action: plan.action, confidence: plan.confidence, ms };
      }

      case 'press_enter': {
        const focused = await browser.inject(target.id, page.pageProbe, ['focused', null, rule], { signal });
        if (focused?.errorKey) return failed(t(focused.errorKey));
        // The focus is approved for one element: the body is approved as the
        // body it was, and anything else has no identity to check. Without one
        // the Enter is refused: it would go to whatever has the focus now.
        if (!focused?.id) return failed(t('voice.pageFocusLost'));
        const free = await guard(target.id);
        if (!free.ok) return free;
        if (signal?.aborted) return cancelled;
        // The focus is looked at again in the worker, right before the key:
        // the page may have moved it to another field. The body may have the
        // focus too: Enter is a page action there as well.
        const res = await browser.input(target.id, [{ op: 'key', key: 'Enter' }], {
          element: focused.id,
          expected: null,
          action: 'press_key',
        });
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayEnterFailed'));
        // The Enter may have started a page: the next step of the chain waits
        // for it to settle.
        await browser.waitForLoad(target.id, { signal });
        return { ok: true, say: t('voice.sayPressedEnter'), action: plan.action, confidence: plan.confidence, ms };
      }

      case 'scroll_down': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        const res = await browser.inject(target.id, page.scrollPage, ['down'], { signal });
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayCannotDo'));
        return { ok: true, say: t('voice.sayScrolledDown'), action: plan.action, confidence: plan.confidence, ms };
      }
      case 'scroll_up': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        const res = await browser.inject(target.id, page.scrollPage, ['up'], { signal });
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayCannotDo'));
        return { ok: true, say: t('voice.sayScrolledUp'), action: plan.action, confidence: plan.confidence, ms };
      }
      case 'scroll_top': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        const res = await browser.inject(target.id, page.scrollPage, ['top'], { signal });
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayCannotDo'));
        return { ok: true, say: t('voice.sayTop'), action: plan.action, confidence: plan.confidence, ms };
      }
      case 'scroll_bottom': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        const res = await browser.inject(target.id, page.scrollPage, ['bottom'], { signal });
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayCannotDo'));
        return { ok: true, say: t('voice.sayBottom'), action: plan.action, confidence: plan.confidence, ms };
      }

      case 'go_back': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        const res = await browser.goBack(target.id);
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayCannotDo'));
        return { ok: true, say: t('voice.sayBack'), action: plan.action, confidence: plan.confidence, ms };
      }
      case 'go_forward': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        const res = await browser.goForward(target.id);
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayCannotDo'));
        return { ok: true, say: t('voice.sayForward'), action: plan.action, confidence: plan.confidence, ms };
      }
      case 'reload': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        const res = await browser.reload(target.id);
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayCannotDo'));
        await browser.waitForLoad(target.id, { signal });
        return { ok: true, say: t('voice.sayReloaded'), action: plan.action, confidence: plan.confidence, ms };
      }

      case 'close_tab': {
        // A tab that could not be named is not closed: the tab that happens to
        // be open is not what the user asked for.
        if (plan.tabUnclear) return failed(t('voice.sayNoTabMeaning'));
        const id = plan.tabId ?? target.id;
        const title = ctx.tabs.find((tab) => tab.id === id)?.title;
        const free = await guard(id);
        if (!free.ok) return free;
        // The tab may have changed hands while the question was open.
        const again = await guard(id);
        if (!again.ok) return again;
        if (signal?.aborted) return cancelled;
        const res = await browser.removeTab(id);
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayCannotDo'));
        // The tab the command was on may be the one that was closed: the chain
        // ends there, and no other tab is taken up in its place.
        return {
          ok: true,
          say: t('voice.sayClosedTab', { title: title || t('voice.sayTheTab') }),
          action: plan.action,
          confidence: plan.confidence,
          ms,
          closedTarget: id === target.id,
        };
      }

      case 'switch_tab': {
        if (plan.tabId == null) return failed(t('voice.sayNoTabMeaning'));
        const free = await guard(plan.tabId);
        if (!free.ok) return free;
        // The tab is bound to this session before it is shown, so the panel
        // that follows the focused tab stays in this session.
        const bound = await browser.bindSession(plan.tabId);
        if (!bound.ok) return failed(t('voice.sayOwnerUnknown'));
        if (signal?.aborted) return cancelled;
        const res = await browser.activateTab(plan.tabId);
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayOwnerUnknown'));
        const tab = await browser.getTab(plan.tabId);
        return {
          ok: true,
          say: t('voice.saySwitched', { title: tab?.title || t('voice.sayTheTab') }),
          action: plan.action,
          confidence: plan.confidence,
          ms,
          target: { ...target, id: plan.tabId, url: tab?.url || '', title: tab?.title ?? '' },
        };
      }

      case 'next_tab':
      case 'previous_tab': {
        const index = ctx.tabs.findIndex((tab) => tab.active);
        const count = ctx.tabs.length;
        if (!count) return failed(t('voice.sayNoOtherTab'));
        const next = ctx.tabs[(index + (plan.action === 'next_tab' ? 1 : count - 1)) % count];
        const free = await guard(next.id);
        if (!free.ok) return free;
        const bound = await browser.bindSession(next.id);
        if (!bound.ok) return failed(t('voice.sayOwnerUnknown'));
        if (signal?.aborted) return cancelled;
        const res = await browser.activateTab(next.id);
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayOwnerUnknown'));
        const tab = await browser.getTab(next.id);
        return {
          ok: true,
          say: t('voice.saySwitched', { title: tab?.title || next.title }),
          action: plan.action,
          confidence: plan.confidence,
          ms,
          target: { ...target, id: next.id, url: tab?.url || '', title: tab?.title ?? next.title },
        };
      }

      case 'zoom_in':
      case 'zoom_out':
      case 'zoom_reset': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        // The worker reads the zoom and works out the level itself, so the
        // level that changes is the level that was approved.
        const res = await browser.zoom(target.id, plan.action.replace('zoom_', ''));
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayCannotDo'));
        const next = res.level ?? 0;
        return { ok: true, say: t(plan.action === 'zoom_reset' ? 'voice.sayZoomReset' : 'voice.sayZoom', { pct: Math.round((next || 1) * 100) }), action: plan.action, confidence: plan.confidence, ms };
      }

      case 'media_play_pause':
      case 'media_mute': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        const res = await browser.inject(target.id, page.mediaControl, [plan.action === 'media_mute' ? 'mute' : 'toggle'], { signal });
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayNoMedia', res?.errorParams ?? {}));
        return { ok: true, say: t(`voice.sayMedia${res.state[0].toUpperCase()}${res.state.slice(1)}`), action: plan.action, confidence: plan.confidence, ms };
      }

      case 'find_on_page': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        const res = await browser.inject(target.id, page.findText, [plan.text], { signal });
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayNotFound', res?.errorParams ?? {}));
        return { ok: true, say: t('voice.sayFound', { text: plan.text }), action: plan.action, confidence: plan.confidence, ms };
      }

      case 'stop_listening':
        return { ok: true, say: t('voice.sayStoppedListening'), stopListening: true, action: plan.action, confidence: 1, ms };

      default:
        return failed(t('voice.sayCannotDo', { action: plan.action }));
    }
  }
}
