// On-device AI summary + translation for the record page, using Chrome's
// built-in AI APIs (Summarizer / Translator, Chrome 138+). Strictly a
// progressive enhancement: no server, no API keys, and the panel never
// appears in browsers without the APIs. The model runs locally; the first
// use may download it (which is why creation is gated on a user click).
//
// Model output is untrusted-ish text — rendered via textContent only (bullet
// lines become <li> nodes, never innerHTML).

const MIN_CHARS = 400;
const MAX_CHARS = 20000;

document.addEventListener('gentou:rendered', () => {
  init().catch(() => { /* enhancement only */ });
}, { once: true });

async function init() {
  if (!('Summarizer' in self)) return;
  const prose = document.querySelector('.gentou-prose');
  const text = prose?.textContent?.trim();
  if (!text || text.length < MIN_CHARS) return;

  try {
    if ((await Summarizer.availability()) === 'unavailable') return;
  } catch { return; }

  const panel = document.getElementById('ai-summary');
  const body = document.getElementById('ai-summary-body');
  const summarizeBtn = document.getElementById('ai-summarize');
  const translateBtn = document.getElementById('ai-translate');
  if (!panel || !body || !summarizeBtn) return;

  body.textContent = 'Summarize this document with your browser’s on-device model.';
  panel.hidden = false;

  let summaryText = '';

  const renderBullets = (raw) => {
    body.textContent = '';
    body.classList.remove('muted');
    const lines = String(raw).split('\n').map((l) => l.trim()).filter(Boolean);
    const ul = document.createElement('ul');
    for (const line of lines) {
      const li = document.createElement('li');
      li.textContent = line.replace(/^[-*•]\s*/, '');
      ul.append(li);
    }
    body.append(ul);
  };

  summarizeBtn.addEventListener('click', async () => {
    summarizeBtn.disabled = true;
    body.classList.add('muted');
    body.textContent = 'Summarizing on this device… (the model may download first)';
    try {
      const summarizer = await Summarizer.create({
        type: 'key-points',
        format: 'plain-text',
        length: 'medium',
      });
      summaryText = await summarizer.summarize(text.slice(0, MAX_CHARS));
      renderBullets(summaryText);
      summarizer.destroy?.();
      // Offer translation of the summary when the Translator API exists and
      // the UI language differs from English (the models' strongest source).
      const target = (navigator.language || 'en').slice(0, 2);
      if ('Translator' in self && target !== 'en' && translateBtn) {
        translateBtn.hidden = false;
      }
    } catch (err) {
      body.classList.add('muted');
      body.textContent = `summary unavailable: ${err && err.message ? err.message : err}`;
      summarizeBtn.disabled = false;
    }
  });

  translateBtn?.addEventListener('click', async () => {
    if (!summaryText) return;
    translateBtn.disabled = true;
    try {
      const target = (navigator.language || 'en').slice(0, 2);
      const translator = await Translator.create({
        sourceLanguage: 'en',
        targetLanguage: target,
      });
      renderBullets(await translator.translate(summaryText));
      translator.destroy?.();
    } catch (err) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = `translation unavailable: ${err && err.message ? err.message : err}`;
      body.append(note);
      translateBtn.disabled = false;
    }
  });
}
