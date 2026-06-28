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
}

const OPENPETS_PAGE_URL = 'https://openpets.dev/pets/catalog.v3/page-000.json';

let featuredPetsPromise: Promise<OpenPet[]> | null = null;

export function isImageAvatar(value: string | null | undefined) {
  return Boolean(value && /^https?:\/\//i.test(value));
}

export function fetchFeaturedOpenPets(limit = 24) {
  if (!featuredPetsPromise) {
    featuredPetsPromise = fetch(OPENPETS_PAGE_URL)
      .then(response => {
        if (!response.ok) {
          throw new Error(`OpenPets catalog returned ${response.status}`);
        }
        return response.json() as Promise<OpenPetCatalogPage>;
      })
      .then(page => page.pets.filter(pet => pet.thumbnail).slice(0, limit));
  }
  return featuredPetsPromise;
}
