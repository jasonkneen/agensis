const config = window.CursorBuddyAppConfig || {};

const signup = document.querySelector('#signup');
const status = document.querySelector('#signupStatus');

function backendUrl(path) {
  const base = String(config.backendBaseUrl || '').replace(/\/$/, '');
  return `${base}${path}`;
}

function setStatus(message) {
  if (status) status.textContent = message;
}

signup?.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(signup);
  const email = String(data.get('email') || '').trim();
  if (!email) {
    setStatus('Add an email to preview the account flow.');
    return;
  }
  setStatus(`Ready to call ${backendUrl('/backend/auth/signup')} for ${email}.`);
});

document.documentElement.dataset.backendMode = config.backendBaseUrl ? 'external' : 'proxied';
