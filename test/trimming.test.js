import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactChatMessages,
  compactAnthropicMessages,
  compactResponsesInput,
  estimateConversationChars,
} from '../src/agent/trimming.js';
import { escalationMessage } from '../src/fast/fast-layer.js';

const longText = (prefix) => `${prefix} ${'x'.repeat(1800)}`;

function makeFastEscalation(pageNum) {
  return escalationMessage({
    fastActions: [`click [1] → Clicked`],
    outcome: {
      kind: 'escalate',
      reason: 'step needs reasoning',
      snapshot: {
        url: `https://example.com/page-${pageNum}`,
        title: `Page ${pageNum}`,
        generation: pageNum,
        scroll: { y: 0, viewport: 800, height: 2400 },
        elements: [`[1] button "Action ${pageNum}"`],
        offscreen: 0,
        text: longText(`FastSnapshot${pageNum}`),
      },
      hints: 'Fast layer ranked options — probabilities:\n- next operation: click 75%',
    },
    includePage: true,
  });
}

test('shared trimming exempts project_read, project_context, project_list, and ask_user across all providers', () => {
  const fileContent = longText('FILE_BODY');
  const askAnswer = longText('USER_ANSWER');
  const page1 = longText('PAGE_ONE');
  const page2 = longText('PAGE_TWO');
  const page3 = longText('PAGE_THREE');

  // 1. OpenAI Chat Completions
  const chatCall = (id, name) => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
  });
  const chatMessages = [
    chatCall('p1', 'read_page'), { role: 'tool', tool_call_id: 'p1', content: page1 },
    chatCall('f1', 'project_read'), { role: 'tool', tool_call_id: 'f1', content: fileContent },
    chatCall('f2', 'project_context'), { role: 'tool', tool_call_id: 'f2', content: fileContent },
    chatCall('f3', 'project_list'), { role: 'tool', tool_call_id: 'f3', content: fileContent },
    chatCall('q1', 'ask_user'), { role: 'tool', tool_call_id: 'q1', content: askAnswer },
    chatCall('p2', 'click'), { role: 'tool', tool_call_id: 'p2', content: page2 },
    chatCall('p3', 'scroll'), { role: 'tool', tool_call_id: 'p3', content: page3 },
  ];
  compactChatMessages(chatMessages);
  const chatResult = (id) => chatMessages.find((m) => m.tool_call_id === id).content;
  assert.match(chatResult('p1'), /\[older page state trimmed\]/, 'oldest page observation is trimmed');
  assert.equal(chatResult('f1'), fileContent, 'project_read is never trimmed');
  assert.equal(chatResult('f2'), fileContent, 'project_context is never trimmed');
  assert.equal(chatResult('f3'), fileContent, 'project_list is never trimmed');
  assert.equal(chatResult('q1'), askAnswer, 'ask_user is never trimmed');
  assert.equal(chatResult('p2'), page2, 'second newest page observation stays full');
  assert.equal(chatResult('p3'), page3, 'newest page observation stays full');

  // 2. Anthropic Messages
  const anthropicMessages = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'p1', name: 'read_page', input: {} },
        { type: 'tool_use', id: 'f1', name: 'project_read', input: {} },
        { type: 'tool_use', id: 'q1', name: 'ask_user', input: {} },
        { type: 'tool_use', id: 'p2', name: 'click', input: {} },
        { type: 'tool_use', id: 'p3', name: 'scroll', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'p1', content: [{ type: 'text', text: page1 }] },
        { type: 'tool_result', tool_use_id: 'f1', content: [{ type: 'text', text: fileContent }] },
        { type: 'tool_result', tool_use_id: 'q1', content: [{ type: 'text', text: askAnswer }] },
        { type: 'tool_result', tool_use_id: 'p2', content: [{ type: 'text', text: page2 }] },
        { type: 'tool_result', tool_use_id: 'p3', content: [{ type: 'text', text: page3 }] },
      ],
    },
  ];
  compactAnthropicMessages(anthropicMessages);
  const anthResult = (id) => anthropicMessages[1].content.find((b) => b.tool_use_id === id).content[0].text;
  assert.match(anthResult('p1'), /\[older page state trimmed\]/);
  assert.equal(anthResult('f1'), fileContent);
  assert.equal(anthResult('q1'), askAnswer);
  assert.equal(anthResult('p2'), page2);
  assert.equal(anthResult('p3'), page3);

  // 3. OpenAI Responses
  const responsesInput = [
    { type: 'function_call', call_id: 'p1', name: 'read_page', arguments: '{}' },
    { type: 'function_call_output', call_id: 'p1', output: page1 },
    { type: 'function_call', call_id: 'f1', name: 'project_read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'f1', output: fileContent },
    { type: 'function_call', call_id: 'q1', name: 'ask_user', arguments: '{}' },
    { type: 'function_call_output', call_id: 'q1', output: askAnswer },
    { type: 'function_call', call_id: 'p2', name: 'click', arguments: '{}' },
    { type: 'function_call_output', call_id: 'p2', output: page2 },
    { type: 'function_call', call_id: 'p3', name: 'scroll', arguments: '{}' },
    { type: 'function_call_output', call_id: 'p3', output: page3 },
  ];
  compactResponsesInput(responsesInput);
  const respResult = (id) => responsesInput.find((i) => i.type === 'function_call_output' && i.call_id === id).output;
  assert.match(respResult('p1'), /\[older page state trimmed\]/);
  assert.equal(respResult('f1'), fileContent);
  assert.equal(respResult('q1'), askAnswer);
  assert.equal(respResult('p2'), page2);
  assert.equal(respResult('p3'), page3);
});

test('shared trimming trims older fast-layer page snapshots while keeping fast actions, hints, and latest two observations', () => {
  const fast1 = makeFastEscalation(1);
  const fast2 = makeFastEscalation(2);
  const page3 = longText('PAGE_THREE');

  // 1. OpenAI Chat Completions
  const chatMessages = [
    { role: 'user', content: fast1 },
    { role: 'user', content: fast2 },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'p3', type: 'function', function: { name: 'read_page', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'p3', content: page3 },
  ];
  compactChatMessages(chatMessages);
  assert.match(chatMessages[0].content, /\[older page state trimmed\]/, 'older fast-layer snapshot is trimmed');
  assert.match(chatMessages[0].content, /FAST LAYER ACTIONS/, 'fast actions prefix stays');
  assert.match(chatMessages[0].content, /FAST LAYER HINTS/, 'fast hints suffix stays');
  assert.doesNotMatch(chatMessages[1].content, /\[older page state trimmed\]/, 'second newest observation (fast2) stays full');
  assert.equal(chatMessages[3].content, page3, 'newest observation (p3) stays full');

  // 2. Anthropic Messages
  const anthropicMessages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: fast1 },
        { type: 'text', text: fast2 },
        { type: 'text', text: makeFastEscalation(3) },
      ],
    },
  ];
  compactAnthropicMessages(anthropicMessages);
  assert.match(anthropicMessages[0].content[0].text, /\[older page state trimmed\]/);
  assert.doesNotMatch(anthropicMessages[0].content[1].text, /\[older page state trimmed\]/);
  assert.doesNotMatch(anthropicMessages[0].content[2].text, /\[older page state trimmed\]/);

  // 3. OpenAI Responses
  const responsesInput = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: fast1 }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: fast2 }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: makeFastEscalation(3) }] },
  ];
  compactResponsesInput(responsesInput);
  assert.match(responsesInput[0].content[0].text, /\[older page state trimmed\]/);
  assert.doesNotMatch(responsesInput[1].content[0].text, /\[older page state trimmed\]/);
  assert.doesNotMatch(responsesInput[2].content[0].text, /\[older page state trimmed\]/);

  assert.ok(estimateConversationChars(chatMessages) > 1000);
});
