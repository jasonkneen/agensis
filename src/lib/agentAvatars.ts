import { blobatarUri } from 'blobatar/uri';

export type AgentAvatarChoice = {
  id: string;
  label: string;
  src: string;
};

/**
 * Automatic avatars are stored as a short marker rather than as an SVG data
 * URI. That keeps agent rows, templates, and .agn bundles small; the SVG is
 * generated locally when an avatar is rendered.
 */
export const BLOBATAR_AVATAR_PREFIX = 'blobatar:';
export const DEFAULT_AGENT_AVATAR = '';
const LEGACY_DEFAULT_AGENT_AVATAR = 'AI';

function avatarSeed(value: string | null | undefined) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/^-+|-+$/g, '');
  return slug || 'agent';
}

export function automaticAgentAvatar(seed: string | null | undefined) {
  return `${BLOBATAR_AVATAR_PREFIX}${avatarSeed(seed)}`;
}

export function isBlobatarAvatar(value: string | null | undefined) {
  return String(value || '').trim().toLowerCase().startsWith(BLOBATAR_AVATAR_PREFIX);
}

/**
 * Bare 1–3 letter text ("CO", "AI") is a placeholder some create paths stored
 * instead of a real avatar; no picker option produces it, so it gets a
 * Blobatar like an empty value rather than rendering as initials.
 */
const PLACEHOLDER_TEXT_AVATAR = /^[\p{L}\p{N}]{1,3}$/u;

/** Empty, legacy `AI`, and bare-initials values are the implicit default, not a manual choice. */
export function isAutomaticAgentAvatar(value: string | null | undefined) {
  const normalized = String(value || '').trim();
  return !normalized
    || normalized.toUpperCase() === LEGACY_DEFAULT_AGENT_AVATAR
    || PLACEHOLDER_TEXT_AVATAR.test(normalized)
    || isBlobatarAvatar(normalized);
}

/** Convert the implicit default to a compact marker while preserving manual avatars verbatim. */
export function resolveAgentAvatar(value: string | null | undefined, seed: string | null | undefined) {
  const normalized = String(value || '').trim();
  return isAutomaticAgentAvatar(normalized) && !isBlobatarAvatar(normalized)
    ? automaticAgentAvatar(seed)
    : normalized;
}

/** Return a renderable local data URI for automatic avatars; all manual values pass through. */
export function renderAgentAvatar(value: string | null | undefined, seed?: string | null) {
  const resolved = resolveAgentAvatar(value, seed);
  if (!isBlobatarAvatar(resolved)) return resolved;
  const markerSeed = resolved.slice(BLOBATAR_AVATAR_PREFIX.length).trim() || avatarSeed(seed);
  return blobatarUri(markerSeed);
}

export const AGENT_AVATAR_CHOICES: AgentAvatarChoice[] = [
  { id: 'set1-fox-hoodie', label: 'Fox hoodie', src: '/agent-avatars/set1-fox-hoodie.png' },
  { id: 'set1-raccoon-denim', label: 'Raccoon denim', src: '/agent-avatars/set1-raccoon-denim.png' },
  { id: 'set1-bear-sweater', label: 'Bear sweater', src: '/agent-avatars/set1-bear-sweater.png' },
  { id: 'set1-rabbit-dress', label: 'Rabbit dress', src: '/agent-avatars/set1-rabbit-dress.png' },
  { id: 'set1-hedgehog-scarf', label: 'Hedgehog scarf', src: '/agent-avatars/set1-hedgehog-scarf.png' },
  { id: 'set1-otter-shirt', label: 'Otter shirt', src: '/agent-avatars/set1-otter-shirt.png' },
  { id: 'set1-deer-satchel', label: 'Deer satchel', src: '/agent-avatars/set1-deer-satchel.png' },
  { id: 'set1-penguin-coat', label: 'Penguin coat', src: '/agent-avatars/set1-penguin-coat.png' },
  { id: 'set1-turtle-hoodie', label: 'Turtle hoodie', src: '/agent-avatars/set1-turtle-hoodie.png' },
  { id: 'set1-frog-formal', label: 'Frog formal', src: '/agent-avatars/set1-frog-formal.png' },
  { id: 'set1-koala-backpack', label: 'Koala backpack', src: '/agent-avatars/set1-koala-backpack.png' },
  { id: 'set1-duck-overalls', label: 'Duck overalls', src: '/agent-avatars/set1-duck-overalls.png' },
  { id: 'set1-panda-bamboo', label: 'Panda bamboo', src: '/agent-avatars/set1-panda-bamboo.png' },
  { id: 'set1-pig-hoodie', label: 'Pig hoodie', src: '/agent-avatars/set1-pig-hoodie.png' },
  { id: 'set1-corgi-bandana', label: 'Corgi bandana', src: '/agent-avatars/set1-corgi-bandana.png' },
  { id: 'set1-cat-sweater', label: 'Cat sweater', src: '/agent-avatars/set1-cat-sweater.png' },
  { id: 'set1-elephant-jacket', label: 'Elephant jacket', src: '/agent-avatars/set1-elephant-jacket.png' },
  { id: 'set1-lion-hoodie', label: 'Lion hoodie', src: '/agent-avatars/set1-lion-hoodie.png' },
  { id: 'set1-wolf-flannel', label: 'Wolf flannel', src: '/agent-avatars/set1-wolf-flannel.png' },
  { id: 'set1-squirrel-acorn', label: 'Squirrel acorn', src: '/agent-avatars/set1-squirrel-acorn.png' },
  { id: 'set2-wolf-vest', label: 'Wolf vest', src: '/agent-avatars/set2-wolf-vest.png' },
  { id: 'set2-dragon-waistcoat', label: 'Dragon waistcoat', src: '/agent-avatars/set2-dragon-waistcoat.png' },
  { id: 'set2-axolotl-hoodie', label: 'Axolotl hoodie', src: '/agent-avatars/set2-axolotl-hoodie.png' },
  { id: 'set2-owl-glasses', label: 'Owl glasses', src: '/agent-avatars/set2-owl-glasses.png' },
  { id: 'set2-beaver-flannel', label: 'Beaver flannel', src: '/agent-avatars/set2-beaver-flannel.png' },
  { id: 'set2-penguin-scarf', label: 'Penguin scarf', src: '/agent-avatars/set2-penguin-scarf.png' },
  { id: 'set2-cow-bandana', label: 'Cow bandana', src: '/agent-avatars/set2-cow-bandana.png' },
  { id: 'set2-badger-jacket', label: 'Badger jacket', src: '/agent-avatars/set2-badger-jacket.png' },
  { id: 'set2-red-panda-wave', label: 'Red panda wave', src: '/agent-avatars/set2-red-panda-wave.png' },
  { id: 'set2-llama-poncho', label: 'Llama poncho', src: '/agent-avatars/set2-llama-poncho.png' },
  { id: 'set2-sloth-satchel', label: 'Sloth satchel', src: '/agent-avatars/set2-sloth-satchel.png' },
  { id: 'set2-hedgehog-overalls', label: 'Hedgehog overalls', src: '/agent-avatars/set2-hedgehog-overalls.png' },
  { id: 'set2-otter-camera', label: 'Otter camera', src: '/agent-avatars/set2-otter-camera.png' },
  { id: 'set2-possum-hoodie', label: 'Possum hoodie', src: '/agent-avatars/set2-possum-hoodie.png' },
  { id: 'set2-chameleon-hoodie', label: 'Chameleon hoodie', src: '/agent-avatars/set2-chameleon-hoodie.png' },
  { id: 'set2-fennec-scarf', label: 'Fennec scarf', src: '/agent-avatars/set2-fennec-scarf.png' },
  { id: 'set2-toucan-coat', label: 'Toucan coat', src: '/agent-avatars/set2-toucan-coat.png' },
  { id: 'set2-capybara-sweater', label: 'Capybara sweater', src: '/agent-avatars/set2-capybara-sweater.png' },
  { id: 'set2-frog-cream', label: 'Frog cream', src: '/agent-avatars/set2-frog-cream.png' },
  { id: 'set2-bat-hoodie', label: 'Bat hoodie', src: '/agent-avatars/set2-bat-hoodie.png' },
];
