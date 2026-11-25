// Minimal, XSS-safe Markdown renderer for the agent's reports.
//
// Inline constructs are tokenized in a single pass so a link destination is
// never re-scanned by the autolinker. Only `http:` and `https:` destinations
// become `<a>` elements; anything else renders as inert text.

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})[c]);

function safeHttpHref(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return rawUrl.trim();
}

const INLINE_TOKEN = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<)]+)/g;

/**
 * Single-pass inline tokenizer returning structured token objects:
 * - `{ type: 'text', text }`
 * - `{ type: 'code', text }`
 * - `{ type: 'strong', text }`
 * - `{ type: 'link', text, href }` (only when `href` is a valid `http(s)` URL)
 */
export function tokenizeInline(text = '') {
  const input = String(text);
  const tokens = [];
  let cursor = 0;
  for (const match of input.matchAll(INLINE_TOKEN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ type: 'text', text: input.slice(cursor, index) });
    }
    const [full, codeText, strongText, linkLabel, linkDest, autoUrl] = match;
    if (codeText !== undefined) {
      tokens.push({ type: 'code', text: codeText });
    } else if (strongText !== undefined) {
      tokens.push({ type: 'strong', text: strongText });
    } else if (linkLabel !== undefined) {
      const href = safeHttpHref(linkDest);
      if (href) {
        tokens.push({ type: 'link', text: linkLabel, href });
      } else {
        tokens.push({ type: 'text', text: full });
      }
    } else if (autoUrl !== undefined) {
      const href = safeHttpHref(autoUrl);
      if (href) {
        tokens.push({ type: 'link', text: autoUrl, href });
      } else {
        tokens.push({ type: 'text', text: full });
      }
    }
    cursor = index + full.length;
  }
  if (cursor < input.length) {
    tokens.push({ type: 'text', text: input.slice(cursor) });
  }
  return tokens;
}

function inlineHtml(text) {
  return tokenizeInline(text).map((tok) => {
    if (tok.type === 'code') return `<code>${escapeHtml(tok.text)}</code>`;
    if (tok.type === 'strong') return `<strong>${escapeHtml(tok.text)}</strong>`;
    if (tok.type === 'link') {
      return `<a href="${escapeHtml(tok.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(tok.text)}</a>`;
    }
    return escapeHtml(tok.text);
  }).join('');
}

function appendInlineDom(parent, doc, text) {
  for (const tok of tokenizeInline(text)) {
    if (tok.type === 'code') {
      const code = doc.createElement('code');
      code.textContent = tok.text;
      parent.appendChild(code);
    } else if (tok.type === 'strong') {
      const strong = doc.createElement('strong');
      strong.textContent = tok.text;
      parent.appendChild(strong);
    } else if (tok.type === 'link') {
      const a = doc.createElement('a');
      a.setAttribute('href', tok.href);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.textContent = tok.text;
      parent.appendChild(a);
    } else if (typeof doc.createTextNode === 'function') {
      parent.appendChild(doc.createTextNode(tok.text));
    } else {
      const span = doc.createElement('span');
      span.textContent = tok.text;
      parent.appendChild(span);
    }
  }
}

function parseBlocks(source = '') {
  const lines = String(source).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let list = null;
  const closeList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^```/.test(line)) {
      closeList();
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      blocks.push({ type: 'codeblock', text: code.join('\n') });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:-]+\|/.test(lines[i + 1] ?? '')) {
      closeList();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++].trim());
      i -= 1;
      const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const [head, , ...body] = rows;
      blocks.push({
        type: 'table',
        head: cells(head),
        body: body.map(cells),
      });
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 2, 6);
      blocks.push({ type: 'heading', level, text: heading[2] });
      continue;
    }
    const item = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (item) {
      const kind = /\d/.test(item[1]) ? 'ol' : 'ul';
      if (!list || list.kind !== kind) {
        closeList();
        list = { type: 'list', kind, items: [] };
      }
      list.items.push(item[2]);
      continue;
    }
    closeList();
    if (line.trim()) blocks.push({ type: 'paragraph', text: line });
  }
  closeList();
  return blocks;
}

/**
 * Builds DOM nodes for the given Markdown source inside `container` (or a new
 * DocumentFragment / div from `doc`) in a single tokenization pass.
 */
export function renderMarkdownToDom(source = '', { document: doc = globalThis.document, container = null } = {}) {
  const root = container ?? (typeof doc?.createDocumentFragment === 'function' ? doc.createDocumentFragment() : doc.createElement('div'));
  for (const block of parseBlocks(source)) {
    if (block.type === 'codeblock') {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = block.text;
      pre.appendChild(code);
      root.appendChild(pre);
    } else if (block.type === 'table') {
      const table = doc.createElement('table');
      const thead = doc.createElement('thead');
      const headRow = doc.createElement('tr');
      for (const cell of block.head) {
        const th = doc.createElement('th');
        appendInlineDom(th, doc, cell);
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      const tbody = doc.createElement('tbody');
      for (const row of block.body) {
        const tr = doc.createElement('tr');
        for (const cell of row) {
          const td = doc.createElement('td');
          appendInlineDom(td, doc, cell);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(thead);
      table.appendChild(tbody);
      root.appendChild(table);
    } else if (block.type === 'heading') {
      const h = doc.createElement(`h${block.level}`);
      appendInlineDom(h, doc, block.text);
      root.appendChild(h);
    } else if (block.type === 'list') {
      const listEl = doc.createElement(block.kind);
      for (const itemText of block.items) {
        const li = doc.createElement('li');
        appendInlineDom(li, doc, itemText);
        listEl.appendChild(li);
      }
      root.appendChild(listEl);
    } else if (block.type === 'paragraph') {
      const p = doc.createElement('p');
      appendInlineDom(p, doc, block.text);
      root.appendChild(p);
    }
  }
  return root;
}

export function renderMarkdown(source = '') {
  const out = [];
  for (const block of parseBlocks(source)) {
    if (block.type === 'codeblock') {
      out.push(`<pre><code>${escapeHtml(block.text)}</code></pre>`);
    } else if (block.type === 'table') {
      const th = block.head.map((c) => `<th>${inlineHtml(c)}</th>`).join('');
      const tr = block.body.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`);
    } else if (block.type === 'heading') {
      out.push(`<h${block.level}>${inlineHtml(block.text)}</h${block.level}>`);
    } else if (block.type === 'list') {
      out.push(`<${block.kind}>${block.items.map((item) => `<li>${inlineHtml(item)}</li>`).join('')}</${block.kind}>`);
    } else if (block.type === 'paragraph') {
      out.push(`<p>${inlineHtml(block.text)}</p>`);
    }
  }
  return out.join('');
}

/**
 * Download name for a report. The session title becomes the file name, with a
 * day, and it always ends in .md. An untitled session is just "report".
 */
export function reportFileName(title, day, untitled = '') {
  const raw = String(title ?? '').trim();
  const base = !raw || raw === untitled ? 'report' : raw;
  const slug = base.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return `${slug || 'report'}-${day}.md`;
}
