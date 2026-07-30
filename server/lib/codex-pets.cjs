'use strict';

// Local Codex pets — the animated sprite characters a user has hatched into
// ~/.codex/pets, merged into the remote OpenPets catalogue.
//
// Moved verbatim out of server/index.cjs (Wave 1 of the index.cjs reduction).
// A pure leaf: fs, path, os and nothing else. No module state, no database.
//
// `isPathInside` lives here because these four functions and the
// /backend/codex-pets/:petDir/:asset route are its only callers — the pet
// directory name and the manifest's spritesheetPath are both user-controlled,
// and this is what keeps them inside CODEX_PETS_ROOT. If a second subsystem
// ever needs it, promote it to its own lib rather than importing it from here.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CODEX_PETS_ROOT = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'pets');

function isPathInside(parent, candidate) {
 const relative = path.relative(parent, candidate);
 return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function codexPetAssetUrl(petDirName, assetName) {
 return `/backend/codex-pets/${encodeURIComponent(petDirName)}/${encodeURIComponent(assetName)}`;
}

function contentTypeForImageAsset(filePath) {
 const ext = path.extname(filePath).toLowerCase();
 if (ext === '.webp') return 'image/webp';
 if (ext === '.png') return 'image/png';
 if (ext === '.gif') return 'image/gif';
 if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
 return 'application/octet-stream';
}

function listCodexPets() {
 if (!fs.existsSync(CODEX_PETS_ROOT)) return [];
 return fs.readdirSync(CODEX_PETS_ROOT, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .flatMap(entry => {
   try {
    const petDir = path.resolve(CODEX_PETS_ROOT, entry.name);
    if (!isPathInside(CODEX_PETS_ROOT, petDir)) return [];
    const manifestPath = path.join(petDir, 'pet.json');
    if (!fs.existsSync(manifestPath)) return [];
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const spriteName = path.basename(String(manifest.spritesheetPath || 'spritesheet.webp'));
    if (!/\.(webp|png|gif|jpe?g)$/i.test(spriteName)) return [];
    const spritePath = path.resolve(petDir, spriteName);
    if (!isPathInside(petDir, spritePath) || !fs.existsSync(spritePath)) return [];
    const id = String(manifest.id || entry.name).trim() || entry.name;
    const assetUrl = codexPetAssetUrl(entry.name, spriteName);
    return [{
     id: `codex:${id}`,
     displayName: String(manifest.displayName || id),
     description: typeof manifest.description === 'string' ? manifest.description : 'Local Codex pet.',
     thumbnail: assetUrl,
     spritesheet: assetUrl,
     category: typeof manifest.category === 'string' ? manifest.category : 'codex',
     featured: false,
     original: false,
     source: 'codex',
    }];
   } catch {
    return [];
   }
  });
}

function mergeLocalCodexPets(openPetsPayload) {
 const remotePets = Array.isArray(openPetsPayload?.pets) ? openPetsPayload.pets : [];
 const codexPets = listCodexPets();
 return {
  ...(openPetsPayload && typeof openPetsPayload === 'object' ? openPetsPayload : {}),
  pets: [...codexPets, ...remotePets],
  pageSize: codexPets.length + remotePets.length,
 };
}

module.exports = {
 CODEX_PETS_ROOT,
 isPathInside,
 codexPetAssetUrl,
 contentTypeForImageAsset,
 listCodexPets,
 mergeLocalCodexPets,
};
