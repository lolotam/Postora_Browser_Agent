import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headerRules } from '../src/background/header-rules.js';

const rules = headerRules({ extensionId: 'ext-id', extensionVersion: '0.2.0', claudeCliVersion: '2.1.280' });
const ruleFor = (urlFilter) => rules.find((rule) => rule.condition.urlFilter === urlFilter);
const header = (rule, name) => rule.action.requestHeaders.find((h) => h.header === name);

test('the Claude token endpoint is called as Claude Code, not as a browser', () => {
  // A browser User-Agent there gets 429 "Rate limited", so the sign-in code
  // could never be exchanged.
  const rule = ruleFor('||platform.claude.com/');
  assert.deepEqual(header(rule, 'user-agent'), { header: 'user-agent', operation: 'set', value: 'claude-cli/2.1.280' });
  assert.deepEqual(header(rule, 'origin'), { header: 'origin', operation: 'remove' });
});

test('the Anthropic API is called as Claude Code too', () => {
  assert.equal(header(ruleFor('||api.anthropic.com/'), 'user-agent').value, 'claude-cli/2.1.280');
});

test('only the extension\'s own requests are changed, never a page\'s', () => {
  for (const rule of rules) {
    assert.deepEqual(rule.condition.initiatorDomains, ['ext-id'], rule.condition.urlFilter);
    assert.ok(!rule.condition.resourceTypes.includes('main_frame'), rule.condition.urlFilter);
  }
});

test('every rule has its own id, so one install replaces them all', () => {
  const ids = rules.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
});
