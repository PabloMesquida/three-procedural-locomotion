# three-procedural-locomotion

[![CI](https://github.com/PabloMesquida/three-procedural-locomotion/actions/workflows/ci.yml/badge.svg)](https://github.com/PabloMesquida/three-procedural-locomotion/actions/workflows/ci.yml)

[Español](README.es.md)

Procedural human locomotion for Three.js: walks, runs, turns, crouches, jumps and goes to a point over any
ground, **without baked animations**. Everything is computed every frame from a speed and a heading: the rhythm
of the steps (gait), where to place each foot (footstep planning), legs with Two-Bone IK, foot placement on the
terrain and the posture of the body (pelvis, torso, head, arms, hands).

<!-- Add a GIF or screenshot here, and a link to the live demo once the website is published. -->

## Features

- **Gait measured against real people**: cadence, stride, foot roll (heel → toe), foot path during the swing,
  knees and arms tuned with CMU motion capture ([naturalness](docs/en/naturalness.md)); a test checks it.
- **Walking and running without separate modes**: it walks up to ~1.7 m/s and above that (`runStartSpeed`)
  gradually turns into a run, as a person does at about 2 m/s, with a flight phase, hip bounce and torso lean.
- **Believable turns**: it slows down according to the turn still to be made, tightens the curve, the head and
  chest anticipate the new heading and the feet land already pointing the right way (or pivot on the toes).
- **Feet on the terrain**: heel → sole → toe, tilting over bumps and slopes, low steps, toe clearance during the
  swing.
- **Stairs, detected from the geometry**: up and down, one step per tread with the whole foot on it, for any
  size of step up to `maxStepUp` / `maxStepDown`; beyond that it stops ([guide](docs/en/guide.md#stairs)).
- **Crouching, jumping and landing** with anticipation, push-off, tucked feet and cushioning.
- **Gradual twist** of arms and legs if the rig has `twist` bones (optional): the wrist and ankle don't twist
  abruptly ([skeletons](docs/en/skeletons.md#twist-bones)).
- **Point and click**: `moveTo(point, { run })` reaches the destination (±5–10 cm); if it is behind, it brakes
  and turns towards it in 2–3 steps, like a person, and sets off in a straight line.
- **Touching in passing**: with `touchables` (columns, walls, the railing of a bridge) it brings the hand over
  and rests the palm on them when passing by, without stopping; along a wall or a railing it keeps sliding the
  hand while it stays alongside; or by hand with `touch(point)` ([guide](docs/en/guide.md#touching-surfaces)).
- **A living body**: counter-rotation of pelvis and shoulders, weight shift, arms and fingers as damped
  pendulums, deterministic natural variation per seed (two characters never move the same way).
- **Styles and tuning on two levels**: `tired`, `sneaky`, `athletic` and `heavy` presets; eleven basic controls
  (tempo, stride, arm swing, intensity…) that move several parameters at once; and all 116 parameters one by
  one, adjustable at runtime and validated.
- **Walking in place**: `shiftOrigin` moves the character without changing its motion (a treadmill to tune
  while watching the effect, or a floating origin in large worlds).
- **Any size and proportions**: lengths scale with the model's leg length (from a child to a giant), and so do
  speeds and the rhythm of the steps, as for a person of that size. Tested with skeletons of different
  proportions (legs, torso, hips, arms, feet).
- **Rigs**: Mixamo and the Rigify metarig included; any other with a bone mapping.
- **Fast**: ~0.1–0.2 ms per character per frame on the CPU; `StaticGroundDetector` queries terrains with
  hundreds of thousands of triangles in microseconds.
- **Renderer**: `WebGPURenderer` (`three/webgpu`) or `WebGLRenderer`: the library only moves bones.

## Example

```ts
import { createProceduralHuman, mixamoMapping } from 'three-procedural-locomotion';

const human = createProceduralHuman({
  model: gltf.scene,      // humanoid model with a skeleton
  mapping: mixamoMapping, // which bone is each part of the body (or rigifyMapping, or your own)
  ground: [floorMesh],    // ground (or new StaticGroundDetector([...]) for large static terrains)
  preset: 'athletic',     // optional: walking style
});

human.moveTo(point, { run: true });                 // go to a point…
human.targetSpeed = 1.2; human.targetHeading = 0.5; // …or continuous control (m/s, rad)
human.targetCrouch = 1;                             // crouch (0–1)
human.jump();
human.on('footstep', ({ side, position }) => playStep(side, position));

// every frame
human.update(dt);
```

Scene requirements: meters (1 unit = 1 m) and Y axis up. The model, in T-pose or A-pose with its origin at the
level of the soles ([details](docs/en/skeletons.md#model-requirements)).

## Documentation

- **[User guide](docs/en/guide.md)**: creating the character, control, state, events, configuration, presets,
  size, custom ground, frame rate, teleporting, several characters, limitations.
- **[Parameter reference](docs/en/parameters.md)**: every parameter with unit, default value and presets
  (generated from the code).
- **[Using another skeleton](docs/en/skeletons.md)**: writing a rig mapping and model requirements.
- **[Naturalness](docs/en/naturalness.md)**: how the gait is compared with real motion capture (CMU) and
  results.
- **[Bone inventory](docs/en/bone-inventory.md)**: which bones the gait moves, what moves them and how much,
  compared with a person; what is missing.
- **[Development](docs/en/development.md)**: scripts, architecture, structure, tests, performance
  (`npm run bench`).
- **[Performance audit](docs/en/performance-audit.md)**: where the time goes, what was optimized and what is
  left.
- **[Example](examples/basic.ts)**: scene, click to move, WASD relative to the camera, jumping, crouching.

## Installing in another project

`three` is a *peer dependency*: your project provides it (tested from r150 to r186).

**Fixed version (recommended):**

```bash
# in this folder
npm pack                      # builds and generates three-procedural-locomotion-0.1.0.tgz

# in your project
npm install three
npm install ../path/to/three-procedural-locomotion/three-procedural-locomotion-0.1.0.tgz
```

To update it: bump `version` in `package.json`, run `npm pack` and install the `.tgz` again.

**Linked (to develop the library and test it at the same time):** in your project
`npm install ../path/to/three-procedural-locomotion`, and here `npm run build:watch`. So that Vite doesn't load
two copies of three, in your project's `vite.config.ts`: `resolve: { dedupe: ['three'] }`.

Public entry points: `three-procedural-locomotion` and `three-procedural-locomotion/debug` (visual helpers).
Internal paths are blocked on purpose.

## Development

```bash
npm install
npm test           # automated tests
npm run typecheck  # types of the library and the examples
npm run build      # library → dist/
npm run bench      # performance benchmark
```

Requires Node 20.19+ or 22.12+. The tests use `modelos/human_mix_propio.glb` (skeleton with Mixamo names, the
default) or `modelos/human.glb` (Rigify metarig). More in [Development](docs/en/development.md).

The meshes of both models come from [Human Base Meshes](https://www.blender.org/download/demo-files/#assets)
(Blender Studio, CC0). The skeleton with Mixamo names is our own (not made with Mixamo): it is generated by
`scripts/blender/rig-mixamo-names.py` from the Rigify one.

## Limitations

- Kinematic body: no collisions or physics; `moveTo` goes in a straight line, without pathfinding.
- Stairs: walking up and down straight flights (no running, curved or spiral stairs yet). No planned jumps to a
  different height.
- Verified rigs: Mixamo and the Rigify metarig. Others should work with their mapping, unverified.

## Citing this work

If this library supports something you publish, please cite it. See [CITATION.cff](CITATION.cff), or:

Mesquida, Pablo. (2026). three-procedural-locomotion: procedural human locomotion for Three.js.
https://github.com/PabloMesquida/three-procedural-locomotion

## License

This project is licensed under the MIT license. See [LICENSE](LICENSE).
