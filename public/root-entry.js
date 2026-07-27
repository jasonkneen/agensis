(function () {
  var location = window.location;
  var isPublicSite = location.hostname === 'agensis.io' || location.hostname === 'www.agensis.io';
  if (!isPublicSite) return;

  var script = document.currentScript;
  var entryKind = script && script.dataset ? script.dataset.entryKind : '';
  var path = location.pathname;
  var isRootShell = path === '/' || path === '/index.html';
  var isLandingPage = path === '/landing/index.html';
  if (!isRootShell && !isLandingPage) return;

  var query = new URLSearchParams(location.search);
  var hash = new URLSearchParams(location.hash.slice(1));
  var callbackKeys = [
    'access_token',
    'confirmation_token',
    'recovery_token',
    'invite_token',
    'email_change_token',
    'error',
    'error_description',
    'error_code',
  ];
  var hasAuthCallback = callbackKeys.some(function (key) { return hash.has(key); });
  var source = (query.get('source') || query.get('referrer') || '').toLowerCase();
  var intent = (query.get('intent') || '').toLowerCase();
  var hasAppLaunch = query.has('invite')
    || source === 'agensis-cli'
    || source === 'cursorbuddy'
    || intent === 'connect'
    || intent === 'login'
    || intent === 'setup';

  if (hasAuthCallback || hasAppLaunch) {
    location.replace('/app' + location.search + location.hash);
    return;
  }

  if (isRootShell && entryKind === 'app') {
    location.replace('/landing/index.html' + location.search + location.hash);
  }
})();
