# Improving existing models

Use this loop when the model already exists in a host codebase — with or
without a Vibe3D registry, reference image, or preview CLI. The visual loop is
the same; the source of truth changes: the host's runtime contract and the
model's current state replace the registry and reference photo.

## Locate and respect the host contract

Find the model where the host keeps it and improve it in place. Keep its
language, file path, export names, and factory signature exactly as the host
consumes them. Before editing, read the host's model contract (rig/part
schemas, validation, audits, animation clips) and list the parts the host
addresses by name.

**Host contract outranks modeling rules.** Never merge, rename, or reparent
across named animated or semantically addressed parts; apply build-bake-merge
only to static detail inside a single named part. Rescale physical constants
(bevel widths, clearances) to the host's world units, verifying from the
actual preview camera.

## Baseline capture

Capture the model's current state BEFORE editing; the baseline image is the
comparison anchor. If the registry preview command exists, use it. Otherwise
build a minimal deterministic harness from what the host already has: serve
the host app, drive its own viewer to pose the model in a fixed state, fix
the camera (yaw, pitch, resolution), and save numbered captures per
iteration. A scripted browser screenshotting the host's demo page is
sufficient. Same camera every capture — comparisons are worthless otherwise.

For an animated host, the canonical scored pose is the state where every part
is visible — typically the fully assembled or deployed end state — frozen via
the host's own playback API and hard-coded in the harness along with the
camera transform. Supplementary poses may inform the critic but only the
canonical pose is scored. The stills loop scores static quality; animation is
a validation gate, not a scored dimension — capture a few timeline points for
regression checking only.

When the host declares no world units, infer scale from a part with a
recognizable real-world size, state the inference in the brief, and rescale
physical constants to it.

## Brief and critique without a reference

Author a one-paragraph brief from the model's own source, names, and host
docs: what the object is, its intended read, and its distinctive landmarks.
State that you authored it.

Give a fresh critic (a new agent with no build context) only the brief, the
baseline, and the current capture. The authoring agent must not score its
own iteration. Without a reference image the resemblance score becomes a
quality score against the brief and the hard-surface rules: silhouette and
proportions first, then mass balance and negative space, landmarks,
material/value read, and detail plausibility. Ask for the score, what reads
correctly, and no more than three prioritized fixes. Accept at 85; stop after
two plateauing scores or ten iterations, as in the standard loop.

## Host runtime resolution gate

When the host displays the model below the critic capture resolution (pixel
ratio, render scale, or a documented downsample), the downscaled frame is a
second scored image, not a taste screenshot.

Capture the same pose twice: critic resolution and host runtime resolution.
Acceptance requires the brief's primary read to survive the host runtime
frame. A landmark that exists only in the high-resolution capture is not
accepted.

If the high-resolution score is tolerable but the runtime frame fails the
primary read, the next iteration must change massing or value contrast —
silhouette, albedo, or the size of an existing mass. Do not add emissive,
greeble, or a camera-facing light quad to recover a mass that the downsample
crushed.

Measure the host's crushed-black floor (grade, tonemap, or fog). No secondary
mass albedo may sit at or below that floor; those pixels are black after
downsample. Two brightest features on one object must differ in both hue and
value, or they merge into one smear at runtime resolution.

An iteration cap is not a substitute for a representation change. If runtime
read still fails the primary landmark, keep iterating on massing/value until
the stop conditions in the standard loop (85, two plateaus, or ten
iterations).

## Iterate and verify

Apply one highest-impact fix per iteration, then recapture both resolutions.
After each accepted change, run the host's own validation — contract checks,
audits, animation playthroughs, console cleanliness. A change that improves
the image but fails host validation is rejected, not negotiated with.

## Deliver

Report the model source, baseline and final captures side by side, iteration
count, accepted score, and unresolved approximations. Skip registry, catalog,
and GLB steps when no registry exists.
