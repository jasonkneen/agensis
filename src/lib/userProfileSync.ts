// Profile edits can be made from an AccountDialog while several chat windows
// each hold their own useUserProfile instance. This tiny bus makes that one
// server result authoritative across the tab instead of leaving every other
// hook with a stale copy. BroadcastChannel carries the same invalidation to
// sibling tabs; the storage pulse is a fallback for browsers/webviews without
// BroadcastChannel support and is removed immediately rather than persisted.

export interface UserProfileSyncValue {
  id?: string;
  email?: string;
  display_name?: string;
  accent_color?: string;
  share_read_receipts?: boolean;
  created_at?: string;
}

export interface UserProfileSyncEvent {
  userId: string;
  profile?: UserProfileSyncValue;
  patch?: UserProfileSyncValue;
}

type Listener = (event: UserProfileSyncEvent) => void;

const CHANNEL_NAME = 'agensis:user-profile';
const STORAGE_KEY = 'agensis:user-profile-sync';
const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;
let storageListening = false;

function validEvent(value: unknown): value is UserProfileSyncEvent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<UserProfileSyncEvent>;
  return typeof candidate.userId === 'string' && candidate.userId.length > 0
    && (Boolean(candidate.profile && typeof candidate.profile === 'object')
      || Boolean(candidate.patch && typeof candidate.patch === 'object'));
}

function emit(event: UserProfileSyncEvent) {
  for (const listener of Array.from(listeners)) listener(event);
}

function onStorage(event: StorageEvent) {
  if (event.key !== STORAGE_KEY || !event.newValue) return;
  try {
    const parsed = JSON.parse(event.newValue) as unknown;
    if (validEvent(parsed)) emit(parsed);
  } catch {
    // A malformed cross-tab pulse is not profile state and is ignored.
  }
}

function ensureCrossTabListener() {
  if (typeof BroadcastChannel !== 'undefined' && !channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (message: MessageEvent<unknown>) => {
      if (validEvent(message.data)) emit(message.data);
    };
  }
  if (typeof window !== 'undefined' && !storageListening) {
    window.addEventListener('storage', onStorage);
    storageListening = true;
  }
}

function releaseCrossTabListener() {
  if (listeners.size > 0) return;
  channel?.close();
  channel = null;
  if (typeof window !== 'undefined' && storageListening) {
    window.removeEventListener('storage', onStorage);
    storageListening = false;
  }
}

export function subscribeUserProfileSync(listener: Listener): () => void {
  listeners.add(listener);
  ensureCrossTabListener();
  return () => {
    listeners.delete(listener);
    releaseCrossTabListener();
  };
}

export function publishUserProfileSync(event: UserProfileSyncEvent): void {
  if (!validEvent(event)) return;
  emit(event);
  try {
    channel?.postMessage(event);
  } catch {
    // Same-tab delivery already happened. Cross-tab sync is best-effort.
  }
  if (!channel && typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(event));
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage can be disabled or full; same-tab delivery still stands.
    }
  }
}
