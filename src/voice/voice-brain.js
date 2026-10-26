// The decision layer of the voice path: it turns what the user said into
// typed questions and reads the answers back.
//
// It never talks to a provider itself. The caller hands it an `ask` function,
// so the same code works with Jev, with a gateway decision model and with a
// chat model, and always with the provider, model, endpoint and key the user
// configured. An answer that is malformed, that names an option that was not
// offered or that is not confident enough is no answer at all: the step is
// refused instead of guessed.

export const ACTIONS = {
  navigate: 'Open / go to / visit a website or web address in the current tab (e.g. "open youtube", "go to github.com").',
  new_tab: 'Open a NEW tab, optionally with a website in it (e.g. "open a new tab", "open gmail in a new tab").',
  web_search: 'Search for something: on Google, or on a named site like YouTube / Amazon / Wikipedia, or on the site currently open (e.g. "search for cats", "look up the weather", "find lofi music on youtube").',
  click: 'Click, press, open, select or play a specific link, button, video, result or item that is visible on the current page (e.g. "click sign in", "open the first result", "play the second video").',
  type_text: 'Type / write / enter / fill some text into a text box or input field on the page (e.g. "type hello world", "write my name in the email field").',
  press_enter: 'Press Enter / submit / send the current form or input.',
  scroll_down: 'Scroll down the page / go down / show more.',
  scroll_up: 'Scroll up the page / go up.',
  scroll_top: 'Jump to the very top of the page.',
  scroll_bottom: 'Jump to the very bottom / end of the page.',
  go_back: 'Go back to the previous page in history.',
  go_forward: 'Go forward to the next page in history.',
  reload: 'Reload / refresh the current page.',
  close_tab: 'Close the current tab or a named tab.',
  switch_tab: 'Switch to / show / go to another tab that is already open (by name, site or number).',
  next_tab: 'Go to the next tab (the tab on the right).',
  previous_tab: 'Go to the previous tab (the tab on the left).',
  zoom_in: 'Zoom in / make the page bigger.',
  zoom_out: 'Zoom out / make the page smaller.',
  zoom_reset: 'Reset the zoom to normal size.',
  media_play_pause: 'Play, pause, resume or stop the video or audio that is currently on the page (without naming a specific new video).',
  media_mute: 'Mute or unmute the video / audio on the page.',
  find_on_page: 'Find / highlight a word or phrase within the text of the current page.',
  stop_listening: 'Stop listening / go to sleep / turn off voice control.',
  unknown: 'Not a browser command, meaningless, chit-chat, or nothing that can be done in the browser.',
};

/** The steps that need an argument of their own. */
const NEEDS_TEXT = new Set(['web_search', 'type_text', 'find_on_page']);

/** How sure the answer has to be before the step runs. */
export const MIN_CONFIDENCE = 0.4;
/** The floor for the element a click or a typed text goes into. */
export const MIN_ELEMENT_CONFIDENCE = 0.3;

// ---------------------------------------------------------------- sites

export const SITES = {
  google: { name: 'Google', url: 'https://www.google.com', search: 'https://www.google.com/search?q=%s' },
  youtube: { name: 'YouTube', url: 'https://www.youtube.com', search: 'https://www.youtube.com/results?search_query=%s' },
  gmail: { name: 'Gmail / email / inbox', url: 'https://mail.google.com', search: 'https://mail.google.com/mail/u/0/#search/%s' },
  google_maps: { name: 'Google Maps / map / directions', url: 'https://www.google.com/maps', search: 'https://www.google.com/maps/search/%s' },
  google_images: { name: 'Google Images / pictures / photos', url: 'https://images.google.com', search: 'https://www.google.com/search?tbm=isch&q=%s' },
  google_news: { name: 'Google News / news', url: 'https://news.google.com', search: 'https://news.google.com/search?q=%s' },
  google_drive: { name: 'Google Drive', url: 'https://drive.google.com', search: 'https://drive.google.com/drive/search?q=%s' },
  google_calendar: { name: 'Google Calendar / calendar', url: 'https://calendar.google.com' },
  wikipedia: { name: 'Wikipedia', url: 'https://www.wikipedia.org', search: 'https://en.wikipedia.org/w/index.php?search=%s' },
  amazon: { name: 'Amazon / shopping', url: 'https://www.amazon.com', search: 'https://www.amazon.com/s?k=%s' },
  github: { name: 'GitHub', url: 'https://github.com', search: 'https://github.com/search?q=%s' },
  stackoverflow: { name: 'Stack Overflow', url: 'https://stackoverflow.com', search: 'https://stackoverflow.com/search?q=%s' },
  reddit: { name: 'Reddit', url: 'https://www.reddit.com', search: 'https://www.reddit.com/search/?q=%s' },
  x_twitter: { name: 'X / Twitter', url: 'https://x.com', search: 'https://x.com/search?q=%s' },
  facebook: { name: 'Facebook', url: 'https://www.facebook.com', search: 'https://www.facebook.com/search/top?q=%s' },
  instagram: { name: 'Instagram', url: 'https://www.instagram.com' },
  linkedin: { name: 'LinkedIn', url: 'https://www.linkedin.com', search: 'https://www.linkedin.com/search/results/all/?keywords=%s' },
  netflix: { name: 'Netflix', url: 'https://www.netflix.com', search: 'https://www.netflix.com/search?q=%s' },
  spotify: { name: 'Spotify / music', url: 'https://open.spotify.com', search: 'https://open.spotify.com/search/%s' },
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com' },
  claude: { name: 'Claude', url: 'https://claude.ai' },
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai', search: 'https://openrouter.ai/models?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com', search: 'https://www.bing.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com', search: 'https://duckduckgo.com/?q=%s' },
  translate: { name: 'Google Translate / translate', url: 'https://translate.google.com', search: 'https://translate.google.com/?text=%s' },
  weather: { name: 'Weather', url: 'https://weather.com', search: 'https://www.google.com/search?q=weather+%s' },
};

export function siteForUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'google.com' && u.pathname.startsWith('/maps')) return 'google_maps';
  for (const [key, site] of Object.entries(SITES)) {
    if (host === new URL(site.url).hostname.replace(/^www\./, '')) return key;
  }
  return null;
}

// ---------------------------------------------------------------- helpers

export function tokenize(text) {
  return text
    .replace(/[“”"]/g, '')
    .replace(/([,.;!?])(\s|$)/g, ' $1 ')
    .split(/\s+/)
    .filter(Boolean);
}

const LEAD_STOP = new Set(['for', 'to', 'and', 'then', 'on', 'in', 'at', 'of', 'into', 'with', 'please', ',', '.', ';', '!', '?']);
const TRAIL_STOP = new Set(['the', 'a', 'an', 'for', 'to', 'and', 'then', 'on', 'in', 'at', 'of', 'into', 'with', 'search', 'open', 'type', 'my', ',', '.', ';', '!', '?']);

export function candidateSpans(text, { maxLen = 14, max = 160 } = {}) {
  const words = tokenize(text);
  const seen = new Set();
  const spans = [];
  for (let len = Math.min(maxLen, words.length); len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const w = words.slice(i, i + len);
      if (LEAD_STOP.has(w[0].toLowerCase()) || TRAIL_STOP.has(w[w.length - 1].toLowerCase())) continue;
      if (w.some((x) => /^[,.;!?]$/.test(x))) continue;
      const span = w.join(' ');
      const key = span.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      spans.push(span);
    }
  }
  return spans.slice(0, max);
}

export function spokenToUrl(span) {
  if (!span) return null;
  let s = span.toLowerCase().trim()
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s+slash\s+/g, '/')
    .replace(/^(https?:\/\/)?(www\.)?/, '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(s.replace(/\s+/g, ''))) {
    return 'https://' + s.replace(/\s+/g, '');
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent('\\' + span.trim())}`;
}

function trimForState(s, n = 200) {
  return s && s.length > n ? s.slice(0, n) + '…' : s || '';
}

// ---------------------------------------------------------------- answers

/**
 * How sure the provider was: what it said, or the peak of the distribution it
 * gave. Null when it said nothing usable. A value that is not a number, or a
 * probability outside 0..1, is not a number at all: the answer is refused
 * rather than repaired.
 */
export function choiceConfidence(answer) {
  if (!answer || typeof answer !== 'object') return null;
  if (answer.confidence !== undefined && answer.confidence !== null) {
    const said = answer.confidence;
    if (typeof said !== 'number' || !Number.isFinite(said) || said < 0 || said > 1) return null;
    return said;
  }
  const probabilities = answer.probabilities;
  if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) return null;
  const values = Object.values(probabilities);
  if (!values.length) return null;
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) return null;
  const sorted = values.slice().sort((a, b) => b - a);
  return sorted[0] - (sorted[1] ?? 0);
}

/**
 * The answer as a choice the step can use: the provider named one of the
 * options that were offered and was sure enough about it. Anything else is no
 * answer at all, so the caller refuses the step instead of guessing.
 */
export function usableChoice(answer, allowed = null, { minConfidence = MIN_CONFIDENCE } = {}) {
  if (!answer || typeof answer !== 'object') return null;
  if (answer.type && answer.type !== 'choice') return null;
  const choice = typeof answer.choice === 'string' ? answer.choice : null;
  if (!choice) return null;
  if (allowed && !allowed.has(choice)) return null;
  const confidence = choiceConfidence(answer);
  if (confidence === null || confidence < minConfidence) return null;
  // The chosen option has to be the one the distribution favours; a model that
  // contradicts itself is not a decision to act on.
  const distribution = answer.probabilities;
  if (distribution !== undefined && (!distribution || typeof distribution !== 'object' || Array.isArray(distribution))) return null;
  const entries = Object.entries(distribution ?? {});
  if (entries.some(([key, p]) => typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1 || (allowed && !allowed.has(key)))) return null;
  if (entries.reduce((total, [, p]) => total + p, 0) > 1.01) return null;
  if (entries.length) {
    const best = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
    if (best[0] !== choice) return null;
  }
  return { choice, confidence };
}

/** The answer as a number between 0 and 1, or null when it is not one. */
export function usableNoul(answer) {
  if (!answer || typeof answer !== 'object') return null;
  const value = answer.noul;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

// ---------------------------------------------------------------- step 0: split compound commands

/**
 * Whether the command is one action or several. A word that joins two actions
 * is only cut off when the provider is sure about it, so an unsure answer
 * leaves the command whole.
 */
export async function splitCommand(ask, text, { signal } = {}) {
  const words = tokenize(text);
  const splitters = [];
  words.forEach((w, i) => {
    const lw = w.toLowerCase();
    if (i > 0 && i < words.length - 1 && ['and', 'then', ',', ';', '.', 'also', 'after'].includes(lw)) splitters.push(i);
  });
  const points = splitters.filter((i) => !(words[i].toLowerCase() === 'then' && splitters.includes(i - 1)));
  if (!points.length) return { steps: [text.trim()] };

  const questions = {};
  points.forEach((i, k) => {
    const before = words.slice(0, i).join(' ');
    const after = words.slice(i + 1).join(' ').replace(/^then\s+/i, '');
    questions[`split_${k}`] = {
      type: 'noul',
      instructions:
        `A user spoke a command to control their web browser. Decide whether the word "${words[i]}" at this position ` +
        `joins TWO SEPARATE browser actions to be done one after another, or is just part of a single action's argument ` +
        `(e.g. part of a search query, a name, or text to type).\n` +
        `Text before it: "${before}"\nText after it: "${after}"`,
      criteria: {
        true: `"${before}" and "${after}" are two separate browser actions (e.g. open a site, then search / click / scroll).`,
        false: `"${words[i]}" is part of one action's argument, like a query "rock and roll" or "salt and pepper", or the text after it is not an action on its own.`,
      },
    };
  });
  const reply = await ask({ state: { spoken_command: text }, questions, signal });
  const answers = reply?.answers ?? {};
  const cuts = points.filter((_, k) => (usableNoul(answers[`split_${k}`]) ?? 0) >= 0.5);
  const steps = [];
  let start = 0;
  for (const cut of cuts) {
    steps.push(words.slice(start, cut).join(' '));
    start = cut + 1;
  }
  steps.push(words.slice(start).join(' '));
  return {
    steps: steps.map((s) => s.replace(/^(then|also|and)\s+/i, '').replace(/[,.;]\s*$/, '').trim()).filter(Boolean),
  };
}

// ---------------------------------------------------------------- step 1: choose action + arguments

export async function planStep(ask, command, ctx, { signal } = {}) {
  const spans = candidateSpans(command);
  const spanCriteria = { none: 'There is no free-text argument in the command.' };
  spans.forEach((s, i) => (spanCriteria[`s${i}`] = `"${s}"`));

  const siteCriteria = {
    none: 'No website is named, and the command does not need one.',
    current_site: `The site that is open right now (${trimForState(ctx.url, 80) || 'unknown'}), because the user did not name a different one.`,
    other: 'A website that is NOT in this list (e.g. a named site like "bbc dot com" or "the verge").',
  };
  for (const [key, site] of Object.entries(SITES)) siteCriteria[key] = site.name;

  const state = {
    spoken_command: command,
    current_tab: { title: trimForState(ctx.title, 120), url: trimForState(ctx.url, 200) },
    // The other tabs are named by their title only: their addresses can carry
    // searches and private pages that the model has no business reading.
    open_tabs: (ctx.tabs || []).map((tab, i) => `${i + 1}. ${trimForState(tab.title, 60)}${tab.url ? ` (${trimForState(tab.url, 60)})` : ''}${tab.active ? ' [current]' : ''}`),
  };

  const questions = {
    action: {
      type: 'choice',
      instructions:
        'The user spoke this command to control their Chrome browser (speech-to-text, so it may contain small ' +
        'recognition errors). Which single browser action does the user want?',
      criteria: ACTIONS,
    },
    argument: {
      type: 'choice',
      instructions:
        'Pick the exact span of the spoken command that is the free-text argument of the action: the search query ' +
        '(without words like "search for" or "on youtube"), the text to type, the words to find on the page, ' +
        'the name/label of the link or button to click, or the website name/address to open. ' +
        'Pick the complete argument, not a fragment. Pick "none" if there is no argument.',
      criteria: spanCriteria,
    },
    site: {
      type: 'choice',
      instructions:
        'Which website does the command refer to, i.e. the site to open, or the site to search on? ' +
        'For a plain "search for X" with no site named, pick "current_site" if the open site has its own search ' +
        '(like YouTube, Amazon, GitHub), otherwise "google".',
      criteria: siteCriteria,
    },
  };

  const tabs = ctx.tabs || [];
  const reply = await ask({ state, questions, signal });
  const answers = reply?.answers ?? {};
  const action = usableChoice(answers.action, new Set(Object.keys(ACTIONS)));
  // No usable action: the command is refused rather than guessed at.
  if (!action) return { command, action: 'unknown', confidence: 0, text: null, siteKey: null, tabId: null, url: null, unclear: true };

  const argument = usableChoice(answers.argument, new Set(Object.keys(spanCriteria)), { minConfidence: MIN_ELEMENT_CONFIDENCE });
  const site = usableChoice(answers.site, new Set(Object.keys(siteCriteria)), { minConfidence: MIN_ELEMENT_CONFIDENCE });

  const plan = {
    command,
    action: action.choice,
    confidence: action.confidence,
    text: argument && argument.choice !== 'none' ? spans[Number(argument.choice.slice(1))] : null,
    siteKey: site ? site.choice : 'none',
    tabId: null,
    url: null,
    model: reply?.model ?? null,
    usage: reply?.usage ?? null,
  };

  // Which tab the command means is asked only when it can matter, so the list of
  // the open tabs does not travel with every command.
  if ((plan.action === 'switch_tab' || plan.action === 'close_tab') && tabs.length > 1) {
    const tabCriteria = { none: 'No specific tab is referred to (or the current tab).' };
    tabs.forEach((tab, i) => (tabCriteria[`t${i}`] = `Tab number ${i + 1}: "${trimForState(tab.title, 70)}"${tab.active ? ' — the current tab' : ''}`));
    const tabReply = await ask({
      state: { spoken_command: command, open_tabs: state.open_tabs },
      questions: {
        tab: {
          type: 'choice',
          instructions: 'If the command refers to a specific open tab (by number, title or website) to switch to or close, which tab is it?',
          criteria: tabCriteria,
        },
      },
      signal,
    });
    const tabChoice = usableChoice(tabReply?.answers?.tab, new Set(Object.keys(tabCriteria)), { minConfidence: MIN_ELEMENT_CONFIDENCE });
    if (!tabChoice) {
      // The provider did not say which tab: the step that would close a tab
      // must not fall back to the tab that happens to be open.
      plan.tabUnclear = true;
    } else if (tabChoice.choice !== 'none') {
      const index = Number(tabChoice.choice.slice(1));
      if (tabs[index]) plan.tabId = tabs[index].id;
      else plan.tabUnclear = true;
    }
  }

  const siteKey = plan.siteKey === 'current_site' ? siteForUrl(ctx.url) : plan.siteKey;
  const known = SITES[siteKey];
  if (plan.action === 'navigate' || plan.action === 'new_tab') {
    if (known) plan.url = known.url;
    else if (plan.siteKey === 'other' || plan.siteKey === 'none') plan.url = spokenToUrl(plan.text);
    if (plan.action === 'navigate' && !plan.url) {
      if (plan.text) plan.url = SITES.google.search.replace('%s', encodeURIComponent(plan.text));
    }
  } else if (plan.action === 'web_search' && plan.text) {
    const template = (known && known.search) || SITES.google.search;
    plan.url = template.replace('%s', encodeURIComponent(plan.text));
    plan.searchSite = known && known.search ? known.name.split(' /')[0] : 'Google';
  }

  if (NEEDS_TEXT.has(plan.action) && !plan.text) plan.errorKey = 'voice.sayNoText';
  return plan;
}

// ---------------------------------------------------------------- step 2: choose an element on the page

const AD_RE = /googleadservices\.|doubleclick\.|\/aclk\?|\/pagead\//;

function linkGroup(href, pageUrl) {
  let u, page;
  try { u = new URL(href, pageUrl); page = new URL(pageUrl); } catch { return null; }
  if (u.href.split('#')[0] === page.href.split('#')[0]) return null;
  const seg = u.pathname.split('/')[1] || '';
  if (u.hostname !== page.hostname) return /google\.|bing\.|duckduckgo\./.test(page.hostname) ? 'search result' : null;
  if (seg === 'watch') return 'video';
  if (seg === 'shorts' && u.pathname.split('/')[2]) return 'short video';
  if (seg === 'dp' || seg === 'gp') return 'product';
  if (/^(r|comments)$/.test(seg) && u.pathname.includes('/comments/')) return 'post';
  if (seg === 'wiki' && /search|Special:Search/.test(page.href)) return 'search result';
  return null;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function describeElements(elements, pageUrl) {
  const groups = {};
  const info = elements.map((el) => {
    const ad = el.href && AD_RE.test(el.href);
    const group = !ad && el.href ? linkGroup(el.href, pageUrl) : null;
    if (group) groups[group] = (groups[group] || 0) + 1;
    return { ad, group, n: group ? groups[group] : 0 };
  });
  return elements.map((el, i) => {
    const { ad, group, n } = info[i];
    let d = ad ? `sponsored ad ${el.kind}` : group ? `${ordinal(n)} ${group} of ${groups[group]}` : el.kind;
    d += `: "${trimForState(el.label, 90)}"`;
    if (el.href && !group && !ad) d += ` → ${trimForState(el.href, 60)}`;
    if (el.inView) d += ' (on screen)';
    return d;
  });
}

/** The element on the page the command means, or null when it is not clear. */
export async function chooseElement(ask, command, ctx, elements, purpose, argumentText, { signal } = {}) {
  if (!elements.length) return null;
  const criteria = {};
  describeElements(elements, ctx.url).forEach((d, i) => (criteria[`e${i}`] = d));
  if (purpose === 'click') criteria.none = 'None of these elements matches what the user asked to click.';

  const question =
    purpose === 'click'
      ? `The user said "${command}" to their browser. Which element on the page should be clicked? ` +
        (argumentText ? `They are referring to "${argumentText}". ` : '') +
        'Elements are listed in page order (top to bottom). Words like "first", "second", "third" refer to the ' +
        'numbered content items (e.g. "1st video of 5", "2nd search result of 8"), never to menus or sponsored ads. ' +
        'Avoid sponsored ads unless the user explicitly asks for an ad. Prefer elements that are on screen.'
      : `The user said "${command}" to their browser. Which text field should the text "${argumentText}" be typed into? ` +
        'If no field is named, pick the most prominent / main input (e.g. the search box or message box).';

  const reply = await ask({
    state: { spoken_command: command, page: { title: trimForState(ctx.title, 120), url: trimForState(ctx.url, 200) } },
    questions: { element: { type: 'choice', instructions: question, criteria } },
    signal,
  });
  const answer = usableChoice(reply?.answers?.element, new Set(Object.keys(criteria)), { minConfidence: MIN_ELEMENT_CONFIDENCE });
  if (!answer || answer.choice === 'none') return { element: null, confidence: answer?.confidence ?? 0 };
  const element = elements[Number(answer.choice.slice(1))];
  if (!element) return { element: null, confidence: answer.confidence };
  return { element, confidence: answer.confidence };
}

/** Whether the text that was typed should be submitted right away. */
export async function shouldSubmit(ask, command, { signal } = {}) {
  const reply = await ask({
    state: { spoken_command: command },
    questions: {
      submit: {
        type: 'noul',
        instructions: 'After typing the text into the field, should Enter be pressed to submit / send / search right away?',
        criteria: {
          true: 'The user wants to submit, send or search (e.g. "search for", "and press enter", "send").',
          false: 'The user only wants the text typed in (e.g. "type", "write", "fill in") without submitting.',
        },
      },
    },
    signal,
  });
  const value = usableNoul(reply?.answers?.submit);
  return value !== null && value >= 0.5;
}
