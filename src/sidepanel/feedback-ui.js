import { FEEDBACK_FORM_ID, afterDismissal, afterRating, sendFeedback, shouldAskForRating } from '../lib/feedback.js';

/**
 * Feedback menu and post-task rating prompt for the side panel.
 */
export function createFeedbackUi({
  $,
  document = globalThis.document,
  chrome = globalThis.chrome,
  t,
  currentLanguage,
  getAccount = () => null,
  addCard,
  closeIconButton,
  closeOtherMenus = () => {},
  formId = FEEDBACK_FORM_ID,
  send = sendFeedback,
}) {
  const storeReviewsUrl = `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`;
  // Store installs carry update_url; an unpacked copy has no store page to review.
  const fromStore = Boolean(chrome.runtime.getManifest().update_url);
  let feedbackRating = 0;

  async function ratingState() {
    try {
      return (await chrome.storage.local.get('reviewPrompt')).reviewPrompt ?? {};
    } catch {
      return {};
    }
  }

  async function saveRatingState(change) {
    await chrome.storage.local.set({ reviewPrompt: change(await ratingState()) });
  }

  /** Five star buttons; picking one calls onPick(n) and lights the stars up to n. */
  function starRow(onPick) {
    const row = document.createElement('div');
    row.className = 'stars';
    for (let n = 1; n <= 5; n += 1) {
      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'star';
      star.textContent = '★';
      star.setAttribute('aria-label', t('rate.star', { n }));
      star.addEventListener('click', () => {
        row.querySelectorAll('.star').forEach((s, i) => s.classList.toggle('on', i < n));
        return onPick(n);
      });
      row.append(star);
    }
    return row;
  }

  /** A signed-in user's feedback carries their Google email unless they typed another. */
  function feedbackFields(message, rating, email = '') {
    const account = getAccount();
    return {
      message,
      rating,
      email: email || account?.email || '',
      version: chrome.runtime.getManifest().version,
      language: currentLanguage(),
    };
  }

  function textLine(text) {
    return Object.assign(document.createElement('span'), { textContent: text });
  }

  async function submitFeedback({ message, rating, email = '' }, status, onSent) {
    if (!message && !rating) {
      status.textContent = t('feedback.empty');
      return;
    }
    if (!formId) {
      status.textContent = t('feedback.notConfigured');
      return;
    }
    status.textContent = t('feedback.sending');
    try {
      await send(feedbackFields(message, rating, email));
      onSent();
    } catch (err) {
      status.textContent = `✗ ${err.message}`;
    }
  }

  async function rated(stars, body, close) {
    close.remove();
    await saveRatingState(afterRating);
    if (stars === 5) {
      body.replaceChildren(textLine(t('rate.thanks')));
      if (fromStore) {
        const link = Object.assign(document.createElement('a'), {
          href: storeReviewsUrl,
          target: '_blank',
          rel: 'noopener',
          textContent: t('rate.store'),
        });
        body.append(link);
      }
      if (formId) send(feedbackFields('', 5)).catch(() => {}); // a bare 5★ is a nice-to-know, not worth an error
      return;
    }
    const text = Object.assign(document.createElement('textarea'), {
      rows: 3,
      dir: 'auto',
      placeholder: t('rate.better'),
    });
    const status = Object.assign(document.createElement('small'), { className: 'muted' });
    const sendBtn = Object.assign(document.createElement('button'), {
      type: 'button',
      className: 'primary',
      textContent: t('feedback.send'),
    });
    sendBtn.addEventListener('click', () =>
      submitFeedback({ message: text.value.trim(), rating: stars }, status, () =>
        body.replaceChildren(textLine(t('feedback.sent'))),
      ),
    );
    const actions = document.createElement('div');
    actions.className = 'row between';
    actions.append(status, sendBtn);
    body.replaceChildren(text, actions);
    text.focus();
  }

  async function askForRating() {
    if (!shouldAskForRating(await ratingState())) return;
    const card = addCard('msg rate-card', '');
    const question = document.createElement('span');
    question.textContent = t('rate.question');
    const close = closeIconButton(t('rate.dismiss'), async () => {
      card.remove();
      await saveRatingState(afterDismissal);
    });
    const head = document.createElement('div');
    head.className = 'row between';
    head.append(question, close);
    const body = document.createElement('div');
    body.className = 'fields';
    card.append(head, starRow((n) => rated(n, body, close)), body);
  }

  function toggleFeedbackMenu() {
    const opening = $('feedbackMenu').hidden;
    closeOtherMenus();
    $('feedbackMenu').hidden = !opening;
    if (!opening) return;
    feedbackRating = 0;
    $('feedbackStars').replaceWith(
      Object.assign(
        starRow((n) => {
          feedbackRating = n;
        }),
        { id: 'feedbackStars' },
      ),
    );
    $('feedbackStatus').textContent = '';
    const account = getAccount();
    if (account && !$('feedbackEmail').value) $('feedbackEmail').value = account.email;
    $('feedbackText').focus();
  }

  $('feedbackBtn').addEventListener('click', toggleFeedbackMenu);
  $('feedbackSend').addEventListener('click', () =>
    submitFeedback(
      {
        message: $('feedbackText').value.trim(),
        rating: feedbackRating,
        email: $('feedbackEmail').value.trim(),
      },
      $('feedbackStatus'),
      () => {
        $('feedbackText').value = '';
        $('feedbackStatus').textContent = t('feedback.sent');
      },
    ),
  );
  document.addEventListener('click', (e) => {
    if (
      !$('feedbackMenu').hidden &&
      !$('feedbackMenu').contains(e.target) &&
      !$('feedbackBtn').contains(e.target)
    ) {
      $('feedbackMenu').hidden = true;
    }
  });

  return { askForRating, toggleFeedbackMenu, submitFeedback, starRow };
}
