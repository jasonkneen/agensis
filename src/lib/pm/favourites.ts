import type { PreferenceCodec } from '../viewPreferences';

// Starred projects, remembered per workspace in this browser. A favourite is a personal
// shortcut, not shared project data, so it lives in storage rather than the database.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FAVOURITES = 200;

export const favouritesCodec: PreferenceCodec<string[]> = {
  parse: raw => {
    try {
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) return null;
      return value.filter((item): item is string => typeof item === 'string' && UUID.test(item)).slice(0, MAX_FAVOURITES);
    } catch {
      return null;
    }
  },
  serialize: value => JSON.stringify(value),
};

/** The list with `id` added when absent and removed when present. */
export function toggleFavourite(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id].slice(-MAX_FAVOURITES);
}
