// Inline autocomplete above the composer for `/` commands and `@` project files.

export const SLASH_COMMANDS = [
  { id: '/compact', label: '/compact', insert: '/compact ', descriptionKey: 'chat.compactHint' },
];

/**
 * Parses the active autocomplete token at the end of the text (or before the cursor).
 * Returns `{ kind: 'slash' | 'file', query, directory, prefix, tokenStart, tokenEnd }` or `null`.
 */
export function parseAutocompleteTrigger(text, cursor = text.length) {
  const before = String(text ?? '').slice(0, cursor);
  const slashMatch = /^\s*(\/[a-z-]*)$/i.exec(before);
  if (slashMatch) {
    const token = slashMatch[1];
    const tokenStart = before.length - token.length;
    return {
      kind: 'slash',
      query: token.slice(1).toLowerCase(),
      tokenStart,
      tokenEnd: cursor,
    };
  }
  const fileMatch = /(?:^|\s)@(?:"([^"]*)|([^\s"]*))$/.exec(before);
  if (fileMatch) {
    const quoted = fileMatch[1] !== undefined;
    const raw = quoted ? fileMatch[1] : fileMatch[2];
    const tokenStart = before.length - raw.length - (quoted ? 2 : 1);
    const slashIdx = raw.lastIndexOf('/');
    const directory = slashIdx === -1 ? '.' : (raw.slice(0, slashIdx) || '.');
    const prefix = slashIdx === -1 ? raw : raw.slice(slashIdx + 1);
    return {
      kind: 'file',
      query: raw,
      directory,
      prefix,
      tokenStart,
      tokenEnd: cursor,
    };
  }
  return null;
}

export function createComposerAutocomplete({ input, list, getSessionId, getProject, request, t, resize }) {
  let items = [];
  let activeIndex = 0;
  let trigger = null;
  let loadSeq = 0;

  function hide() {
    loadSeq += 1;
    items = [];
    activeIndex = 0;
    trigger = null;
    if (list) {
      list.hidden = true;
      list.replaceChildren();
    }
  }

  function render() {
    if (!list) return;
    if (!items.length || !trigger) {
      list.hidden = true;
      list.replaceChildren();
      return;
    }
    list.hidden = false;
    list.replaceChildren(...items.map((item, idx) => {
      const li = list.ownerDocument.createElement('li');
      const btn = list.ownerDocument.createElement('button');
      btn.type = 'button';
      btn.className = idx === activeIndex ? 'suggest-item active' : 'suggest-item';
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', idx === activeIndex ? 'true' : 'false');
      const label = list.ownerDocument.createElement('span');
      label.className = 'suggest-label';
      label.dir = 'ltr';
      label.textContent = item.label;
      btn.append(label);
      if (item.description) {
        const desc = list.ownerDocument.createElement('small');
        desc.className = 'suggest-desc muted';
        desc.dir = 'auto';
        desc.textContent = item.description;
        btn.append(desc);
      }
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => applyItem(item));
      li.append(btn);
      return li;
    }));
  }

  function currentTrigger() {
    const cursor = typeof input.selectionStart === 'number' ? input.selectionStart : String(input.value ?? '').length;
    return parseAutocompleteTrigger(input.value, cursor);
  }

  function matchesActiveTrigger(nextTrigger) {
    return Boolean(
      trigger
      && nextTrigger
      && trigger.kind === nextTrigger.kind
      && trigger.query === nextTrigger.query
      && trigger.tokenStart === nextTrigger.tokenStart
      && trigger.tokenEnd === nextTrigger.tokenEnd
    );
  }

  function applyItem(item) {
    if (!trigger) return false;
    const liveTrigger = currentTrigger();
    if (!matchesActiveTrigger(liveTrigger)) {
      void update();
      return false;
    }
    const value = String(input.value ?? '');
    const before = value.slice(0, trigger.tokenStart);
    const after = value.slice(trigger.tokenEnd);
    input.value = `${before}${item.insert}${after}`;
    const nextCursor = before.length + item.insert.length;
    input.setSelectionRange?.(nextCursor, nextCursor);
    resize?.();
    input.focus?.();
    if (item.keepOpen) {
      void update();
    } else {
      hide();
    }
    return true;
  }

  async function update() {
    const nextTrigger = currentTrigger();
    if (!nextTrigger) {
      hide();
      return;
    }
    const seq = ++loadSeq;
    if (nextTrigger.kind === 'slash') {
      trigger = nextTrigger;
      items = SLASH_COMMANDS
        .filter((cmd) => cmd.id.slice(1).startsWith(nextTrigger.query))
        .map((cmd) => ({
          id: cmd.id,
          label: cmd.label,
          insert: cmd.insert,
          description: t ? t(cmd.descriptionKey) : '',
        }));
      activeIndex = 0;
      render();
      return;
    }
    // `@` file autocomplete: only when a project is linked and a non-empty query is typed
    // (a bare `@` opens the project file chooser dialog in project.js).
    const project = getProject?.();
    if (!project || !nextTrigger.query) {
      hide();
      return;
    }
    trigger = nextTrigger;
    items = [];
    activeIndex = 0;
    render();
    const sessionId = getSessionId?.();
    try {
      const data = await request('project-list-ui', { sessionId, path: nextTrigger.directory });
      if (seq !== loadSeq || sessionId !== getSessionId?.()) return;
      const needle = nextTrigger.prefix.toLowerCase();
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      items = entries
        .filter((entry) => !needle || String(entry.name ?? '').toLowerCase().includes(needle))
        .slice(0, 8)
        .map((entry) => {
          const relPath = nextTrigger.directory === '.' ? entry.name : `${nextTrigger.directory}/${entry.name}`;
          const dirInsert = /\s/.test(relPath) ? `@"${relPath}/` : `@${relPath}/`;
          return {
            id: relPath,
            label: `${entry.directory ? '▱' : '@'} ${relPath}`,
            insert: entry.directory ? dirInsert : `@${JSON.stringify(relPath)} `,
            keepOpen: Boolean(entry.directory),
          };
        });
      activeIndex = 0;
      render();
    } catch {
      if (seq === loadSeq) hide();
    }
  }

  function onKeyDown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (!items.length || list?.hidden) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      render();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      render();
      return;
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      if (!matchesActiveTrigger(currentTrigger())) {
        void update();
        return;
      }
      event.preventDefault();
      applyItem(items[activeIndex]);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hide();
    }
  }

  input?.addEventListener?.('input', () => { void update(); });
  input?.addEventListener?.('keydown', onKeyDown);

  return {
    update,
    hide,
    isOpen: () => Boolean(list && !list.hidden && items.length > 0),
    items: () => [...items],
    pickIndex: (index) => (items[index] ? applyItem(items[index]) : false),
  };
}
