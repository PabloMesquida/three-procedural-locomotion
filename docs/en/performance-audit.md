# Performance audit — three-procedural-locomotion

[Español](../es/performance-audit.md)

*The demo mentioned in this audit is now the lab on the project's website, outside this repository.*

Audit: 6 Oct 2026 · Updated the same day with optimizations #1, #2 and #3 (see *Current status*). The original diagnosis is kept below as it was written; the numbers in those sections are from BEFORE optimizing.

**Original diagnosis (before optimizing):** the library was CPU-bound, and almost all of that time isn't locomotion: 71 % goes into recomputing bone matrices that had already been computed (about 2,150 per frame and character for a 68-node skeleton). On terrain with many triangles another cost dominates: each raycast takes 1.8 ms and a standing character casts 5 per frame. The garbage collector (0.2 %) and the GPU are not the problem today. With simple ground, about 50 characters fit in a 60 fps frame; with 100 it goes over (22–31 ms in locomotion alone).

## Current status (after the optimizations)

| # | Finding | Status | Measured result |
| --- | --- | --- | --- |
| — | Benchmark and baseline | ✅ Done | `npm run bench` (`bench/bench.ts`, `scripts/bench.mjs`); `--quick`, `--save-baseline` → `bench/baseline.json` |
| 1 | Cascading matrices | ✅ Done (steps 1–3) | 2,148 → 351 matrices/frame/character (Mixamo). Flat ground −56 % to −82 %: 10 characters walking 3.14 → 0.79 ms; 100 ≈ 10 ms. Golden identical |
| 3 | Repeated raycasts | ✅ Done | Standing 5 → 1.25 raycasts/frame; walking 1.50 → 1.47; running 1.73 → 1.68 |
| 2 | Brute-force raycast | ✅ Done (`StaticGroundDetector`) | Query ~1.8 ms → 2–5 µs. 51,200-tri mesh, 1 character walking: 8.2 → 0.11 ms (p99 85 → 0.24 ms); 100 characters ≈ the same as on flat ground |
| — | `human.stats` telemetry / stress page | ⏳ Pending | — |
| 4 | Levels of detail (LOD) | ⏳ Pending | — |
| 1b | A single final cascade per frame | ⏳ Optional | 351 → ~170 matrices; with 100 characters matrices become the main cost again |
| 5 | Own pose outside Three's scene graph | 🔮 Future | `src/core/pose.ts` is already the only access point: it is the seam to do it |
| 6 | Substeps when the frame rate drops | ⏳ Pending (🟡) | — |
| 7, 8, 9 | Unused bones, GC, math | — Don't touch | #7 almost entirely disappeared with #1 |

### What was changed

**#1 — Matrices (`src/core/pose.ts`).** All the controllers read and write the world pose of the bones only through this module:

- reading (`worldPosition`, `worldQuaternion`) takes the world matrix as it is, without recomputing: whoever reads guarantees it is up to date (`updateNode`, or `updateDown(ancestor, bone)` for the chain between both);
- writing (`setWorldQuaternionNode`, `setWorldPositionNode`) updates only that bone; whatever hangs from it is left pending until the stage ends with `updateSubtree`;
- don't use `getWorldPosition` / `getWorldQuaternion` or `updateWorldMatrix(true, true)` in per-frame code.

It is used by `BodyController` (heading and root without a full cascade), `PelvisController` (`reset(false)` in `update`), `TwoBoneIK`, `LegIK`, `TorsoController`, `ArmController`, `HandFingers` and `LocomotionController`. The resulting matrices are identical (same operations, just once).

**#3 — Repeated raycasts (`LocomotionController`).** Standing still, `feetSettledIdle` reuses the check of whether the feet are settled while `root.matrixWorld` doesn't change, and repeats it every `IDLE_RECHECK_TIME` (0.25 s) to notice changes in the configuration or the terrain. When braking, `settleError` only in double support (the only moment it is used). `swingHeight` no longer casts the sample-0 raycast (it wasn't used). The probe under the root (1/frame) is kept: it detects changes in the ground under the body.

**#2 — Indexed ground (`src/terrain/StaticGroundDetector.ts`, exported).** npm was blocked in the environment, so `three-mesh-bvh` couldn't be installed or verified; a dependency-free detector of our own was written, for vertical rays only (the only ones the library uses). It copies in world space the triangles a vertical ray can hit and sorts them into a tree by their footprint seen from above (XZ; median with quickselect, leaves of 8, boxes as the union of the children) with their height range. It replicates Three r186's raycast: material side (Front/Back/Double), negative scale, groups, `drawRange`, layer 0 and interpolated vertex normal (or the face normal if there are no normals). It is a snapshot: `rebuild()` if the ground changes; `InstancedMesh`, `SkinnedMesh` and `BatchedMesh` are ignored with a warning. Build time: 51,200 tri ≈ 0.1 s, 500,000 ≈ 0.6 s, 2 M ≈ 2.3 s. Usage: one detector shared by all the characters; `ground: [meshes]` (raycast) is still the option for moving ground.

### Tests added

- `tests/raycasts.test.ts`: budget of ground queries per frame (standing ≤ 1.3, walking ≤ 1.5, running ≤ 1.75); standing + a step that appears under the toes → it repositions; standing + `setConfig({ stepWidth })` → it repositions.
- `tests/ground.test.ts`: `StaticGroundDetector` against Three's raycast ray by ray (the demo's terrains and odd cases: 0 discrepancies, error < 1e-6), `rebuild()`, and a full route over the uneven track with the same motion.
- `PH_GROUND=static npm test` runs the whole suite with the new detector (112/112, golden included).
- State of the suite: 112/112 with Mixamo; Rigify 107/108 (the known failure of running at 4.5 m/s with fast turns, the same value −0.391 as before these changes).

### Note on the measurements

The *Current status* measurements were taken on the shared cloud machine: between runs the averages vary by 30–60 %. Valid comparisons are within the same run or measuring both versions one after the other; the counts (matrices, raycasts) are exact. On the development machine: `npm run bench -- --save-baseline` once and compare against that.

### Next

1. Optional `human.stats` telemetry (times per stage, matrices, ground queries, substeps), with no cost when off; a stress page in the demo.
2. LOD by distance (#4).
3. If needed with many characters: a single final cascade per frame (#1b).

---

# Original diagnosis (before optimizing)

## How it was measured

Everything comes from the code at the time (105 tests passing) without touching any file of the project: the benchmarks are temporary scripts that run the library in Node, like the tests. Each statement carries its label: **FACT** (seen in the code or measured), **HYPOTHESIS** (likely, still to be confirmed) or **RECOMMENDATION** (proposal).

- **Machine:** Xeon 2.8 GHz, 2 vCPU, Node 22, Three r186. A current desktop will probably be 1.5–2× faster (HYPOTHESIS); the proportions between parts don't change.
- **Models:** Mixamo `humanoid.glb` (68 nodes, 49 bones) and your Rigify `human06.glb` (165 nodes, 161 bones).
- **Scenarios:** standing, walking at 1 m/s and running at 3 m/s, on a plane (2 triangles) and on the demo's uneven track (23,520 triangles), with 1, 10, 50 and 100 characters.
- **Tools:** per-frame stopwatch after 300 JIT warm-up frames; counters on Three's methods (matrices, raycasts); V8 sampling CPU profile; Node GC observer and V8 memory profile.
- **Limits:** the machine shares its CPU, so averages vary ±30 % between runs; the counts (matrices, raycasts) are exact. The GPU couldn't be measured here: the cloud browser uses software rendering.

## Cost map per frame

A character costs 0.22–0.35 ms per frame on simple ground (FACT, measured). Three quarters of that time is Three recomputing matrices the library asks it to recompute again and again; the locomotion itself (gait, steps, IK, springs) is 14 %.

**V8 CPU profile** (10 characters walking on the plane, 11,862 samples):

| Where the CPU goes | % |
| --- | --- |
| Three: `updateWorldMatrix` (composing local matrices and walking trees) | 40.8 |
| Three: `multiplyMatrices` (world matrix = parent × local) | 30.6 |
| Three: other matrix, quaternion and vector operations (`setFromRotationMatrix`, `decompose`, `copy`…) | 8.1 |
| The library's own code (gait, steps, IK, springs, pelvis, torso, arms) | 14.0 |
| Raycasts (2-triangle ground) | ≈ 1 |
| Garbage collector | 0.2 |

**Matrices recomputed and time per subsystem** (one character walking; the time is with instrumentation, useful for comparing parts, not as an absolute value):

| Subsystem | Matrices/frame Mixamo (68 nodes) | Matrices/frame Rigify (165 nodes) | % of time (Mixamo) |
| --- | --- | --- | --- |
| Arms and fingers (`ArmController`, `HandFingers`) | 1,188 | 1,206 | 44 |
| Pelvis (`PelvisController`) | 300 | 684 | 12 |
| Body: root, heading and ground raycast (`BodyController`) | 221 | 512 | 14 |
| IK of both legs (`LegIK`/`TwoBoneIK`) | 202 | 202 | 10 |
| Torso and head (`TorsoController`) | 153 | 434 | 6 |
| Feet, pivot and the rest of `LocomotionController` | 84 | 180 | 11 |
| Step planning, gait, point and click | < 1 | < 1 | 4 |
| **Total** | **2,148** | **3,218** | 100 |

For comparison: the renderer itself recomputes each node once per frame (68 and 165). The library does the equivalent of 32 and 20 full passes over the skeleton every frame (FACT, counted).

**Raycasts per frame and character** (FACT, counted): walking 1.5 (one under the root every frame and 15 on each step: 13 for the arc height and 2 for the landing); running 1.8; **standing 5** (the root and 4 to check whether the feet are settled). Cost of a raycast: 8.7 µs against the plane and **1,783 µs against the 23,520-triangle track**.

## Prioritized findings

Two problems explain almost all the cost: matrices recomputed in cascade (simple ground) and brute-force raycasts (detailed ground). The rest are scaling improvements or aren't worth the change.

### 🔴 1. Matrices recomputed in cascade — ✅ solved

| Field | Detail |
| --- | --- |
| Where | `core/transforms.ts` (`setWorldQuaternion`, `setWorldPosition`); `ArmController.rotateWorld` and `boneDirection`; `TorsoController` (spine, chest, head); `PelvisController.reset` + 2 `setWorldPosition` + `setWorldQuaternion`; `BodyController.applyHeading`/`writeRoot`; `TwoBoneIK.solve` |
| What happens (FACT) | Every rotation of a bone recomputes everything below it (`updateWorldMatrix(false, true)`), and every world position or rotation read recomputes all its ancestors (`getWorldPosition`/`getWorldQuaternion` call `updateWorldMatrix(true, false)`). An arm does 7 rotations and about 25 world reads; rotating the spine recomputes arms, fingers and head. `writeRoot` recomputes the whole tree twice in a row. Result: 2,148 matrices per frame (Mixamo) and 3,218 (Rigify) for 68 and 165 nodes |
| Why it matters | It is 71 % of the library's CPU (V8 profile) and it grows with the number of bones, not with what the locomotion does |
| Estimated impact | HYPOTHESIS: going down to about 6 passes per frame (\~400 matrices) would make the library 2–3× faster on the CPU: 100 characters would go from \~25 ms to \~9 ms |
| How to measure it | Counter of `Object3D.updateMatrix` per frame and character (2,148 today) and time per stage; the exact references (golden) must stay identical |
| Solution (RECOMMENDATION) | In stages, without changing the result: 1) remove the duplicate passes (`writeRoot`, `PelvisController.reset` followed by another pass); 2) read world positions and rotations from the already updated `matrixWorld`, without walking the ancestors again; 3) in arms, torso and IK, write the local quaternions of the whole chain and update its subtree only once at the end of the stage |
| Risk | Medium-high: every controller reads the pose the previous one left; a wrong order gives a pose from one frame earlier. The exact references and the 105 tests cover it |

### 🔴 2. Brute-force raycasts against detailed meshes — ✅ solved (`StaticGroundDetector`)

| Field | Detail |
| --- | --- |
| Where | `RaycastGroundDetector.castDown` → `Raycaster.intersectObjects(targets, true)` |
| What happens (FACT) | Three tests the ray against every triangle of every ground mesh (no acceleration structure), walks the children recursively, sorts all the hits and creates an object per hit. Measured: 8.7 µs against 2 triangles and 1,783 µs against 23,520 |
| Why it matters | On real ground (terrain, city) it dominates everything: a character standing on the track spends 7.3 ms per frame, 95 % in raycasts; 10 characters walking give spikes of 53 ms (p99) |
| Estimated impact | HYPOTHESIS: with a BVH the raycast drops to microseconds and the cost goes back to that of flat ground |
| How to measure it | Raycasts per frame, µs per raycast and ground triangles, in the same scenario with a plane, a 25k mesh and a 250k-triangle mesh |
| Solution (RECOMMENDATION) | The ground is already swappable (`GroundDetector`, FACT), so nothing else needs to change: add a BVH detector (e.g. the `three-mesh-bvh` library, checking its API and version before using it) and a heightmap one; document that the built-in raycast is for simple ground |
| Risk | Low: it is a new optional detector; the current one stays the same |

### 🟠 3. Raycasts repeated unnecessarily — ✅ solved

| Field | Detail |
| --- | --- |
| Where | `LocomotionController.updateGaitMode` → `FootstepPlanner.settleError` (standing, every frame); `BodyController` (probe under the root, every frame); `LocomotionController.swingHeight` (`CLEARANCE_SAMPLES` = 12 segments: 13 raycasts per step) |
| What happens (FACT) | Standing still, 5 raycasts are cast per frame even if nothing moves: 4 to know whether the feet are already settled. Each step casts 15 at once in a single frame |
| Why it matters | With detailed ground, a standing crowd pays 5 × 1.8 ms per character, and the 15 rays of a step create spikes (≈ 27 ms in one frame) |
| Estimated impact | HYPOTHESIS: standing, from 5 to 0–1 raycasts per frame; step spikes, from 15 to 3–4 |
| How to measure it | Raycasts per frame when standing, walking and starting; slowest frame (max, p99) with 10 characters |
| Solution (RECOMMENDATION) | Keep the result of `settleError` while root and feet don't move; probe under the root only if it moved; arc height with fewer samples or only when the ground between toe-off and landing isn't flat |
| Risk | Low-medium: the tests for standing still and for the uneven track watch it |

### 🟠 4. No levels of detail: everything is always computed — ⏳ pending

| Field | Detail |
| --- | --- |
| Where | `ProceduralHuman.update` runs the full pipeline (fingers, arm and torso springs, variation) for every character |
| What happens (FACT) | There is no way to tell a distant character to do less |
| Why it matters | 100 characters cost 22–31 ms even if most of them take up few pixels |
| Estimated impact | HYPOTHESIS: a far level (only root, gait, feet and IK, at 30 Hz) would cost a quarter or less |
| How to measure it | Cost per character at each level; visual "pop" when changing level |
| Solution (RECOMMENDATION) | A `lod` property (full / medium without fingers or fine springs / far at a lower frequency) that the application decides according to distance or visibility |
| Risk | Medium: visible jumps when changing level and feet that slide at a lower frequency |

### 🟠 5. Simulation coupled to Three's scene graph

| Field | Detail |
| --- | --- |
| Where | All the controllers read and write Three's bones directly |
| What happens (FACT) | The pose only exists in Three's objects: every read requires their matrices to be up to date (cause of #1), and the simulation can't leave the main thread |
| Why it matters | It limits scale: it prevents Web Workers, WASM or processing many characters in bulk |
| Estimated impact | HYPOTHESIS: with a pose buffer of its own, hundreds of characters in a worker |
| How to measure it | Cost per character with 100–500 characters; main-thread time |
| Solution (RECOMMENDATION) | Future version: internal pose (arrays of quaternions and matrices per character) computed in one pass and copied to the bones at the end |
| Risk | High: it touches every controller. Not before #1–#3 |

### 🟡 6. Substeps when the frame rate drops

| Field | Detail |
| --- | --- |
| Where | `ProceduralHuman.update` (`maxTimeStep` 1/30 s, `maxFrameTime` 0.25 s) |
| What happens (FACT) | Below 30 fps each `update` simulates 2 or more steps (up to 8): the cost doubles exactly when it is already slow |
| Why it matters | With many characters it can spiral: slower → more steps → slower |
| Estimated impact | 2× at 20 fps, 3× at 10 fps |
| How to measure it | Substeps per frame in the telemetry |
| Solution (RECOMMENDATION) | Document it and allow a larger `maxTimeStep` for crowds, or a substep limit based on a time budget |
| Risk | Low |

### 🟡 7. The cost grows with bones the locomotion doesn't use

| Field | Detail |
| --- | --- |
| Where | The cascades of #1 include face, finger and extra bones |
| What happens (FACT) | Rigify (161 bones, with a face) recomputes 50 % more matrices than Mixamo; in the torso alone, 434 vs 153 |
| Why it matters | A rig with a full face pays for bones it doesn't move |
| Estimated impact | It almost entirely disappears once #1 is fixed |
| How to measure it | Matrices per frame with different rigs |
| Solution (RECOMMENDATION) | Fix #1; meanwhile, export without the face bones if they aren't used |
| Risk | None |

### 🟢 8. Temporary objects per frame

FACT: 7–8 KB per frame and character (parameter objects, closures, small results); the GC is 0.2 % of the CPU and its longest pause with 100 characters was 1.2 ms. It isn't worth touching now: the details are in *Garbage collection*.

### 🟢 9. Locomotion math

FACT: gait, step planning, body prediction, springs, noise and the analytic IK add up to less than 15 %; planning only runs when each foot takes off (0.03 times per frame). Optimizing it wouldn't be noticeable.

## GPU / Three.js

The library doesn't add work to the GPU: a procedural character costs the same to render as one animated with clips.

- **FACT:** outside `three-procedural-locomotion/debug`, the library doesn't create geometries, materials or textures, nor does it flag anything with `needsUpdate`. It only writes bone positions and rotations and recomputes their matrices.
- **FACT:** the GPU work per character is Three's normal skinning: the deformation in the shader and uploading the bone matrices of each skinned mesh. Mixamo is 2 meshes (2 draw calls); your Rigify, 3 (body and eyes).
- **FACT, measured:** what the renderer does on the CPU before drawing (`scene.updateMatrixWorld` and `skeleton.update`) costs 0.35 ms with 10 characters and 4.6 ms with 100. It is separate from the locomotion and doesn't depend on it; the renderer recomputes all the matrices once more, even though the library already did.
- **HYPOTHESIS:** with 100 characters the GPU will be limited by draw calls (200–300) and skinned vertices, not by anything in the library. It needs measuring on your machine with `renderer.info` and WebGPU timestamps (see *What to measure*).

**Moving the locomotion to the GPU (compute shaders)?** It doesn't make sense now (RECOMMENDATION). Each character does a few hundred small chained operations (gait → steps → hips → IK → torso → arms), with branches, which the GPU runs poorly in parallel. Besides, Three reads the bone matrices from the CPU to draw: moving the computation to the GPU would require reading it back every frame (1–2 frames of latency) or rewriting skinning entirely. It would only pay off with hundreds or thousands of characters, and #1–#4 gain more first. What could go to the GPU in the future belongs to rendering, not the library: instancing skinned meshes for crowds.

## Garbage collection

The GC isn't a problem today (FACT, measured): 7–8 KB per frame and character, all small short-lived objects that die in the young generation. With 100 characters it is about 45 MB/s, a minor collection every \~20 frames of 0.7–1.2 ms and 0.1 % of the frame time in total; the V8 profile gives it 0.2 % of the CPU.

There are hardly any `new Vector3()`, `new Quaternion()` or `new Matrix4()` on the per-frame path (FACT): the working vectors and quaternions are created once in the constructors. The exception is one `Vector3` per frame in `TorsoController.trackHips` (`this.tmp.clone()`). This is what is created every frame:

| Where | What it creates | Per frame | Does it matter? |
| --- | --- | --- | --- |
| `LocomotionController.update` | Parameter objects for pelvis, torso and arms (with their left/right pairs) and 2 closures (`mix`, `relax`) | \~15 objects + 2 closures | No |
| `GaitController.update`, `liftAndPlant` | `before`, one event per take-off or landing, `{lift, plant}` on each phase query | 5–10 | No |
| `BodyController.nextTurn`, `nextSpeed` | `{heading, angularVelocity}`, `{speed, rate}` | 2 (20 when predicting a step) | No |
| `TwoBoneIK.solve` | Result `{reachable, error}` | 2 | No |
| `updateVariation`, `ArmController.integrate`, `updateGaitMode` | Closures (`n`, `scaleOf`, the one in `every`) and 2 `settleError` results when standing | 2–5 | No |
| `RaycastGroundDetector.castDown` (inside Three) | Array of hits and one object per hit (point, face, normal) | 1.5–5 raycasts | Only with detailed ground: 42 KB/frame standing on the track; fixed by #2 |
| `ProceduralHuman` `footstep` event | Copy of the position and the event object | \~2 per second | No |

Touching this now would be micro-optimization (🟢). It would only be worth it after #1, if with hundreds of characters the GC went above \~1 %: the parameter objects can be reused fields without changing anything else.

## Scalability

The cost grows linearly with the number of characters (FACT): nothing shared saturates, each character pays its own way. The ceiling is set by the ground used.

*(Original chart not exportable: cost per frame according to the number of characters, measured in Node with the library at the time — Xeon 2.8 GHz, 2 vCPU, Mixamo model, 300 warm-up frames; render = scene.updateMatrixWorld + skeleton.update.)*

With detailed ground the limit arrives much earlier, because the raycast dominates (23,520-triangle track, no BVH):

| Characters | Detailed ground | Bottleneck |
| --- | --- | --- |
| 1 | Standing: 7.3 ms per frame. Walking: a spike of \~27 ms on each step (15 raycasts of 1.8 ms) | Raycasts (#2, #3) |
| 10 | Walking: average 8 ms, p99 53 ms, maximum 71 ms (at least: part of the route went off the track) | Raycasts; the steps of several characters coincide in the same frame |
| 50 | Not viable (HYPOTHESIS: \~40 ms average and constant spikes) | Raycasts |
| 100 | Not viable | Raycasts |

On simple ground, the bottleneck with 50 and 100 characters is the matrices of #1 (71 % of the CPU). With 100, the CPU side of rendering (4.6 ms) adds up and, HYPOTHESIS, the 200–300 draw calls on the GPU. The GC isn't the limit in any scenario.

## What to measure

Today there is no instrumentation in the library or the demo (FACT): everything in this document came from external scripts that wrap Three's and the library's methods. Before optimizing, these measurements need to be repeatable with one command and comparable.

| Metric | What for | How to get it |
| --- | --- | --- |
| Frame time (CPU) and FPS: average, p50, p99, maximum | What the user notices; spikes matter as much as the average | `performance.now()` around `update` and `render` in the demo |
| `human.update` time per character | Cost of the library separate from rendering | The same, per character |
| Time per stage: body, gait, steps, pelvis, IK, torso, arms, fingers | Knowing where each improvement goes | Optional telemetry in `LocomotionController` (e.g. `human.stats`), off by default so that it costs nothing |
| Matrices recomputed per frame | Direct indicator of #1 (today 2,148 Mixamo, 3,218 Rigify) | Counter in the same telemetry |
| Raycasts per frame and µs per raycast | #2 and #3 | Counter in the `GroundDetector` (a wrapper) |
| Substeps per `update` | #6 | `ProceduralHuman.update` |
| Allocations and GC | Making sure it stays negligible | DevTools → Memory (allocation sampling) and Performance (GC events); in Node, a `PerformanceObserver` of type `gc` |
| GPU time | Knowing whether, with many characters, the limit moves to the GPU | `WebGPURenderer` with `trackTimestamp: true` and `renderer.resolveTimestampsAsync()` (exists in r186) |
| Draw calls and triangles | Rendering cost per character | `renderer.info.render.drawCalls` and `triangles` |

RECOMMENDATION, in this order:

1. `npm run bench` in Node, deterministic: characters {1, 10, 50, 100} × ground {plane, 25k mesh, 250k-triangle mesh} × {standing, walking, running, 180° turn, moveTo} × {Mixamo, Rigify}. JSON output with average, p99, maximum, matrices, raycasts and KB per frame, saved as the baseline.
2. Optional `human.stats` telemetry (times per stage and counters), with no cost when off.
3. A stress page in the demo: control of N characters and a panel with FPS, CPU ms (library and rendering), GPU ms, draw calls and raycasts.
4. Every optimization compares against the baseline and keeps the exact references identical.

## Ranking

Measure first, then tackle the matrices and the raycasts: they explain almost all the cost (71 % of the CPU on simple ground, 95 % on detailed ground) and can be fixed without changing the motion.

**1. First**

1. `npm run bench` and its baseline (*What to measure*, step 1): without it no improvement can be demonstrated.
2. Cascading matrices (#1), in three steps each verified with the exact references: remove duplicate passes, read from `matrixWorld` without walking the ancestors, one update per chain at the end of each stage. Goal: from 2,148 to \~400 matrices per frame.
3. Repeated raycasts (#3): `settleError` when standing and the root probe without movement. A small, low-risk change.

**2. Then**

1. Fast ground detector (#2): BVH or heightmap as an optional `GroundDetector`, and document when to use each.
2. Fewer raycasts per step (#3): arc height with fewer samples or only on non-flat ground.
3. `human.stats` telemetry and a stress page in the demo.
4. Levels of detail (#4), once the above is measured.

**3. Don't touch** (the cost/benefit doesn't justify it)

- The temporary objects and closures per frame (#8): 0.2 % of the CPU.
- The math of gait, steps, prediction, springs, noise and the analytic IK (#9): less than 15 % altogether.
- Moving the locomotion to the GPU: slower because of the data round trip, and it isn't where the cost is.
- The debugging helpers: they aren't on the library's path.

**4. For a future version**

- Internal pose separate from Three's bones (#5): enables Web Workers, WASM and processing many characters in bulk.
- Substeps limited by a time budget (#6).
- Crowds of hundreds: instancing skinned meshes in rendering and simplified animation at a distance.

The benchmarks of this audit were temporary scripts in the working environment, not in the project; step 1 of *First* makes them part of it.
