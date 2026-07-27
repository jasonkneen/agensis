'use strict';

const fs = require('fs');
const path = require('path');

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// OpenPets catalogue, merged with whatever pets this host has hatched locally
// into ~/.codex/pets, plus the asset proxy that serves their spritesheets.
//
// The asset route takes a directory name and an asset name straight from the
// URL, so containment is the whole job: isPathInside is checked twice, once for
// the pet directory inside CODEX_PETS_ROOT and once for the asset inside the pet
// directory. Both live in server/lib/codex-pets.cjs and are injected.

function mountPetsRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, CODEX_PETS_ROOT, OPENPETS_CATALOG_URL,
  contentTypeForImageAsset, isPathInside, mergeLocalCodexPets,
 } = deps;

 app.get('/backend/openpets/catalog', requireAuth, async (_req, res) => {
  try {
   let payload = { version: 3, page: 0, pageSize: 0, pets: [] };
   let remoteError = null;
   try {
    const response = await fetch(OPENPETS_CATALOG_URL, {
     headers: { 'User-Agent': 'agensis/1.0 (+https://openpets.dev)' },
    });
    if (!response.ok) {
     remoteError = new Error(`OpenPets catalog returned ${response.status}`);
    } else {
     payload = await response.json();
    }
   } catch (error) {
    remoteError = error;
   }

   const merged = mergeLocalCodexPets(payload);
   if (remoteError && merged.pets.length === 0) return jsonError(res, 502, remoteError);
   res.setHeader('Cache-Control', 'public, max-age=120');
   res.json({ data: merged, error: null });
  } catch (error) {
   jsonError(res, 502, error);
  }
 });

 app.get('/backend/codex-pets/:petDir/:asset', async (req, res) => {
  try {
   const petDir = path.resolve(CODEX_PETS_ROOT, String(req.params.petDir || ''));
   const assetName = path.basename(String(req.params.asset || ''));
   const assetPath = path.resolve(petDir, assetName);
   if (!assetName || !/\.(webp|png|gif|jpe?g)$/i.test(assetName)) return jsonError(res, 404, new Error('Pet asset not found'));
   if (!isPathInside(CODEX_PETS_ROOT, petDir) || !isPathInside(petDir, assetPath)) return jsonError(res, 404, new Error('Pet asset not found'));
   if (!fs.existsSync(path.join(petDir, 'pet.json')) || !fs.existsSync(assetPath)) return jsonError(res, 404, new Error('Pet asset not found'));
   res.setHeader('Content-Type', contentTypeForImageAsset(assetPath));
   res.setHeader('Cache-Control', 'public, max-age=3600');
   fs.createReadStream(assetPath).pipe(res);
  } catch (error) {
   jsonError(res, 500, error);
  }
 });
}

module.exports = { mountPetsRoutes };
