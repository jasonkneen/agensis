# Netlify deploy → "new version, reload" notification

When Netlify finishes publishing a new frontend to the CDN, the backend fans a
`deploy_published` event to every connected client over the realtime WebSocket, and
the app shows a persistent **"A new version of agensis is available — Reload"** toast.

## Pieces

| Layer | File | What it does |
|---|---|---|
| Receiver | `server/index.cjs` → `POST /backend/netlify-deploy-hook` | Verifies Netlify's JWS signature, broadcasts `deploy_published` to all sockets. Public (Netlify has no bearer token); authenticity = the signature. |
| Signature check | `server/index.cjs` → `verifyNetlifyDeploySignature()` | HS256 verify of the JWS **and** SHA-256 match of the body. Unit-tested in `tests/netlify-deploy-hook.test.cjs`. |
| Broadcast | `server/index.cjs` → `broadcastGlobal()` | Sends to every authenticated socket, ignoring channel subscriptions. |
| Client subscribe | `src/lib/backendClient.ts` → `onDeployPublished()` | Subscribes to the `deploy_published` system event on the shared socket. |
| Toast | `src/hooks/useDeployNotification.ts` (mounted in `App.tsx`) | Persistent sonner toast with a **Reload** action, deduped by commit. |

## One-time setup (Netlify dashboard)

1. **Netlify** → your site → **Site configuration → Notifications → Deploy notifications → Add notification → Outgoing webhook**.
2. **Event to listen for:** `Deploy succeeded` — this is the published-and-live signal.
3. **URL to notify:** `https://agensis-backend.fly.dev/backend/netlify-deploy-hook`
4. **JWS signature secret:** generate a random secret and paste it here. Netlify will sign every POST with it.

Then set the **same** secret on the backend so it can verify the signature:

```
fly secrets set NETLIFY_WEBHOOK_JWS_SECRET='<the-secret-you-pasted>' --app agensis-backend
```

> If `NETLIFY_WEBHOOK_JWS_SECRET` is **unset**, the endpoint still works but accepts
> unsigned requests and logs a warning — fine for a quick test, not for production.
> Set the secret to close that gap.

## Notes / behaviour

- **Fast-ack:** the handler is synchronous in-memory (HMAC + one socket loop, no DB, no
  outbound calls) and always returns `200` to a correctly-signed request. Netlify silently
  disables hooks that are slow or error on its own requests — forgeries get `401`, which
  can't disable the real hook.
- **Socket survives a Netlify deploy.** Only a **Fly backend** deploy rolls the WebSocket;
  a Netlify frontend deploy leaves it open, so currently-loaded clients receive the event
  — exactly the ones that should reload.
- **State gating:** only broadcasts on a `ready`/`current`/absent deploy state, so wiring a
  different event by mistake won't nag on build-started/failed hooks.
- **Deploy split:** the receiver route is **backend** → needs a `fly deploy` to go live. The
  toast is **frontend** → live on Netlify after push.
