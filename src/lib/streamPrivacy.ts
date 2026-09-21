import { containsRedactedSecret, redactSecrets } from './feedbackRedaction';

const PATH = /(?:\/(?:Users|home|root|etc|private|var|tmp|opt|Volumes)\/[^\s<>"']+|[A-Za-z]:\\[^\s<>"']+|~\/[^\s<>"']+)/g;
export function redactStreamText(value: string) {
  return redactSecrets(value).replace(PATH, '[private path]');
}
export function sensitiveStreamText(value: string) {
  return containsRedactedSecret(value) || redactStreamText(value) !== value;
}
export function setStreamPrivacy(active: boolean) {
  document.documentElement.toggleAttribute('data-stream-mode', active);
  try { if (active) localStorage.setItem('agensis-stream-privacy', '1'); else localStorage.removeItem('agensis-stream-privacy'); } catch { /* visual protection does not depend on storage */ }
}
// Visual protection for this DOM only, not a universal secret detector or a way
// to scrub other applications. Never rewrite React-owned text nodes or input values.
export function installStreamPrivacy() {
  setStreamPrivacy(Boolean(window.electronAPI?.broadcast)); // Protect before first paint/reconnect.
  const inspect = (root: Element) => {
    if (!document.documentElement.hasAttribute('data-stream-mode')) return;
    const nodes = [root, ...root.querySelectorAll('*')];
    for (const element of nodes) {
      if (element.matches('script,style,button,label,option') || element.closest('[data-broadcast-controls]')) continue;
      const text = Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent || '').join('');
      element.toggleAttribute('data-stream-private-text', sensitiveStreamText(text));
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const name = `${element.name} ${element.id} ${element.autocomplete}`;
        element.toggleAttribute('data-stream-private-input', /key|secret|token|password|credential|path|folder/i.test(name) || sensitiveStreamText(element.value));
      }
    }
  };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData') { if (record.target.parentElement) inspect(record.target.parentElement); }
      else if (record.type === 'childList') {
        if (record.target instanceof Element) inspect(record.target);
      } else if (record.target === document.documentElement) inspect(document.body);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-stream-mode'] });
  const input = (event: Event) => { if (event.target instanceof Element) inspect(event.target); };
  document.addEventListener('input', input, true); inspect(document.body);
  return () => { observer.disconnect(); document.removeEventListener('input', input, true); };
}
