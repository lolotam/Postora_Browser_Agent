// Placeholder for the Node built-ins pi-ai's OAuth flows import. The extension
// runs in a browser, so a flow that reaches one of them has taken a path this
// build cannot serve; it fails loudly instead of silently misbehaving.

function unavailable(name) {
  throw new Error(`${name} is not available in the extension`);
}

export function createServer() {
  return unavailable('node:http');
}

export function randomBytes() {
  return unavailable('node:crypto');
}

export function readFileSync() {
  return unavailable('node:fs');
}
