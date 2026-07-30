import { apiAuthHeaders, apiUrl } from './backendClient';

export interface OpenPetCatalogPage {
  version: number;
  page: number;
  pageSize: number;
  pets: OpenPet[];
}

export interface OpenPet {
  id: string;
  displayName: string;
  description?: string;
  thumbnail: string;
  spritesheet?: string;
  zip?: string;
  category?: string;
  featured?: boolean;
  original?: boolean;
  source?: 'openpets' | 'codex' | string;
}

const OPENPETS_PAGE_URL = '/backend/openpets/catalog';
const OPENPETS_CACHE_KEY = 'agensis.openpets.catalog.v1';
const OPENPETS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface OpenPetsCacheEntry {
  ts: number;
  pets: OpenPet[];
}

let featuredPetsPromise: Promise<OpenPet[]> | null = null;

function readCachedOpenPets(): OpenPetsCacheEntry | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(OPENPETS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OpenPetsCacheEntry>;
    if (!parsed || typeof parsed.ts !== 'number' || !Array.isArray(parsed.pets)) return null;
    return { ts: parsed.ts, pets: normalizeOpenPets(parsed.pets) };
  } catch {
    return null;
  }
}

function writeCachedOpenPets(pets: OpenPet[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(OPENPETS_CACHE_KEY, JSON.stringify({ ts: Date.now(), pets } satisfies OpenPetsCacheEntry));
  } catch {
    // localStorage full or unavailable — non-fatal, in-memory cache still applies.
  }
}

function fetchOpenPetsFromNetwork(): Promise<OpenPet[]> {
  return fetch(apiUrl(OPENPETS_PAGE_URL), { headers: apiAuthHeaders() })
    .then(response => {
      if (!response.ok) {
        throw new Error(`OpenPets catalog returned ${response.status}`);
      }
      return response.json() as Promise<{ data?: OpenPetCatalogPage; error?: unknown } | OpenPetCatalogPage>;
    })
    .then(payload => {
      const page = 'data' in payload && payload.data ? payload.data : payload as OpenPetCatalogPage;
      const pets = normalizeOpenPets(page.pets);
      writeCachedOpenPets(pets);
      return pets;
    });
}

export function isImageAvatar(value: string | null | undefined) {
  return Boolean(value && /^(https?:\/\/|\/|data:image\/|blob:)/i.test(value));
}

export function isPetSpritesheetAvatar(value: string | null | undefined) {
  return Boolean(value && /(?:^|[-_/])spritesheet\.(?:webp|png)(?:[?#].*)?$/i.test(value));
}

export function openPetAvatarSrc(pet: Pick<OpenPet, 'thumbnail' | 'spritesheet'>) {
  return pet.spritesheet || pet.thumbnail;
}

export function renderablePetAssetUrl(value: string) {
  return value.startsWith('/backend/') ? apiUrl(value) : value;
}

function normalizePetAssetUrl(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function fetchFeaturedOpenPets(limit = 120) {
  if (!featuredPetsPromise) {
    const cached = readCachedOpenPets();
    if (cached) {
      // Serve the persisted catalog instantly so reloads don't re-fetch.
      featuredPetsPromise = Promise.resolve(cached.pets);
      if (Date.now() - cached.ts > OPENPETS_CACHE_TTL_MS) {
        // Stale: revalidate in the background and promote the fresh result.
        fetchOpenPetsFromNetwork()
          .then(pets => { featuredPetsPromise = Promise.resolve(pets); })
          .catch(() => { /* keep serving the cached catalog on failure */ });
      }
    } else {
      featuredPetsPromise = fetchOpenPetsFromNetwork().catch(error => {
        featuredPetsPromise = null;
        throw error;
      });
    }
  }
  return featuredPetsPromise.then(pets => pets.slice(0, limit));
}

function normalizeOpenPets(pets: unknown): OpenPet[] {
  if (!Array.isArray(pets)) return [];
  return pets
    .map(pet => pet && typeof pet === 'object' ? pet as Partial<OpenPet> : null)
    .filter((pet): pet is Partial<OpenPet> => Boolean(pet?.id && (pet?.thumbnail || pet?.spritesheet)))
    .map(pet => {
      const spritesheet = normalizePetAssetUrl(pet.spritesheet);
      const thumbnail = normalizePetAssetUrl(pet.thumbnail) || spritesheet;
      return {
        id: String(pet.id),
        displayName: String(pet.displayName || pet.id),
        description: typeof pet.description === 'string' ? pet.description : undefined,
        thumbnail,
        spritesheet: spritesheet || undefined,
        zip: typeof pet.zip === 'string' ? pet.zip : undefined,
        category: typeof pet.category === 'string' ? pet.category : undefined,
        featured: Boolean(pet.featured),
        original: Boolean(pet.original),
        source: typeof pet.source === 'string' ? pet.source : undefined,
      };
    });
}
