// Code and URLs must not decide the direction of the surrounding prose.
export function contentDirection(text) {
  const prose = String(text ?? '').replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/https?:\/\/\S+/g, '');
  return /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(prose) ? 'rtl' : 'auto';
}
