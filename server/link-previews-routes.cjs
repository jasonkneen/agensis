'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// Link preview (unfurl) cards, and the proxied preview image.
//
// Anyone who can post a message picks the URL, so this surface fetches on a
// stranger's behalf. The SSRF gate is server/link-preview.cjs's own per-redirect
// check — deliberately re-validated at EVERY hop, not just the first, because a
// public host redirecting to a private one passes a first-hop check.
//
// The image is proxied rather than hotlinked so a preview card cannot be used to
// report a reader's IP to whoever authored the link.

function mountLinkPreviewsRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, getDb, dbRateLimitBlocked, clientIpFromReq,
  LINK_PREVIEW_COLUMNS, LINK_PREVIEW_MAX_PER_REQUEST, fetchLinkPreview,
  fetchPreviewImage, linkPreviewCacheKey, linkPreviewDbRateLimiter,
  linkPreviewImageDbRateLimiter, linkPreviewImageRateLimiter,
  linkPreviewRateLimiter, normalizeUnfurlUrl, publicLinkPreview,
  upsertLinkPreview,
 } = deps;

 app.post('/backend/link-previews', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, linkPreviewRateLimiter, linkPreviewDbRateLimiter, req.userId || clientIpFromReq(req))) return;
   const submitted = Array.isArray(req.body?.urls) ? req.body.urls : [];
   const wanted = [];
   const seen = new Set();
   // Scan a bounded prefix, then keep the first N that survive validation — a
   // body with 10,000 urls must not become 10,000 URL parses.
   for (const raw of submitted.slice(0, LINK_PREVIEW_MAX_PER_REQUEST * 4)) {
    const normalized = normalizeUnfurlUrl(raw);
    if (!normalized.ok || seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    wanted.push(normalized.url);
    if (wanted.length >= LINK_PREVIEW_MAX_PER_REQUEST) break;
   }
   if (!wanted.length) return res.json({ data: { previews: [] }, error: null });

   const hashes = wanted.map(linkPreviewCacheKey);
   // Explicit placeholders rather than `= any($1::text[])`: postgres.js will not
   // array-serialize a raw JS array bound through .unsafe (see AGENTS.md), and
   // with a cap of 8 there is nothing to gain from the array form.
   const cached = await getDb().unsafe(
    `select ${LINK_PREVIEW_COLUMNS} from link_previews
        where url_hash in (${hashes.map((_hash, index) => `$${index + 1}`).join(', ')})
          and expires_at > now()`,
    hashes,
   );
   const byHash = new Map(cached.map(row => [row.url_hash, row]));

   const misses = wanted.filter(url => !byHash.has(linkPreviewCacheKey(url)));
   if (misses.length) {
    // In parallel, bounded by LINK_PREVIEW_MAX_PER_REQUEST. Each fetch carries
    // its own deadline, so the worst case for this handler is one timeout, not
    // the sum of them.
    const fetched = await Promise.all(misses.map(async (url) => {
     try {
      return await fetchLinkPreview(url);
     } catch (error) {
      // fetchLinkPreview is documented not to throw; if that ever stops being
      // true, one bad URL must not fail the whole batch.
      console.warn('[link-preview] unexpected throw:', error?.message || error);
      return { url, finalUrl: '', status: 'failed', detail: 'internal_error', title: '', description: '', siteName: '', imageUrl: '' };
     }
    }));
    for (const result of fetched) {
     const row = await upsertLinkPreview(result);
     if (row) byHash.set(row.url_hash, row);
    }
   }

   res.json({
    data: {
     previews: wanted
      .map(url => byHash.get(linkPreviewCacheKey(url)))
      .filter(Boolean)
      .map(publicLinkPreview),
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // The image proxy. Direct <img src="https://stranger.example/card.png"> would
 // hand the reader's IP (and referer, and UA) to that host on every render —
 // exactly the leak unfurling server-side was meant to avoid — so the bytes come
 // through here instead.
 //
 // A proxy is a second SSRF surface, and this one is deliberately shaped so it
 // barely is: it takes a PREVIEW ROW ID, never a URL. The set of fetchable
 // targets is therefore exactly the set already unfurled and validated once, and
 // fetchPreviewImage re-runs the full gate anyway (DNS can move between the two
 // requests). Authenticated, rate-limited, image-only content types, 2MB cap.
 app.get('/backend/link-previews/:id/image', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, linkPreviewImageRateLimiter, linkPreviewImageDbRateLimiter, req.userId || clientIpFromReq(req))) return;
   const id = String(req.params.id || '');
   // Checked before the query: an id that is not a uuid would make the ::uuid
   // cast throw a 500 for what is really a 404.
   if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return jsonError(res, 404, new Error('Preview not found'));
   }
   const rows = await getDb().unsafe('select image_url from link_previews where id = $1::uuid limit 1', [id]);
   const imageUrl = String(rows[0]?.image_url || '');
   if (!imageUrl) return jsonError(res, 404, new Error('This preview has no image'));
   const image = await fetchPreviewImage(imageUrl);
   if (!image.ok) return jsonError(res, 502, new Error('Preview image could not be fetched'));
   res.setHeader('Content-Type', image.contentType);
   // Belt and braces on a body we did not author: no sniffing to something
   // executable, and a CSP that permits nothing at all if it is ever navigated
   // to directly rather than loaded as an <img>.
   res.setHeader('X-Content-Type-Options', 'nosniff');
   res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
   res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
   // `private` so a shared cache never holds it; a day is well inside the row's
   // own TTL and keeps a scrolling reader off this route entirely.
   res.setHeader('Cache-Control', 'private, max-age=86400');
   res.end(image.bytes);
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // --- In-app feedback -------------------------------------------------------
 //
 // SUBMIT is open to any authenticated user and rate limited; READ is not here
 // at all. Reports are read as ordinary rows of the System workspace through
 // the generic /backend/db gate, so "only members of the System workspace can
 // see feedback" is the same membership check as every other table rather than
 // a second authorization path written by hand.
 //
 // The client does NOT choose the destination workspace. It cannot: the body
 // has no workspace field for the report's home, only `sourceWorkspaceId`
 // (where the user was standing), which is recorded as context and never used
 // for authorization. ensureSystemWorkspace resolves the target server-side.
}

module.exports = { mountLinkPreviewsRoutes };
