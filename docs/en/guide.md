# User guide

[Español](../es/guide.md)

`three-procedural-locomotion` moves a Three.js humanoid model without animations: from a desired speed and
heading it computes the rhythm of the steps (gait), where to place each foot (footstep planning), the leg with
IK and the posture of the body (pelvis, torso, head, arms). It walks, runs, turns, crouches, jumps and goes to a
point, on any ground it can query with a ray.

Complete, type-checked example: [`examples/basic.ts`](../../examples/basic.ts).

## Creating the character

```ts
import { createProceduralHuman, mixamoMapping } from 'three-procedural-locomotion';

const gltf = await new GLTFLoader().loadAsync('/humanoid.glb');
scene.add(gltf.scene);

const human = createProceduralHuman({
  model: gltf.scene,          // the library moves and orients it
  mapping: mixamoMapping,     // bone names (other rigs: docs/en/skeletons.md)
  ground: [floorMesh],        // ground meshes, or your own GroundDetector
  preset: 'tired',            // optional: walking style
  config: { walkSpeed: 0.9 }, // optional: only what you want to change
});

// every frame, after giving commands and before rendering
human.update(dt);
```

| Option | Default | What it does |
|---|---|---|
| `model` | — | Root of the character (`gltf.scene`). It can hang from any object that is moved, rotated or uniformly scaled. |
| `mapping` | — | Which bone is each part of the body (`mixamoMapping`, `rigifyMapping` or your own). If a required one is missing it throws `RigMappingError`; warnings (about the mapping and the model: scale, rest pose, origin, proportions; see [skeletons](skeletons.md#3-check)) go to `human.warnings`. |
| `ground` | — | `Object3D[]` (raycast against those meshes and their children) or a `GroundDetector` (e.g. `StaticGroundDetector`, see [Ground](#ground)). |
| `forward` | estimated | Direction (world, horizontal) the model faces at rest. Estimated from the toes. |
| `preset` | — | `'tired'`, `'sneaky'`, `'athletic'` or `'heavy'`. |
| `config` | — | Parameters to change ([reference](parameters.md)). They take precedence over the `preset`. |
| `bodyScale` | `'auto'` | Factor for the lengths in the configuration (see *Character size*). |
| `speedScale` | `'auto'` | Speeds and rates adapted to the size, as between a child and an adult; `'off'`: those of the configuration (see *Character size*). |
| `maxTimeStep` | 1/30 s | Maximum simulation step (see *Irregular frames*). |
| `maxFrameTime` | 0.25 s | Maximum time simulated per call to `update`. |
| `seed` | 1 | Seed for the natural variation: characters with different seeds don't move the same way; the same seed repeats the same motion. |

Scene requirements: meters (1 unit = 1 m) and Y axis up.

**Renderer: WebGPU or WebGL.** The library only moves bones (on the CPU, a few microseconds per character) and
queries the ground with raycasts: it does not depend on the renderer. `examples/basic.ts` uses
`WebGPURenderer` (`three/webgpu`), which falls back to WebGL 2 if the browser has no WebGPU; with
`WebGLRenderer` it works the same. Your application can import Three from `three/webgpu` even though the
library imports from `three`: both share the same classes (`three.core.js`). Mesh skinning is done by the
renderer on the GPU.

## Control

Two ways, which can be mixed:

- **Continuous** (keyboard, gamepad, your own AI): `targetSpeed` (m/s) and `targetHeading` (rad). The body
  accelerates, brakes and turns towards them within its limits (acceleration, turn speed, lateral acceleration).
- **By destination**: `moveTo(point, { run })` goes to a point on the ground; if it is to the side, it turns
  while walking, in a tighter curve the closer it is; if it is behind (more than 120°), it brakes and turns
  towards it in 2–3 large steps that already move in the new direction (~1 s for 180°, like a person) and sets
  off in a straight line. It adjusts its speed so as not to circle around it and brakes to stop on it
  (±5–10 cm). Emits `arrive`. Setting `targetSpeed` or `targetHeading` by hand cancels it; so does `stop()`.

Also: `targetCrouch` (0 = standing, 1 = crouched), `jump()` (returns `false` if already jumping).

**Heading**: `0` = the orientation of the model when it was created; positive = to the left (seen from above,
counterclockwise). To turn towards a world direction `dir` (horizontal, normalized):

```ts
const current = human.locomotion.body.state.forward; // current direction (world)
const turn = Math.atan2(new Vector3().crossVectors(current, dir).y, current.dot(dir));
human.targetHeading = human.heading + turn;
```

**Changes of direction**: it does not turn on the spot or all at once. The larger the turn still to be made,
the more it slows down (`turnSlowdown`: with 180° to go it moves at ~0.55 × the speed; with 15°, the same) and
the tighter the curve; once the turn is complete it regains its speed. The head and chest look towards the new
heading first, and each foot lands already pointing where the body will go, without speeding up the steps; if
even so the leg would twist more than 20° (the foot that was already on the ground when the turn began), that
foot pivots on the toes. How fast it turns is set by `turnSpeed` and `maxLateralAcceleration`.

Running is not a separate mode: `walkSpeed` (1.4 m/s) is the normal walking speed, but it keeps walking, at a
brisk pace, up to `runStartSpeed` (1.7 m/s); above that the gait gradually turns into running (`runBlend`) over
`runTransition` (complete at about 2.3 m/s; a person switches at about 2 m/s) and it can accelerate up to
`runSpeed`. While crouching, speed is limited to `crouchMaxSpeed`.

## State

| Property | What it is |
|---|---|
| `position` | Position of the root (world). Read-only: to move it, see *Teleporting*. |
| `speed`, `velocity` | Horizontal speed (m/s) and velocity vector (world). |
| `heading` | Current heading (rad, same convention as `targetHeading`). |
| `gaitMode` | `'idle'` (still, feet on the ground) or `'walk'` (taking steps, walking or running). |
| `runBlend` | 0 = walking, 1 = running. |
| `crouch` | Current crouch (0–1). |
| `airborne`, `jumpPhase` | In the air; jump phase: `GROUNDED`, `TAKEOFF`, `AIRBORNE`, `LANDING`. |
| `moveTarget` | Destination of the current `moveTo`, or `null`. |
| `footPhase(side)` | `PLANT` (lands on the heel), `PLANTED`, `LIFT` (raises the heel) or `SWING`. |
| `legLength`, `bodyScale`, `speedScale` | Leg length of the model (m), length factor and speed factor. |
| `config`, `effectiveConfig` | Unscaled configuration / the one in use (lengths × `bodyScale`). |

## Events

```ts
const off = human.on('footstep', ({ side, position, speed }) => playStep(side, position, speed));
human.on('liftoff', ({ speed }) => {});        // takes off in a jump
human.on('land', ({ impactSpeed }) => {});     // lands (falling speed, m/s)
human.on('arrive', ({ position }) => {});      // reached the moveTo destination (not if cancelled)
human.on('touch', ({ side, point }) => {});     // placed a hand on a surface
off();                                         // or human.off('footstep', listener)
```

`footstep` is emitted when a foot touches the ground, also when landing from a jump (one per foot).
Positions passed to events are copies: you can keep them.

## Configuration

All parameters are optional and listed, with name, unit and default value, in the
**[parameter reference](parameters.md)**. They are validated: a misspelled name, a non-numeric or out-of-range
value throws `ConfigError` with the list of problems (`error.problems`) and nothing is applied.

```ts
human.setConfig({ stepHeight: 0.07, armSwing: 22 }); // at runtime, applied on the next frame
```

All of them can be changed at runtime except those marked ⚑ in the reference (currently only
`kneePoleDistance`), which log a warning. `setConfig` accumulates changes on top of the current configuration.

## Style presets

`tired`, `sneaky`, `athletic` and `heavy`. They are just sets of parameters (`stylePresets`); the reference
shows what each one changes.

```ts
createProceduralHuman({ ..., preset: 'sneaky', config: { walkSpeed: 0.8 } }); // config overrides the preset
human.applyPreset('heavy');                       // at runtime
human.applyPreset('heavy', { runSpeed: 2.8 });    // with your own changes on top
human.applyPreset('default');                     // no preset
```

`applyPreset` resets the **whole** configuration (defaults + preset + `overrides`): anything changed earlier
with `setConfig` is lost unless you pass it in `overrides`. For a style of your own, create an object with the
parameters and pass it as `config` or with `setConfig`.

## Basic controls

To change how it walks without going into the 116 parameters: eleven high-level controls (`basicControls`),
each of which moves several parameters at once. They are a layer on top of the configuration, like the presets:
`applyBasicControls(base, values)` returns the resulting parameters for `setConfig`.

```ts
import { applyBasicControls, defaultConfig, stylePresets } from 'three-procedural-locomotion';

human.setConfig(applyBasicControls(defaultConfig, { tempo: 1.2, armSwing: 0.6, intensity: 1.3 }));
// on top of a preset:
const base = { ...defaultConfig, ...stylePresets.tired };
human.setConfig({ ...base, ...applyBasicControls(base, { lean: 5 }) });
```

| Control | Range (neutral) | What it does |
|---|---|---|
| `tempo` | 0.6–1.6 (1) | faster or slower, with steps of the same size |
| `stride` | 0.7–1.2 (1) | longer and slower steps at the same speed |
| `stepHeight` | 0.3–2 (1) | how high it lifts the feet and how much the foot rolls |
| `knees` | 0–2 (1) | springier or stiffer gait |
| `hipSway` | 0–2.5 (1) | motion of the pelvis and of the weight |
| `armSwing` | 0–2.5 (1) | amplitude of the arm swing |
| `armSpread` | −5–20° (0) | how far the arms hang away from the body, standing, walking and running |
| `lean` | −10–25° (0) | posture leaning forward or upright |
| `looseness` | 0.5–2 (1) | loose body, with inertia, or stiff |
| `agility` | 0.4–2.5 (1) | starts, brakes and turns faster or slower |
| `naturalness` | 0–3 (1) | variation between steps |
| `intensity` | 0–1.75 (1) | scales step height, knees, sway and arm swing together |

Which parameters each one moves: `basicControls[i].params`; for a UI, `label` and `description` provide the name
and a one-sentence description in English and Spanish (`label.en` = "Tempo"…). Out-of-range values are clamped, and the whole range
of each control is tested (clean gait with the three test models). Technical parameters (cycle fractions,
probes, jumping, head, point and click…) can only be tuned one by one.

To combine them with manual tweaks, apply those afterwards: `{ ...base, ...applyBasicControls(base, values),
...manualTweaks }`; that way a basic control does not move a parameter tuned by hand.

## Hands

If the mapping includes the fingers (`mixamoMapping` and `rigifyMapping` do), the hand relaxes instead of staying
as in the model's rest pose (which usually has straight, spread fingers): each phalanx slightly bent towards the
palm, the fingers together and the thumb towards the index finger, and they follow the swing of the hand with a
small delay. `fingerCurl` (1 by default) sets how much: 0 = as in the model, more than 1 = a more closed hand.

## Touching surfaces

When walking past a column, a wall or the railing of a bridge, the character can bring its hand over and touch
it without stopping. You tell it what can be touched, just like the ground:

```ts
const human = createProceduralHuman({ model, mapping, ground: [floor], touchables: [columns, wall, railing] });
human.touchables = [otherZone];   // can be changed at any time (null = nothing)
human.autoTouch = false;          // don't touch on its own (by default, it does)
human.touchSlide = false;         // touch and let go, without sliding the hand (by default, it slides)
```

With `touchables` it searches by itself, with short rays from where the shoulder will be when the gesture
ends: walls and columns to the side or a little ahead (horizontal rays at chest height) and railings at hip
height (downward rays), but not faces it is walking straight into. It touches each object once while it stays
close (it doesn't touch a long wall at every step), with each hand on its own side (it can keep one on the wall
and touch columns with the other), walking or standing; not while running or in the air. It doesn't try what is
out of the hand's reach: it doesn't overstretch the arm.

The gesture, measured on the CMU reaches (see [naturalness](naturalness.md#touching-in-passing)): the
hand goes from its swing to the surface in ~0.75 s with a bell-shaped speed profile, along a slightly curved path
(the elbow bends halfway and straightens at the end); it rests with the palm towards the surface and the fingers
spread (in the direction the wrist turns least: up on a wall to the side, outwards on a railing). Walking along a
wall or a railing, it slides the hand along it while it stays alongside: it starts still, picks up the body's
speed and moves next to the shoulder, against the surface (on a wall, gradually lowering to waist height); when
the surface ends (the end of the wall, a corner) it lets go. A column is too curved to slide on: it touches it
and lets go once it is behind, as with `touchSlide = false`. Standing still, it lets go after a moment. The hand
hangs down again in ~0.7 s, starting from where it was and with the speed it had. The other arm keeps swinging.

By hand:

```ts
human.touch(point);                         // places it (and slides, when walking) and withdraws it as when passing by; false if out of reach
human.touch(point, { slide: false });       // without sliding
human.touch(point, { hold: true });         // keeps it there…
human.releaseTouch();                       // …until released (or until out of reach)
human.touch(point, { side: 'left', normal }); // hand and surface normal (otherwise found with touchables)
human.touchPhase('right');                  // 'none' | 'reach' | 'contact' | 'release'
```

Timings and reach are in the *Touching surfaces* section of the [reference](parameters.md#touching-surfaces).
If the rig has no fingers, the palm is taken to be the underside of the hand in the rest pose (T-pose).
A custom detector (physics, BVH…) implements `SurfaceDetector` (`cast(origin, direction, distance, out)`).

## Natural variation

A person never takes two identical steps. With `variation` (1 by default; 0 = all steps identical) the cadence,
the lean of the trunk, the gaze and the swing of each arm change slightly and slowly, with smooth noise that
depends on the character's `seed`. It is deterministic: the same seed repeats exactly the same motion (useful
for tests or replays). For a crowd, give each character its own seed.

## Character size

The lengths in the configuration (marked ↔ in the reference: step length, width and height, how much the hips
drop, clearances…) are meant for a 1.83 m human. With `bodyScale: 'auto'` (the default) they are multiplied by
*the model's leg length / 0.879 m*: a 1.1 m or 2.7 m character keeps its proportions without changing anything.
And with `speedScale: 'auto'` (the default) its speeds and rhythm also adapt to its size (see below).

- `bodyScale: 1`: lengths are used as they are, in meters.
- The values you pass in `config` / `setConfig` are always those of the reference character;
  `human.effectiveConfig` shows the scaled ones.
- Scaling the model (`gltf.scene.scale.setScalar(0.6)`) or a parent works: the leg length is measured in world
  space.

**Speeds according to size** (`speedScale: 'auto'`, the default). With only the lengths scaled, a small
character running at 3 m/s takes frantic little steps and a large one walking at 1 m/s seems to move in slow
motion. With `speedScale: 'auto'` they move as they really would (dynamic similarity, the relation between a
child's gait and an adult's): with *s* = `bodyScale`,

- speeds × √s (`walkSpeed`, `runStartSpeed`, `runSpeed`, `crouchMaxSpeed`, the jump speed…): a 1.1 m child
  (s ≈ 0.6) walks at ~1.1 m/s, starts running at ~1.3 m/s and runs at most at ~2.3 m/s;
- rates ÷ √s (steps per second, turn speed, spring frequencies) and durations × √s;
- accelerations and gravity, unchanged; jumps reach a height proportional to its size.

```ts
human.targetSpeed = human.config.walkSpeed * human.speedScale; // its walking speed
createProceduralHuman({ model, mapping, ground, speedScale: 'off' }); // speeds not adapted
```

At the reference size (`bodyScale` 1) nothing changes. With `'off'`, speeds, accelerations, gravity, times and
angles are not scaled: a child and a giant at 1 m/s both move at 1 m/s, each with steps of its own size.

`targetSpeed`, `speed`, `velocity` and the speeds in events are always real m/s; `config` keeps the values of
the reference character. It is exact: the same motion at another scale, with time × √s (the tests check it).
Internally, the simulation uses a geometric copy of the configuration (speeds and accelerations × s, which is
what `effectiveConfig` shows) and a clock that runs at 1/√s.

## Ground

With `ground: [meshes]` it does a vertical raycast against those meshes (and their children). It is best to
pass only the ground (not walls or the character itself). It works for moving ground, but Three's raycast goes
through every triangle: with meshes of thousands of triangles each character costs milliseconds.

**Large static ground** (terrains, stairs, cities): use `StaticGroundDetector`. It precomputes an index of the
triangles (once: ~0.1 s per 50,000, ~0.6 s per 500,000) and each query costs microseconds, whatever the size. It
returns the same ground as the raycast. Create one and share it among all characters:

```ts
import { StaticGroundDetector } from 'three-procedural-locomotion';

const ground = new StaticGroundDetector([terrainMesh, stairs]);
const a = createProceduralHuman({ model: modelA, mapping, ground });
const b = createProceduralHuman({ model: modelB, mapping, ground });

// If the ground changes (moves, is edited, another list): ground.targets = [...]; ground.rebuild();
```

It only reads regular meshes (`Mesh`); `InstancedMesh`, `SkinnedMesh` and `BatchedMesh` are ignored with a
warning. For ground that moves every frame (platforms, elevators), use the raycast (`ground: [meshes]`), or
combine both with your own `GroundDetector` that queries both and keeps the highest.

For another system (heightmap, physics engine), implement `GroundDetector`:

```ts
const heightmapGround: GroundDetector = {
  castDown(origin, maxDistance, out) {
    const y = heightAt(origin.x, origin.z);
    if (origin.y - y > maxDistance || y > origin.y) return false;
    out.point.set(origin.x, y, origin.z);
    out.normal.copy(normalAt(origin.x, origin.z)); // unit length, pointing up
    out.distance = origin.y - y;
    return true;
  },
};
```

The body is kinematic: there are no collisions with obstacles or walls; it only looks for the ground under the
body and under each foot. Low steps and moderate slopes do work: the feet rest at their height and tilt.

Ground queries per character: one per frame (under the body) and about 14 at the start of each step (where it
lands and where the toes pass). When standing still, if the ground under the feet changes without the body
moving (an object that appears, a `setConfig` change), it repositions itself within 0.25 s at most.

## Irregular frames

`update(dt)` splits long frames into steps of at most `maxTimeStep` and never simulates more than
`maxFrameTime` per call: the motion does not depend on the frame rate and a stall (switching tabs) does not
cause a jump. Pass the real `dt` (`clock.getDelta()`); `dt ≤ 0` does nothing.

## Walking in place and floating origin

`human.shiftOrigin(offset)` moves the character without changing its motion: it keeps walking, running or
flying through the air exactly the same, with the feet, the trajectories and the `moveTo` destination shifted
along with it (unlike moving it and calling `reset()`, which stops it).

```ts
// In place (treadmill): every frame, give back what it moved horizontally.
human.update(dt);
const p = human.position;
human.shiftOrigin(new Vector3(anchor.x - p.x, 0, anchor.z - p.z));

// Floating origin (large worlds): shift the ground and the character together.
world.position.add(offset);
human.shiftOrigin(offset);
```

The ground does not move with it: at the new place it has to be the same (flat for walking in place, or the
same ground shifted). With `StaticGroundDetector`, if you move the ground, call `rebuild()`.

## Teleporting, pausing, removing

- **Teleporting**: move `gltf.scene` (or its parent) and call `human.reset()`: it leaves it standing still,
  with the feet on whatever ground is below (up to 50 m), and cancels `moveTo`.
- **Releasing control** (e.g. for another animation): `human.restPose()` returns the skeleton to its rest pose;
  `reset()` takes control again.
- **Removing**: `human.dispose()` (rest pose and no subscriptions). The model is still yours.
- While it is active, don't move or rotate the model or its leg, hip, torso or arm bones.

## Several characters

Each `createProceduralHuman` is independent (its own configuration, state and events). Sizes, styles and rigs
can be mixed in the same scene; each one needs its own model (`SkeletonUtils.clone` to copy a loaded one). The
ground detector is shared: one `StaticGroundDetector` (or `GroundDetector`) for all of them. Approximate cost of
`update` per character: ~0.1–0.2 ms (with `StaticGroundDetector`, also on large meshes); `npm run bench`
measures it on your machine.

## Advanced

- `human.locomotion` and `human.navigation`: internal controllers (gait, feet, pelvis, body, point and click).
  Useful for debugging; their shape may change between versions.
- The building blocks are exported too (`TwoBoneIK`, `LegIK`, `FootPlacement`, `mapHumanRig`,
  `inspectSkeleton`…).
- `three-procedural-locomotion/debug`: visual helpers (`LocomotionDebug`, `GaitDiagram`, `RigDebug`, `IKDebug`,
  `FootDebug`). `GaitDiagram` shows its text in English; for Spanish:
  `new GaitDiagram(human.locomotion.gait, { language: 'es' })`.

## Current limitations

- No collisions or physics (the body doesn't collide with obstacles); `moveTo` goes in a straight line, without
  pathfinding.
- No planned stairs or jumps to a different height (only bumps and low steps).
- Tested rigs: Mixamo and the Rigify metarig. Other rigs should work with their mapping, but they are not
  verified (see [skeletons](skeletons.md)).
