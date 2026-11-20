// Approximate context windows per model family, in input tokens. Providers
// advertise exact numbers per model version; these buckets stay deliberately
// coarse and conservative, because the estimate drives a percentage bar and
// an early-compaction guard, not a hard limit.
const RULES = [
  [/^gpt-5/i, 400000],
  [/^gpt-4\.1/i, 1000000],
  [/^gpt-4/i, 128000],
  [/^o[134](?![a-z])/i, 200000],
  [/^claude-(opus|sonnet|haiku)/i, 200000],
  [/^gemini/i, 1000000],
  [/^grok-[34]/i, 256000],
  [/^kimi-k/i, 256000],
  [/^glm/i, 200000],
  [/^minimax/i, 1000000],
  [/^deepseek/i, 128000],
  [/^qwen/i, 262144],
  [/nemotron/i, 128000],
  [/^apodex/i, 128000],
];

// The conservative answer for a model this table does not know.
const DEFAULT_WINDOW = 128000;

export function contextWindowFor(model = '') {
  const name = String(model ?? '');
  for (const [pattern, window] of RULES) {
    if (pattern.test(name)) return window;
  }
  return DEFAULT_WINDOW;
}
