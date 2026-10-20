// Restore the device's choice before the stylesheet paints the page.
(() => {
  const key = 'wingfactor-chat-theme';
  const normalize = value => value === 'dark' ? 'dark' : 'normal';
  function apply(value) {
    const theme = normalize(value);
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme === 'dark' ? 'only dark' : 'only light');
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
    });
    return theme;
  }
  let saved;
  try { saved = localStorage.getItem(key); } catch { /* Private browsers can block storage. */ }
  apply(saved);
  document.addEventListener('click', event => {
    const button = event.target.closest?.('button[data-theme-choice]');
    if (!button) return;
    const theme = apply(button.dataset.themeChoice);
    try { localStorage.setItem(key, theme); } catch { /* The current page still changes. */ }
  });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) apply(event.newValue);
  });
})();
