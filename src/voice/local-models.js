export const LOCAL_MODELS = Object.freeze({
  'local-nemotron': { label: 'Nemotron Streaming 3.5', endpoint: '', model: 'nemotron-3.5-q8_0' },
  'local-whisper': { label: 'Whisper Base', endpoint: '', model: 'base' },
});

export function normalizeLocal(config) {
  if (!config) return config;
  if (config.provider === 'local') {
    return { ...config, provider: 'local-nemotron', ...LOCAL_MODELS['local-nemotron'] };
  }
  if (Object.hasOwn(LOCAL_MODELS, config.provider)) {
    return { ...config, endpoint: '', model: config.model || LOCAL_MODELS[config.provider].model };
  }
  return { ...config };
}

export const isLocalProvider = (provider) => Object.hasOwn(LOCAL_MODELS, provider);
