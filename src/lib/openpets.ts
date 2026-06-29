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

let featuredPetsPromise: Promise<OpenPet[]> | null = null;

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
    featuredPetsPromise = fetch(apiUrl(OPENPETS_PAGE_URL), { headers: apiAuthHeaders() })
      .then(response => {
        if (!response.ok) {
          throw new Error(`OpenPets catalog returned ${response.status}`);
        }
        return response.json() as Promise<{ data?: OpenPetCatalogPage; error?: unknown } | OpenPetCatalogPage>;
      })
      .then(payload => {
        const page = 'data' in payload && payload.data ? payload.data : payload as OpenPetCatalogPage;
        return normalizeOpenPets(page.pets);
      })
      .catch(error => {
        featuredPetsPromise = null;
        throw error;
      });
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
