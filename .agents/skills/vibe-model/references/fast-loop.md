# Visual-first loop

## Source

Put each working model in the registry's model source directory. During this
repository's migration, use `assets/prototypes/<model-id>/model.ts`.

Its `createModel` export may return a Three.js `Group` or a controller with a
stable `root`, `update`, `dispose`, semantic parts, and actions. A deliberate
preview may export `{ scene, camera, root, update, dispose }` through
`createPreview`.

Use direct Three.js geometry and the shared utilities when they save time.
Prefer readable primitives, extrusions, repeated parts, shallow booleans, and
a small semantic material set. Capture before the model feels complete; detail
follows the critic's feedback.

## Snapshot

```sh
bun run vibe:model preview \
  --module assets/prototypes/<model-id>/model.ts \
  --export createModel \
  --asset <model-id> \
  --reference <reference-image>
```

The compatibility command `bun run asset:forge preview` remains available
during migration. The default capture is one 1024 by 1024 beauty image.

Each capture writes a numbered iteration and refreshes the asset's latest
preview record. Use yaw, pitch, width, height, or an explicit preview factory
only when the reference requires them.

## Critic

Give a fresh critic the brief, reference, and current beauty image. When the
host renders below critic resolution, also give the same-pose runtime
capture and require the primary read to survive it (improving-existing.md,
host runtime resolution gate). Ask for a resemblance score, what matches,
and no more than three prioritized fixes. Accept at 85. Otherwise implement
the highest-impact correction and capture again. The authoring agent does
not score its own frame.

A hanging-V roof, dark soffit facing the camera, or holes in shingles is a
winding/pitch failure (modeling-rules § Geometry correctness). Fail it before
scoring materials or lighting. Do not pass it by enabling DoubleSide.

Stop at acceptance, two plateauing scores, or ten iterations. A plateau means
the representation or reference evidence needs to change.

## Delivery

Preserve the accepted source and final preview. Register the model for the docs
catalog and registry build. Export portable GLB only when requested. Mark
preview-only objects with `userData.excludeFromExport = true`.
