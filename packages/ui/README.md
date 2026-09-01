# @agensis/ui

The shadcn-derived React primitives the Agensis app renders. MIT licensed (see
[LICENSE](./LICENSE) and [NOTICE](./NOTICE)) inside an otherwise AGPL-3.0-only
repository, so it can be lifted out later without dragging AGPL terms along.

## Status: internal, not published

`"private": true` is deliberate. Two things must land before this can go to a
registry:

1. **`dist` is not loadable by Node.** `npm run build` is plain `tsc`, which
   emits import specifiers verbatim, and the sources use extensionless relative
   imports (`./button`, not `./button.js`). Bundlers resolve those; `node` does
   not. Publishing needs either `.js` specifiers throughout or a real bundler.
2. **No styles ship.** The components reference design tokens (`bg-primary`,
   `text-muted-foreground`, `animate-in`, …) that exist only in the app's
   `src/index.css`. An external consumer would need those tokens plus a
   Tailwind `@source` pointing at this package so the classes get generated.
   Extracting tokens/themes/fonts is a separate piece of work.

## How the app consumes it

Through the `source` export condition, which points at TypeScript source rather
than `dist`. `vite.config.ts`, `vitest.config.ts`, `vitest.smoke.config.ts` and
`tsconfig.app.json` all set that condition, so there is no build step in the
loop and editing a component hot-reloads. Nothing in the app resolves `dist`.

```ts
import { Button } from '@agensis/ui/components/button'  // preferred
import { cn } from '@agensis/ui/lib/utils'
import { Button } from '@agensis/ui'                    // barrel; pulls all 57
```

`src/components/ui/*.tsx` in the app are temporary re-export shims so existing
`@/components/ui/*` imports keep working. New code should deep-import from
`@agensis/ui/components/*`. The shims go away once call sites are rewritten.

## Rules

- Nothing here may import `@/` (the app alias) or the package's own barrel.
  Leaves import their relative siblings only. `tests/unit/agensisUiPackage.test.ts`
  enforces both, plus the barrel's completeness.
- `npx shadcn add` at the repo root writes into the **app** (`components.json`
  aliases still point there) and would overwrite a shim. Add the component
  there, then move it here by hand and leave a shim behind.
- No AGPL code from the rest of the repository may be copied into this package.
