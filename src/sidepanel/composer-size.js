/** Fit the draft to its content, keeping the toolbar reachable on short panels. */
export function bindComposerSize(input) {
  function resize() {
    if (!input.getClientRects().length) return; // Retry when its screen is visible.
    const previous = input.getBoundingClientRect().height;
    const transition = input.style.transition;
    input.style.transition = 'none';
    input.style.height = '0px';
    const height = input.scrollHeight;
    input.style.height = `${previous}px`;
    // Commit the old height before the CSS transition to the content height.
    void input.offsetHeight;
    input.style.transition = transition;
    input.style.height = `${height}px`;
  }
  input.addEventListener('input', resize);
  let width = -1;
  const observer = new ResizeObserver(([entry]) => {
    if (entry.contentRect.width === width) return;
    width = entry.contentRect.width;
    resize();
  });
  observer.observe(input);
  resize();
  return resize;
}
