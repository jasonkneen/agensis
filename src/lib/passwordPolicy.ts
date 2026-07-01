// Single source of truth for the app's password-complexity policy.
//
// SECURITY NOTE — this module is used for CLIENT-SIDE UX guards (strength
// hints, inline errors) and is trivially bypassable from the browser
// (devtools, direct API calls, disabling JS). The real enforcement lives
// server-side (see server/index.cjs and shared/backend-core.mjs's
// `evaluatePasswordServerSide`, which re-implements this same rule in plain
// JS so both backends can apply it without a framework/runtime dependency).
// Keep the two in sync if this policy changes.

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MIN_CLASSES = 3; // at least 3 of: lowercase, uppercase, digit, symbol

export interface PasswordPolicyResult {
  valid: boolean;
  classesMet: number;
  longEnough: boolean;
  /** Human-readable label for the strength hint. */
  label: 'Too short' | 'Weak' | 'Fair' | 'Strong';
  /** Inline error to show when invalid (empty when valid or password blank). */
  message: string;
}

export function evaluatePassword(password: string): PasswordPolicyResult {
  const classesMet =
    (/[a-z]/.test(password) ? 1 : 0) +
    (/[A-Z]/.test(password) ? 1 : 0) +
    (/[0-9]/.test(password) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(password) ? 1 : 0);
  const longEnough = password.length >= PASSWORD_MIN_LENGTH;
  const valid = longEnough && classesMet >= PASSWORD_MIN_CLASSES;

  let label: PasswordPolicyResult['label'];
  if (!longEnough) label = 'Too short';
  else if (classesMet >= 4) label = 'Strong';
  else if (classesMet >= PASSWORD_MIN_CLASSES) label = 'Fair';
  else label = 'Weak';

  let message = '';
  if (password.length > 0 && !valid) {
    if (!longEnough) {
      message = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
    } else {
      message = `Password must include at least ${PASSWORD_MIN_CLASSES} of: lowercase, uppercase, number, symbol.`;
    }
  }

  return { valid, classesMet, longEnough, label, message };
}
