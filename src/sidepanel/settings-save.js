// Panel settings have three writers: the form, language, and quick model.
// Queue functional mutations so each sees the latest successful worker reply.
export function createSettingsSaver({ getSettings, onSaved, save }) {
  let tail = Promise.resolve();
  return (mutate) => {
    const run = tail.catch(() => {}).then(async () => {
      const current = getSettings();
      const next = mutate(current);
      if (next === current) return current;
      const saved = await save(next);
      onSaved(saved);
      return saved;
    });
    tail = run;
    return run;
  };
}

/** Capture only edited fields, then apply them to the latest saved snapshot. */
export function settingsEdits(base, draft) {
  const edits = [];
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  function collect(before, after, prefix = []) {
    for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after)])) {
      const value = after[key];
      const path = [...prefix, key];
      if (!Object.hasOwn(after, key)) edits.push({ path, remove: true });
      else if (object(value) && object(before?.[key])) collect(before[key], value, path);
      else if (JSON.stringify(before?.[key]) !== JSON.stringify(value)) edits.push({ path, value: structuredClone(value) });
    }
  }
  collect(base, draft);
  return (current) => {
    if (!edits.length) return current;
    const next = structuredClone(current);
    for (const { path, value, remove } of edits) {
      let node = next;
      for (const key of path.slice(0, -1)) node = node[key] ??= {};
      if (remove) delete node[path.at(-1)];
      else node[path.at(-1)] = structuredClone(value);
    }
    return next;
  };
}
