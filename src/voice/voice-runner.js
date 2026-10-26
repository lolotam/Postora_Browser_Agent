// The fast layer's own execution of a spoken command.
//
// The command is planned by the fast layer's decision client — the provider,
// model, endpoint and key the user configured — and every step that can send,
// buy, delete or submit asks the user first.
//
// Two rules hold for every step:
//   - the tab the command started on stays its target; nothing is retargeted
//     behind the user's back, and a tab another session is working in is
//     refused (a lookup that cannot answer stops the step);
//   - the command is checked for cancellation before every change it makes,
//     including the one that follows the user's approval.

import { chooseElement, planStep, shouldSubmit, splitCommand } from './voice-brain.js';
import { needsConfirmation } from './voice-safety.js';
import * as page from './voice-page.js';

/**
 * Runs one spoken command.
 *
 * `ask` is the fast layer's ask (`{state, questions, signal}` → `{answers}`),
 * `browser` is the browser the steps run on, `approve` shows the user what
 * is about to happen and waits for a yes, and `t` turns a message key into the
 * panel's language.
 */
export async function runFastCommand({ ask, browser, command, emit = () => {}, approve, signal, secretTokens = [], t = (key) => key }) {
  const target = await browser.currentTab();
  if (!target) return { ok: false, say: t('voice.sayNoTab') };
  let owner;
  try {
    owner = await browser.ownerOf(target.id);
  } catch {
    // The lookup could not answer: the command does not act on a tab whose
    // owner it does not know.
    return { ok: false, say: t('voice.sayOwnerUnknown') };
  }
  if (owner) return { ok: false, say: t('voice.sayTabTaken', { owner }) };

  const { steps } = await splitCommand(ask, command, { signal });
  let last = null;
  let current = target;
  for (const step of steps) {
    if (signal?.aborted) return { ok: false, say: t('voice.sayCancelled'), cancelled: true };
    // A click, form submission or the user can navigate without returning an
    // explicit replacement target. Refresh that same tab, never the active one.
    current = { ...current, ...await browser.getTab(current.id) };
    // The context is built again for every step, from the tab the command is
    // on: a step that moved on tells the next one where it is.
    const ctx = await buildContext(browser, current);
    if (signal?.aborted) return { ok: false, say: t('voice.sayCancelled'), cancelled: true };
    last = await runStep({ ask, browser, ctx, target: current, command: step, emit, approve, signal, secretTokens, t });
    emit({ kind: 'result', command: step, ...last });
    if (last.target) current = last.target; // a step that moved on names its new target
    if (!last.ok || last.stopListening) break;
  }
  return last ?? { ok: false, say: t('voice.sayNothingToDo') };
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

async function runStep({ ask, browser, ctx, target, command, emit, approve, signal, secretTokens, t }) {
  const started = performance.now();
  const plan = await planStep(ask, command, ctx, { signal });
  const ms = Math.round(performance.now() - started);
  emit({ kind: 'decision', command, action: plan.action, confidence: plan.confidence, text: plan.text, model: plan.model, ms });

  const cancelled = { ok: false, say: t('voice.sayCancelled'), cancelled: true, action: plan.action, confidence: plan.confidence, ms };
  const failed = (say) => ({ ok: false, say, action: plan.action, confidence: plan.confidence, ms });

  if (plan.errorKey) return failed(t(plan.errorKey, { action: plan.action }));
  if (plan.unclear) return failed(t('voice.sayUnclear'));
  if (plan.action === 'unknown') return failed(t('voice.sayNotACommand'));

  // The user's yes is asked for the step that is about to happen, and it is
  // checked again afterwards: a command cancelled while the question was open
  // must not run.
  let approval = 'none';
  const confirm = async (what) => {
    if (signal?.aborted) return false;
    const ok = await approve(what);
    if (!ok) {
      approval = 'refused';
      return false;
    }
    if (signal?.aborted) {
      approval = 'refused';
      return false;
    }
    approval = 'given';
    return true;
  };

  // Every change asks who owns the tab it is about to change. A lookup that
  // cannot answer stops the step: it fails closed.
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
    return { ok: true };
  };

  let outcome;
  try {
    outcome = await act();
  } catch (err) {
    // A command that was cancelled while a page call was on its way changes
    // nothing.
    if (err?.name === 'AbortError') return cancelled;
    if (err?.code === 'voice.pageRestricted' || /voice\.pageRestricted/.test(String(err?.message ?? ''))) {
      return failed(t('voice.sayPageRestricted'));
    }
    throw err;
  }
  // A step that can send, buy, delete or submit never runs without the yes.
  if (outcome.ok && needsConfirmation(plan.action) && approval === 'none') {
    return failed(t('voice.sayNeedsConfirm'));
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
        await browser.updateTab(target.id, { url: plan.url });
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
        const created = await browser.openTab({ url: plan.url, windowId: target.windowId });
        if (plan.url) await browser.waitForLoad(created.id, { signal });
        const tab = await browser.getTab(created.id);
        return {
          ok: true,
          say: plan.url ? t('voice.sayOpenedNewTab', { what: plan.text || plan.url }) : t('voice.sayNewTab'),
          action: plan.action,
          confidence: plan.confidence,
          ms,
          target: { ...target, id: created.id, url: tab?.url || plan.url || '', title: tab?.title ?? '' },
        };
      }

      case 'web_search': {
        if (!plan.url) return failed(t('voice.sayNoSearch'));
        const free = await guard(target.id);
        if (!free.ok) return free;
        await browser.updateTab(target.id, { url: plan.url });
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
        const elements = await browser.inject(target.id, page.collectElements, ['click', secretTokens], { signal });
        if (!elements?.length) return failed(t('voice.sayNoElements'));
        const pick = await chooseElement(ask, command, ctx, elements, 'click', plan.text, { signal });
        emit({ kind: 'element', label: pick?.element?.label ?? null, confidence: pick?.confidence, candidates: elements.length });
        if (!pick?.element) return failed(t('voice.sayNotFound', { text: plan.text || '' }));
        if (pick.element.secret) return failed(t('voice.saySecretField'));
        if (!await confirm({ action: 'click', label: pick.element.label })) return cancelled;
        // The tab may have changed hands while the question was open.
        const free = await guard(target.id);
        if (!free.ok) return free;
        const res = await browser.inject(target.id, page.clickElement, [pick.element.id, secretTokens], { signal });
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayClickFailed', res?.errorParams ?? {}));
        await browser.waitForLoad(target.id, { signal });
        return { ok: true, say: t('voice.sayClicked', { label: pick.element.label }), action: plan.action, confidence: plan.confidence, ms };
      }

      case 'type_text': {
        const focused = await browser.inject(target.id, page.focusedIsEditable, [secretTokens], { signal });
        // A field that holds a secret is left alone: the text does not go into
        // some other field instead.
        if (focused?.secret) return failed(t('voice.saySecretField'));
        let element = null;
        if (focused?.editable) {
          element = { id: null, label: t('voice.sayFocusedField') };
        } else {
          const fields = await browser.inject(target.id, page.collectElements, ['type', secretTokens], { signal });
          if (!fields?.length) return failed(t('voice.sayNoTextField'));
          const pick = fields.length === 1 ? { element: fields[0], confidence: 1 } : await chooseElement(ask, command, ctx, fields, 'type', plan.text, { signal });
          emit({ kind: 'element', label: pick?.element?.label ?? null, confidence: pick?.confidence, candidates: fields.length });
          if (!pick?.element) return failed(t('voice.sayNoFieldFound'));
          if (pick.element.secret) return failed(t('voice.saySecretField'));
          element = pick.element;
        }
        const submit = await shouldSubmit(ask, command, { signal });
        if (!await confirm({ action: 'type_text', label: element.label, text: plan.text, submit })) return cancelled;
        const free = await guard(target.id);
        if (!free.ok) return free;
        const res = await browser.inject(target.id, page.typeInto, [element.id, plan.text, submit, secretTokens], { signal });
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayTypeFailed', res?.errorParams ?? {}));
        return { ok: true, say: t(submit ? 'voice.sayTypedSubmit' : 'voice.sayTyped'), action: plan.action, confidence: plan.confidence, ms };
      }

      case 'press_enter': {
        const focused = await browser.inject(target.id, page.focusedIsEditable, [secretTokens], { signal });
        if (focused?.secret) return failed(t('voice.saySecretField'));
        if (!await confirm({ action: 'press_enter', label: t('voice.sayFocusedField') })) return cancelled;
        const free = await guard(target.id);
        if (!free.ok) return free;
        const res = await browser.inject(target.id, page.pressEnter, [secretTokens], { signal });
        if (!res?.ok) return failed(t(res?.errorKey ?? 'voice.sayEnterFailed', res?.errorParams ?? {}));
        return { ok: true, say: t('voice.sayPressedEnter'), action: plan.action, confidence: plan.confidence, ms };
      }

      case 'scroll_down': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        await browser.inject(target.id, page.scrollPage, ['down'], { signal });
        return { ok: true, say: t('voice.sayScrolledDown'), action: plan.action, confidence: plan.confidence, ms };
      }
      case 'scroll_up': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        await browser.inject(target.id, page.scrollPage, ['up'], { signal });
        return { ok: true, say: t('voice.sayScrolledUp'), action: plan.action, confidence: plan.confidence, ms };
      }
      case 'scroll_top': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        await browser.inject(target.id, page.scrollPage, ['top'], { signal });
        return { ok: true, say: t('voice.sayTop'), action: plan.action, confidence: plan.confidence, ms };
      }
      case 'scroll_bottom': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        await browser.inject(target.id, page.scrollPage, ['bottom'], { signal });
        return { ok: true, say: t('voice.sayBottom'), action: plan.action, confidence: plan.confidence, ms };
      }

      case 'go_back': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        await browser.goBack(target.id);
        return { ok: true, say: t('voice.sayBack'), action: plan.action, confidence: plan.confidence, ms };
      }
      case 'go_forward': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        await browser.goForward(target.id);
        return { ok: true, say: t('voice.sayForward'), action: plan.action, confidence: plan.confidence, ms };
      }
      case 'reload': {
        const free = await guard(target.id);
        if (!free.ok) return free;
        await browser.reload(target.id);
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
        if (!await confirm({ action: 'close_tab', label: title || t('voice.sayTheTab') })) return cancelled;
        // The tab may have changed hands while the question was open.
        const again = await guard(id);
        if (!again.ok) return again;
        await browser.removeTab(id);
        return { ok: true, say: t('voice.sayClosedTab', { title: title || t('voice.sayTheTab') }), action: plan.action, confidence: plan.confidence, ms };
      }

      case 'switch_tab': {
        if (plan.tabId == null) return failed(t('voice.sayNoTabMeaning'));
        const free = await guard(plan.tabId);
        if (!free.ok) return free;
        await browser.updateTab(plan.tabId, { active: true });
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
        await browser.updateTab(next.id, { active: true });
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
        const zoom = await browser.getZoom(target.id);
        if (signal?.aborted) return cancelled;
        // The tab may have changed hands while it was read.
        const again = await guard(target.id);
        if (!again.ok) return again;
        const next = plan.action === 'zoom_reset' ? 0 : Math.min(5, Math.max(0.25, zoom + (plan.action === 'zoom_in' ? 0.25 : -0.25)));
        await browser.setZoom(target.id, next);
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
