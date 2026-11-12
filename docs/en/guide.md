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
gltf.scene.position.set(2, 0, -3); // where it starts (optional): it stands there, on the ground below
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
| `colliders` | — | What isn't ground and it mustn't go through (tree trunks, columns, walls, railings, furniture): meshes or vertical cylinders `{ center, radius, height? }`. `moveTo` goes round them; with your own controls it slides along them (head-on, it stops in front). A mesh counts by the box of its geometry, turned like it: give it simple shapes (an invisible cylinder for a tree trunk; a detailed tree would block the whole box of its crown). Only what is between the step it can take and its height counts (it passes under a beam). They can be the same meshes as `touchables`. Also `human.colliders = […] | null`. |
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
  If something it can't step is in the way (a riser higher than `maxStepUp`, a drop deeper than
  `maxStepDown`, a hole), it plans a route round it when it is given the destination and follows it from the
  start, turning along curves, without going up to it first; it goes up a platform by its stairs. If the point
  can't be reached, it goes to the reachable one closest to it (`moveTarget`). It plans on the ground it walks
  on, with the same rules as the steps, and goes round the `colliders` (a tree trunk, columns, walls) keeping
  its body clear of them. With `avoid: false`, in a straight line.
- **Click to move**: raycast the ground on `click` and give `moveTo` the point. With OrbitControls (or any camera
  control with the mouse), don't use `pointerdown` alone: it also fires at the start of every drag of the camera.
  Keep where `pointerdown` was and, on `click`, ignore it if the pointer moved more than a few pixels (see
  [`examples/basic.ts`](../../examples/basic.ts)).
- **Along a route**: `followPath(points, { run })` follows the points given (e.g. from your own navmesh) with
  curves and stops on the last one; it doesn't check them.

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
| `moveTarget` | Destination of the current `moveTo` (or `followPath`), or `null`. |
| `movePath` | What is left of its route (points, a copy; the last one is `moveTarget`), or `null` if it goes in a straight line. |
| `footPhase(side)` | `PLANT` (lands on the heel), `PLANTED`, `LIFT` (raises the heel) or `SWING`. |
| `footGround(side)` | What the foot placement found under the foot (for `FootDebug`, see *Advanced*). |
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
| `armForward` | −15–15° (0) | arms further forward or back, standing and as the centre of the swing |
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
ends (also going up or down stairs or a ramp): walls and columns to the side or a little ahead (horizontal rays
at chest height), with room for the palm (not a thin post or the side of a handrail), and railings at hip height
(downward rays) that go on ahead (not the top of a newel post), but not faces it is walking straight into. It
touches each object once while it stays
close (it doesn't touch a long wall at every step; stopping and walking on is another pass, and it can touch it
again), with each hand on its own side (it can keep one on the wall
and touch columns with the other), walking or standing; not while running or in the air. It doesn't try what is
out of the hand's reach: it doesn't overstretch the arm.

Walking past a column or a trunk, the path has to go with its surface between ~0.2 and ~0.55 m from the body's
centre (measured with the reference character: a trunk 15 or 30 cm in radius): closer, the arm would be too
bent; further, it doesn't reach (`touchMaxReach`). With the trunk as a collider too, `moveTo` already goes round
it at that distance.

Give it simple shapes. Walking, it casts about 150 rays per second (more while it slides the hand), and three's
`Raycaster` has no acceleration structure: it tests every triangle of each mesh whose bounding sphere the ray
crosses, so a detailed mesh (a tree of 60,000 triangles) is expensive. Put a simple invisible mesh in its place
(`visible = false`: the rays still hit it) and give that one: a cylinder for a trunk, boxes for a wall. The same
mesh can be a collider. The hand rests on that shape, so make it fit the visible surface.

The gesture, measured on the CMU reaches (see [naturalness](naturalness.md#touching-in-passing)): the
hand goes from its swing to the surface in ~0.75 s with a bell-shaped speed profile, along a slightly curved path
(the elbow bends halfway and straightens at the end); it rests with the palm towards the surface and the fingers
spread (in the direction the wrist turns least: up on a wall to the side, outwards on a railing). Walking along a
wall or a railing, it slides the hand along it while it stays alongside: it starts still, picks up the body's
speed and moves next to the shoulder, against the surface (on a wall, gradually lowering to waist height); when
the surface ends (the end of the wall, a corner) or stops being smooth (a step, or something sticking out ahead,
like a pilaster, before the fingers get there) it lets go, and once past it rests the hand again. A column is
too curved to slide on: it touches it and lets go once it is behind, as with `touchSlide = false`. Standing
still, it lets go after a moment.

To keep the hand on a column, a tree trunk or a curved wall while walking round it, give the smallest radius it
should follow: `config: { touchCurveRadius: 0.05 }` (m; 0 by default). Then it also looks for the surface where
the shoulder will be following the turn of the body, the hand goes beside the shoulder (on the inside of the
curve it travels less than the body: ~0.17 of it round a 10 cm trunk) with the palm turning with the surface,
it lets go when the surface ends, the arm doesn't reach or the body moves away, and it can rest it again on the
same object in the same turn. The palm turns smoothly with the normals of the mesh: with smooth normals (shared
vertices, as `CylinderGeometry`), continuously; with flat normals (one per face) the normal is smoothed over 0.1 s
so the hand doesn't jump between faces. It costs one more ray per frame while it slides (~60 per second). The hand
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

**Tall blocks.** The ground is searched from `groundProbeHeight` (1.5 m) above the feet, but a block that is
taller (a platform, a big rock, a hill of the terrain) is still a wall, not something the character walks into:
if the ray starts inside it (the nearest surface above is its top, seen from inside, and not a ceiling seen from
below), both detectors return its top. For that, the block needs a single-sided material (`FrontSide`, the
default, or `BackSide`): a `DoubleSide` face has no inside. An up-facing surface with nothing in between counts
as the top of what is below it (as in a terrain mesh): make an upper floor or a bridge the character walks under
with some thickness (a box), not a single plane. The character walks under something whose underside is higher
than `groundProbeHeight`.

For another system (heightmap, physics engine), implement `GroundDetector`:

```ts
const heightmapGround: GroundDetector = {
  castDown(origin, maxDistance, out) {
    const y = heightAt(origin.x, origin.z);
    if (origin.y - y > maxDistance) return false;
    out.point.set(origin.x, y, origin.z);
    out.normal.copy(normalAt(origin.x, origin.z)); // unit length, pointing up
    out.distance = origin.y - y; // negative if the ground is above the origin (inside a hill): a wall
    return true;
  },
};
```

The body is kinematic: it only looks for the ground under the body and under each foot (obstacles that aren't
ground, only if you give them as `colliders`). Low steps and moderate slopes do work: the feet rest at their
height and tilt. So does irregular ground without steps, like a pile of rocks: each foot rests on the highest
point under it (over a gap between rocks the sole can be a few centimetres above the ground under the ankle), and
the body follows the ground (tested on mounds of rocks up to 0.8 m high: `tests/rocks.test.ts`).

### Stairs

Stairs and steps are detected from the geometry, with nothing to mark: when a step would land on a change of
level, the character samples the ground ahead along its direction of travel, finds the edges, and:

- puts each foot on one tread, whole (the heel overhangs only if the tread is shorter than the foot), without
  skipping any: one step per tread, up or down;
- slows down so that each step takes one tread, and speeds up again gradually when the stairs end;
- the body follows a smooth line over the treads instead of the ground right under it and leans forward a
  little (more going up than down), and the foot in the air clears the edges with the whole sole (heel and
  tips of the toes): going up it rises first; going down it first moves forward over the edge and then drops;
  on a step the foot doesn't land on the heel: flat going up, on the ball of the foot going down; going up, the
  trailing foot raises its heel as much as needed to push off;
- a riser higher than `maxStepUp` is a wall: it stops in front of it; from a drop deeper than `maxStepDown`
  it doesn't step down: it stops at the edge (both 0.35 m by default, scaled with the size). It looks far
  enough ahead to brake in time, also running, and remembers the edges while it is nearby (which way they run
  and where they end; both of a corner), so it also brakes in front of them when it comes at them at an angle,
  turns towards them or sets off towards them again (several `moveTo` in a row next to them), and walks along
  them or round a corner without stopping. It stops with its feet in front of the edge, also coming at it at an
  angle, and if it ended up closer (it came along it), it moves back over its feet. The body never crosses it
  (a `moveTo` plans a route round it; with `avoid: false`, or with your own controls, it stops in front of it).

Any size of step works up to those limits (tested from 10 × 40 cm to 30 × 30 cm, up and down). The shape of the
step, the lean and the landing are compared with motion capture of people on stairs (CMU).

So that the tips of the toes don't go into a riser nor the heel hang over an edge, when the character is created
it measures how far its feet reach ahead of the ankle and behind it on the model's mesh (the sole and the shoe:
the vertices the foot, the toes or the shin move, below the ankle). Models differ a lot: with a toe joint
placed far back, the tips can be 25 cm ahead of the ankle. Without meshes (only the skeleton) it assumes the
usual proportions.

Stairs without risers (separate treads with a gap between them) also work, with the ground under them or over
the void: a gap shorter than the foot, lower than the treads on both sides, is stepped over, and the step is
measured from tread to tread. Where there is no ground under the root (over a gap), the body follows the line
over the treads. A wider gap without ground is a drop deeper than `maxStepDown`: it stops at the edge.

Curved and spiral stairs work too, going up and down either way: while the body turns, the ground is sampled
along the arc the foot follows (around the center of the turn) instead of in a straight line, the landing
moves along that arc, and the depth of the treads is taken where the body goes (they are narrower inside).
To follow curved stairs, turn it along them (`targetHeading`) or give it the route with `followPath`. On a tight spiral it has to go slowly: `turnSpeed` limits how tight it
can turn (at 1 m/s and 60°/s, a radius of about 1 m). Tested on spirals of 1–1.4 m and curves of 5 m.

Ground queries per character: one per frame (under the body) and about 15 at the start of each step (where it
lands and where the toes pass), plus one every other step far ahead (a wall or drop to brake for in time;
about 10 more when the ground there is out of reach of a step, or about 35 the first time it finds a wall, and about 25 per step while it walks along one). On stairs, about
50–90 per step instead (the profile of the ground ahead). When
standing still, if the ground under the feet changes without the body moving (an object that appears, a
`setConfig` change), it repositions itself within 0.25 s at most.

## Irregular frames

`update(dt)` splits long frames into steps of at most `maxTimeStep` and never simulates more than
`maxFrameTime` per call: the motion does not depend on the frame rate and a stall (switching tabs) does not
cause a jump. Pass the real `dt`, in seconds: the time since the previous frame, for example from the `time`
that `renderer.setAnimationLoop` passes to each frame. `dt ≤ 0` does nothing.

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

- **Where it starts**: place the model (`gltf.scene.position`, or its parent) before `createProceduralHuman`: it
  starts standing there, with the feet on whatever ground is below (the constructor calls `reset()`).
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
- `three-procedural-locomotion/debug`: visual helpers. Each one has a `group` (or, `GaitDiagram`, an HTML
  `element`) to add, and an `update()` to call after `human.update(dt)`:

  ```ts
  import { FootDebug, GaitDiagram, LocomotionDebug, RigDebug } from 'three-procedural-locomotion/debug';

  const debug = new LocomotionDebug(human.locomotion); // neutral positions, landings, swing paths, centre of mass
  const feet = (['left', 'right'] as const).map((side) => new FootDebug(human.footGround(side))); // foot raycasts
  const bones = new RigDebug(human.rig); // the mapped bones
  const gait = new GaitDiagram(human.locomotion.gait); // phases of the gait ({ language: 'es' } for Spanish)
  scene.add(debug.group, bones.group, ...feet.map((f) => f.group));
  document.body.append(gait.element);

  // every frame, after human.update(dt)
  debug.update(); bones.update(); gait.update();
  for (const f of feet) f.update();
  ```

  `IKDebug` shows the leg IK of a hand-placed target (`new IKDebug(human.rig.left, target, pole, color)`).

## Current limitations

- No physics: the body is kinematic. It only avoids what it can't step on the ground and the `colliders` you
  give it (seen from above, between its step and its height). Planning a route costs a few thousand
  ground queries once, when it is given the destination (about 1,500–10,000; up to ~18,000 if it can't be
  reached), only if the straight line isn't clear: with `StaticGroundDetector`, a few milliseconds.
- Stairs: walking only (not running yet). Going down, the leading leg lands almost straight (a person
  lands with the knee bent; see [naturalness](naturalness.md#stairs)). No planned jumps to a different height
  either.
- Tested rigs: Mixamo and the Rigify metarig. Other rigs should work with their mapping, but they are not
  verified (see [skeletons](skeletons.md)).
