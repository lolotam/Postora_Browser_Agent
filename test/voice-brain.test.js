import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize,
  candidateSpans,
  spokenToUrl,
  redactUrl,
  siteForUrl,
  describeElements,
  choiceConfidence,
  planStep,
  usableChoice,
  usableNoul,
} from '../src/voice/voice-brain.js';

test('relative and protocol-relative candidate URLs cannot leak query credentials', () => {
  assert.equal(redactUrl('/reset?token=PRIVATE#session=SECRET'), '/reset?token=*');
  assert.equal(redactUrl('//alice:password@example.test/share?signature=PRIVATE#SECRET'), '//example.test/share?signature=*');
  assert.equal(redactUrl('mailto:person@example.test?body=PRIVATE'), 'mailto:');
});

test('explicit confidence never overrides a malformed probability distribution', () => {
  const allowed = new Set(['click', 'scroll_down']);
  for (const probabilities of [
    null, [], 'click', { click: '0.9' }, { click: -0.1 },
    { click: 1.5 }, { click: NaN }, { click: 0.9, unoffered: 0.1 },
    { click: 0.9, scroll_down: 0.9 },
  ]) {
    assert.equal(usableChoice({ choice: 'click', confidence: 0.99, probabilities }, allowed), null);
  }
  assert.deepEqual(usableChoice({ choice: 'click', confidence: 0.9, probabilities: { click: 0.95 } }, allowed), { choice: 'click', confidence: 0.9 });
});

test('tokenize: splits text into clean word tokens', () => {
  const words = tokenize('open "youtube" and search, for lofi!');
  assert.deepEqual(words, ['open', 'youtube', 'and', 'search', ',', 'for', 'lofi', '!']);
});

test('candidateSpans: extracts contiguous argument candidates without lead/trail stop words', () => {
  const spans = candidateSpans('search for rock and roll music on youtube');
  assert.ok(spans.includes('rock and roll music'));
  assert.ok(spans.includes('youtube'));
  // Lead/trailing stop words should be pruned from boundaries
  assert.ok(!spans.some((s) => s.startsWith('for ') || s.endsWith(' on')));
});

test('spokenToUrl: converts spoken domain names to URLs', () => {
  assert.equal(spokenToUrl('bbc dot com'), 'https://bbc.com');
  assert.equal(spokenToUrl('github dot com slash myrepo'), 'https://github.com/myrepo');
  assert.ok(spokenToUrl('some random phrase').includes('duckduckgo.com/?q='));
});

test('spokenToUrl: only the scheme and the host are written down', () => {
  // A path, a query and a token in it keep their case: the address may be
  // case-sensitive.
  assert.equal(spokenToUrl('example dot com slash MyRepo'), 'https://example.com/MyRepo');
  assert.equal(spokenToUrl('example dot com slash a slash B?Token=AbC'), 'https://example.com/a/B?Token=AbC');
  assert.equal(spokenToUrl('https://example.com/MyRepo'), 'https://example.com/MyRepo');
  assert.equal(spokenToUrl('Example dot COM slash Path'), 'https://example.com/Path');
});

test('redactUrl: the secrets of an address are taken out of it', () => {
  assert.equal(redactUrl('https://user:pass@example.test/path?token=abc#frag'), 'https://example.test/path?token=*');
  assert.equal(redactUrl('https://example.test/path'), 'https://example.test/path');
  assert.equal(redactUrl(''), '');
});

test('the state the model sees never carries a token, a name or a fragment', async () => {
  let seen = null;
  const ask = async (req) => {
    seen = req.state;
    return {
      answers: {
        action: { type: 'choice', choice: 'scroll_down', confidence: 0.9 },
        argument: { type: 'choice', choice: 'none', confidence: 0.9 },
        site: { type: 'choice', choice: 'none', confidence: 0.9 },
      },
    };
  };

  await planStep(ask, 'scroll down', {
    url: 'https://user:secret@example.test/path?token=abc#fragment',
    title: 'Example',
    tabs: [{ id: 1, title: 'Example', url: 'https://example.test/path?token=abc#fragment', active: true }],
  });

  const state = JSON.stringify(seen);
  assert.doesNotMatch(state, /secret/, 'the name in the address stays out');
  assert.doesNotMatch(state, /abc/, 'the token in the address stays out');
  assert.doesNotMatch(state, /fragment/, 'the fragment stays out');
  assert.match(state, /example\.test/, 'the site is still named');
});

test('the link the model sees has no token in its address', () => {
  const descriptions = describeElements([
    { id: '1', kind: 'link', label: 'Report', href: 'https://example.test/report?token=abc', inView: true },
  ], 'https://example.test/');
  assert.doesNotMatch(descriptions[0], /abc/, 'the token stays out of the criteria');
  assert.match(descriptions[0], /example\.test/, 'the link is still named');
});

test('siteForUrl: matches open URLs to known site keys', () => {
  assert.equal(siteForUrl('https://www.youtube.com/watch?v=123'), 'youtube');
  assert.equal(siteForUrl('https://github.com/trending'), 'github');
  assert.equal(siteForUrl('https://example.org/test'), null);
});

test('describeElements: formats candidates with ordinals and groups', () => {
  const elements = [
    { id: '1', kind: 'link', label: 'Lofi Hip Hop', href: 'https://www.youtube.com/watch?v=1', inView: true },
    { id: '2', kind: 'link', label: 'Jazz Music', href: 'https://www.youtube.com/watch?v=2', inView: true },
  ];
  const descriptions = describeElements(elements, 'https://www.youtube.com/');
  assert.equal(descriptions.length, 2);
  assert.ok(descriptions[0].includes('1st video of 2'));
  assert.ok(descriptions[0].includes('(on screen)'));
  assert.ok(descriptions[1].includes('2nd video of 2'));
});

test('choiceConfidence: what the provider said, or the peak of its distribution', () => {
  assert.equal(choiceConfidence({ confidence: 0.8 }), 0.8);
  assert.equal(choiceConfidence({ probabilities: { a: 0.9, b: 0.1 } }), 0.8);
  assert.equal(choiceConfidence({ probabilities: { a: 0.9 } }), 0.9);
  assert.equal(choiceConfidence({}), null);
  assert.equal(choiceConfidence({ confidence: 5 }), null, 'a confidence outside 0..1 is not one');
});

test('usableChoice: only a named option that was offered and is sure enough', () => {
  const allowed = new Set(['click', 'scroll_down']);
  assert.equal(usableChoice({ type: 'choice', choice: 'click', confidence: 0.9 }, allowed)?.choice, 'click');
  assert.equal(usableChoice({ type: 'choice', choice: 'fly', confidence: 0.9 }, allowed), null, 'an option that was not offered');
  assert.equal(usableChoice({ type: 'choice', choice: 'click', confidence: 0.1 }, allowed), null, 'not sure enough');
  assert.equal(usableChoice({ type: 'noul', noul: 0.9 }, allowed), null, 'not a choice at all');
  assert.equal(usableChoice(null, allowed), null);
  assert.equal(usableChoice({ type: 'choice', choice: 'click', confidence: 0.9, probabilities: { click: 0.2, scroll_down: 0.8 } }, allowed), null, 'it contradicts itself');
});

test('usableNoul: a number between 0 and 1, or nothing', () => {
  assert.equal(usableNoul({ noul: 0.7 }), 0.7);
  assert.equal(usableNoul({ noul: 2 }), null);
  assert.equal(usableNoul({}), null);
  assert.equal(usableNoul(null), null);
});

test('planStep never talks to a provider itself', async () => {
  let fetched = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched += 1;
    throw new Error('the decision layer must not call a provider');
  };
  try {
    const plan = await planStep(async () => ({
      answers: {
        action: { type: 'choice', choice: 'scroll_down', confidence: 0.9, probabilities: { scroll_down: 0.9 } },
        argument: { type: 'choice', choice: 'none', confidence: 0.9 },
        site: { type: 'choice', choice: 'none', confidence: 0.9 },
      },
      model: 'mock-model',
    }), 'scroll down', { url: 'https://example.test/', title: 'Example', tabs: [] });
    assert.equal(plan.action, 'scroll_down');
    assert.equal(plan.model, 'mock-model');
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = saved;
  }
});

test('planStep refuses a step it cannot make sense of', async () => {
  const unclear = await planStep(async () => ({ answers: {} }), 'do something', { url: '', title: '', tabs: [] });
  assert.equal(unclear.action, 'unknown');
  assert.equal(unclear.unclear, true);
});
