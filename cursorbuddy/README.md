# CursorBuddy Site

CursorBuddy is a separate Netlify site inside the Agensis repository. It is not
mounted as another route in the main Agensis app.

## Netlify Site Settings

- Repository: this Agensis repository.
- Package directory: `cursorbuddy`.
- Build command: `npm run build`.
- Publish directory: `dist`.
- Production domain: attach `https://cursorbuddy.app` to this Netlify site.
- Generated runtime config defaults `siteUrl` to `https://cursorbuddy.app`.

The site proxies `/backend/*` to `https://agensis.io/backend/*` by default, so
it can use Agensis auth, account, workspace, billing, and agent APIs without a
standalone database fork. If a different backend is needed, set
`CURSORBUDDY_BACKEND_BASE_URL` during build and update the Netlify redirect for
production.

## Local Commands

```sh
npm --prefix cursorbuddy run verify
```

## Boundaries

- Account source of truth: Agensis `app_users`.
- Team/workspace source of truth: Agensis `workspaces` and `workspace_members`.
- Agent source of truth: Agensis `workspace_agents` plus CursorBuddy bindings.
- Provider secrets: stored as refs to Agensis-managed encrypted secrets, not in
  frontend storage.
- Field control: pause/stop/reconfigure requests are queued as commands for the
  active instance rather than forcing long-lived work into Netlify functions.
