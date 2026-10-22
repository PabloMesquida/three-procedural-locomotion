# Developing the library

[Español](../es/development.md)

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Automated tests (≈ 1 min). `npm test -- jump`: only the files whose name contains "jump". |
| `npm run typecheck` | Type-checks the library and the examples (`tsconfig.json`). |
| `npm run build` | Builds the library into `dist/` (ESM JavaScript + `.d.ts` + source maps). |
| `npm run build:watch` | The same, rebuilding on save. |
| `npm run bench` | Performance benchmark (see [Performance](#performance)). |
| `npm run docs` | Regenerates the parameter reference (`docs/en/parameters.md`, `docs/es/parameters.md`) and `docs/parameters.json` (groups and descriptions in both languages, for settings panels) from the code; the Spanish text comes from `docs/i18n/parameters.es.json`. |
| `npm run mocap` | Compares the gait with CMU motion capture (and, with `-- sfu`, SFU; see [Naturalness](naturalness.md)). |
| `npm pack` | Builds and generates `three-procedural-locomotion-<version>.tgz` to install in another project. |

Requires Node 20.19+ or 22.12+.

## How it works

Every frame, from top to bottom:

```text
intention     targetSpeed / targetHeading / targetCrouch / jump()   ← or MoveToController (moveTo)
  ↓
body          BodyController: speed with acceleration, limited turning (brakes according to the remaining
              turn), height above the ground, ballistic jump
  ↓
rhythm        GaitController: phase of each foot's cycle, walking ↔ running, idle
  ↓
steps         FootstepPlanner: where each foot lands (body prediction, turning, width)
              FootTarget + FootRoll: swing trajectory, heel → sole → toes
              FootPlacement: ground under heel and toes, foot tilt
  ↓
body          PelvisController (height, rotation, drop), TorsoController (counter-rotation, lean,
              stable head), ArmController (opposite swing)
  ↓
bones         LegIK (analytic Two-Bone IK, knee forward) → bone rotations
              TwistController: distributes the twist over the twist bones (if the rig has them)
```

The shapes and rhythms (cadence according to speed, trajectory of the foot in the air, foot roll, knees,
arms) are measured against real motion capture: see [Naturalness](naturalness.md).

The body is kinematic (no physics): speed, turning and jumping are computed, and only the ground is
queried.

## Structure

```text
src/          LIBRARY (the only thing published, together with dist/ and docs/)
  index.ts            public entry point (`three-procedural-locomotion`)
  ProceduralHuman.ts  main API: control, state, events, configuration, lifecycle
  config.ts           default configuration, validation (ConfigError), scaling (LENGTH_PARAMS)
  presets.ts          walking styles
  i18n.ts             languages of the UI texts (Language, LocalizedText)
  rig/        HumanRig (types, forward, leg length), RigMapper (mapping + validation),
              inspectSkeleton, checkModel, presets/mixamo, presets/rigify
  ik/         TwoBoneIK (analytic solver), LegIK (leg of the rig)
  terrain/    GroundDetector (interface + raycast), StaticGroundDetector (indexed static ground),
              SurfaceDetector, FootPlacement
  locomotion/ LocomotionConfig, GaitController, FootstepPlanner, FootTarget, FootRoll,
              JumpController, LocomotionController (coordinates everything)
  body/       BodyController, PelvisController, TorsoController, ArmController, TouchController,
              HandFingers, TwistController
  navigation/ MoveToController (point and click)
  tuning/     basicControls (high-level controls)
  core/       pose (world read/write of the bones, without unnecessary recomputation), transforms
  debug/      visual helpers (`three-procedural-locomotion/debug`)
examples/     integration examples (checked with `npm run typecheck`)
docs/         documentation in en/ and es/ (en/parameters.md, es/parameters.md and parameters.json are generated)
scripts/      build-lib.mjs, run-tests.mjs, gen-docs.mjs, bench.mjs, mocap.mjs
bench/        performance benchmark (bench/results/ is generated)
tests/        automated tests (helpers/, golden/, reference/: mocap averages; tools/: comparison with mocap)
recursos/     unversioned working files (e.g. recursos/mocap-cmu/ and recursos/mocap-sfu/, see naturalness.md)
modelos/      models for the tests (human_mix_propio.glb: Mixamo names; human.glb: Rigify)
dist/         built library (generated, not versioned)
```

## Tests

They use Node's test runner (no extra dependencies) and the skeleton of `modelos/human_mix_propio.glb` (only
the bone hierarchy, read the same way as GLTFLoader: no browser needed). Another model:
`PH_MODEL=path npm test` (and `PH_MAPPING=rigify` for a Rigify metarig; see [skeletons](skeletons.md)).
The tests rotate and scale the model (whatever it is) so that it faces −Z and its leg length is the
reference one: they test the motion with its proportions, not how it was exported.

- **Properties** (`tests/*.test.ts`): configuration, rig, IK, walking (flat, turns, slopes, uneven track),
  running, crouching, jumping, point and click, API (events, several characters, transformed parents,
  irregular frame rates, teleporting), sizes, styles and documentation. They check physical things with
  margins: planted feet don't slide, IK reaches, the toes don't scrape, the hips don't collapse, it reaches
  the destination without overshooting, it alternates feet, it comes to rest in time… Every fixed bug has
  its regression test.
- **Proportions** (`tests/proportions.test.ts`): the test skeleton with other proportions, generated in code
  (`tests/helpers/proportions.ts`): long and short legs, longer thigh or shin, long and short torso, wide
  and narrow hips, long and short arms and feet, and combinations. Each variant does a full route
  (standing, walking, turning, running, crouching, jumping, going to a point) with the same requirements
  as the test model. A test checks that the generator really changes each proportion.
- **Exact references** (`tests/golden/`): 4 routes recorded every 0.1 s (root, hips, feet, head). Any change
  in the motion, however small, is reported with the instant and the point. If the change is intended:
  `UPDATE_GOLDEN=1 npm test` (PowerShell: `$env:UPDATE_GOLDEN=1; npm test; Remove-Item Env:UPDATE_GOLDEN`).
- **Naturalness** (`tests/naturalness.test.ts`): the gait at 1.2 m/s against the averages of real motion
  capture (`tests/reference/cmu-caminar.json`): cadence, stride, stance, toe clearance and error of the
  curves of thigh, knee, ankle, foot, ankle position, pelvis, shoulders, upper arm and elbow (see
  [Naturalness](naturalness.md)). `npm run mocap` shows the full comparison.
- **Documentation**: a test fails if the parameter reference or `docs/parameters.json` don't match the code
  → `npm run docs`, or if `docs/i18n/parameters.es.json` has a missing, extra or outdated translation (its
  `en` is no longer the TSDoc).
- Known and set as a limit so that it doesn't get worse: when walking, the hips don't exceed ≈ 4 mm/frame²
  of jerk (at a brisk pace, ~1.7 m/s, ≈ 6; in the transition to running, ≈ 3–6), and when running the
  impact on landing after the flight phase is larger (≈ 11–16, also with other proportions; limit 25). The
  hips rise following a spring (lowering, on the other hand, is immediate if the legs require it) and, on
  landing, each foot fixes its stance according to the higher of the current speed and the one it will
  have at toe-off: without that, accelerating or braking through the transition, the trailing leg
  stretched and the hips sank. Tests "the hips don't jerk…", running and proportions. When running,
  toe-off starts where the foot was at the real instant of toe-off (not at the previous frame) and the
  corner between the desired height of the hips and the limit of the legs is rounded: without that, the
  stretched trailing leg pulled the hips at toe-off (up to ≈ 31 depending on the proportions).
- Known: running above ~4 m/s (more than the default `runSpeed`), braking accentuates the drop of the hips
  in the flight phase (up to ≈ 0.45 × leg). At the default running speed it doesn't happen.
- **CI** (`.github/workflows/ci.yml`): on every push to `main` and every pull request, GitHub Actions runs the
  type-check, the tests with both test rigs and `npm pack` (which builds the library) on Node 20, 22 and 24.

## Performance

Full diagnosis, what was optimized and what is left: [performance audit](performance-audit.md).

`npm run bench` measures `human.update` without a browser with 1, 10, 50 and 100 characters, standing,
walking, running and turning, on flat ground and on a 51,200-triangle mesh (the latter only with 1 and 10).
Per scenario: time per frame (average, p50, p99, maximum), time per character, Three matrices recomputed,
raycasts and memory allocated per frame. `--quick` only does 1 and 10 characters walking.

Before optimizing: `npm run bench -- --save-baseline` saves the baseline (`bench/baseline.json`) and the
following runs show the difference from it. Times depend on the machine and vary from one run to another
(20–30 % in the heavy scenarios): always compare on the same machine and, for a doubtful difference,
measure both versions one after the other. Matrices and raycasts don't depend on the machine.

The controllers read and write the world pose of the bones only through `src/core/pose.ts`:

- reading (`worldPosition`, `worldQuaternion`) takes the world matrix as it is, without recomputing
  anything: whoever reads makes sure first that it is up to date (`updateNode`, or
  `updateDown(ancestor, bone)` for the chain between both);
- writing (`setWorldQuaternionNode`, `setWorldPositionNode`) updates only that bone; whatever hangs from it
  is left pending until the stage ends with `updateSubtree`.

Don't use `getWorldPosition`/`getWorldQuaternion` or `updateWorldMatrix(true, true)` in per-frame code: they
recompute all the ancestors or everything below, and called bone by bone they multiplied each frame's
matrices by 6 (2,148 → 351 per character). The resulting matrices are identical; the exact-reference tests
check it.

Raycasts per character: 1 per frame (root probe, which also detects changes in the ground under the body)
and ~14 at the start of each step (landing: heel and toes; arc height: 12 samples of the toes). Standing
still, the check of whether the feet are settled (4 raycasts) is reused while the root matrix doesn't
change and repeated every `IDLE_RECHECK_TIME` (0.25 s) to notice changes in the configuration or the
terrain under the feet. `tests/raycasts.test.ts` sets the budget (standing ≤ 1.3/frame, walking ≤ 1.5,
running ≤ 1.75).

What each query costs depends on the detector. `RaycastGroundDetector` uses Three's raycast, which tests
every triangle (~2 ms each with 50,000: the ~14 at the start of a step make a ~25 ms frame).
`StaticGroundDetector` indexes the triangles a vertical ray can hit in a tree by their footprint seen from
above (XZ, median split, leaves of 8) with their height range: 2–5 µs per query. It replicates what Three
r186's raycast does (material side, groups, `drawRange`, layer 0, negative scales, interpolated vertex
normal); `tests/ground.test.ts` compares it ray by ray and with a full route. The whole suite can run with
it: `PH_GROUND=static npm test`. The benchmark measures both (`malla`, `malla-static`).

## Adding or changing a parameter

1. Add it to its controller's interface (`LocomotionConfig`, `PelvisConfig`, `TorsoConfig`, `ArmConfig`,
   `TouchConfig` or `MoveToConfig`) with a comment in English `/** … (unit). */`, and its value in the
   default values object.
2. If it is a body length, add it to `LENGTH_PARAMS` (`src/config.ts`); if it must be > 0, to `POSITIVE`;
   if it is only read when creating the character, to `CONSTRUCTION_ONLY_PARAMS`.
3. Put it in a section of `scripts/gen-docs.mjs` (otherwise the script fails saying which one is missing),
   add its Spanish translation to `docs/i18n/parameters.es.json` (`en`: the TSDoc text, `es`: the
   translation) and run `npm run docs`. If you change an existing comment, update its translation and copy
   the new `en`.
4. `npm test`. If the default value changes the motion, the exact references will report it.
