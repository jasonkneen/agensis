import { getSetting } from '@/lib/settings';

export type InterfaceSoundKind = 'tap' | 'toggleOn' | 'toggleOff';

let context: AudioContext | undefined;
let lastPlayed = -Infinity;

function muted(): boolean {
  try {
    return !getSetting('ui_interface_sounds');
  } catch {
    return true;
  }
}

/** Suspend the shared context when the user mutes, so nothing lingers. */
export function onInterfaceSoundsChanged(enabled: boolean): void {
  if (!enabled && context) void context.suspend().catch(() => {});
}

/**
 * A very short oscillator blip. No audio assets: a 25ms tap, or a 90ms
 * rising/falling chirp for switches. Rate-limited so a burst of clicks never
 * stacks into a buzz.
 */
export async function playInterfaceSound(kind: InterfaceSoundKind = 'tap'): Promise<void> {
  if (muted() || typeof AudioContext === 'undefined' || performance.now() - lastPlayed < 60) return;
  lastPlayed = performance.now();
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') await context.resume();
    if (muted()) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    const duration = kind === 'tap' ? 0.025 : 0.09;
    oscillator.frequency.setValueAtTime(kind === 'tap' ? 1300 : kind === 'toggleOn' ? 520 : 780, now);
    oscillator.frequency.exponentialRampToValueAtTime(kind === 'toggleOff' ? 420 : 880, now + duration);
    gain.gain.setValueAtTime(0.035, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(now);
    oscillator.stop(now + duration);
  } catch {
    /* Audio may be unavailable or blocked by the browser's autoplay policy. */
  }
}
