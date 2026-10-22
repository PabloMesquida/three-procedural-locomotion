# Using another skeleton (rig mapping)

[Español](../es/skeletons.md)

The library never guesses bone names: it takes a **mapping** that says which bone of the model is each part of
the body. `mixamoMapping` is the one for Mixamo rigs; for any other rig you write one just like it.

## 1. See the bone names

```ts
import { inspectSkeleton } from 'three-procedural-locomotion';

const gltf = await new GLTFLoader().loadAsync('/my-model.glb');
console.log(inspectSkeleton(gltf.scene).tree); // bone hierarchy, indented
```

Use the names **exactly as they appear there**: GLTFLoader sanitizes them
(it removes `[ ] . : /` and turns spaces into `_`), so `mixamorig:Hips` becomes `mixamorigHips`. The mapper
accepts both forms.

## 2. Write the mapping

```ts
import type { HumanRigMapping } from 'three-procedural-locomotion';

export const myMapping: HumanRigMapping = {
  hips: 'pelvis',
  left: { thigh: 'thigh_l', shin: 'calf_l', foot: 'foot_l', toe: 'ball_l' },
  right: { thigh: 'thigh_r', shin: 'calf_r', foot: 'foot_r', toe: 'ball_r' },
  spine: 'spine_01',
  chest: 'spine_03',
  neck: 'neck_01',
  head: 'head',
  leftArm: {
    shoulder: 'clavicle_l', upperArm: 'upperarm_l', forearm: 'lowerarm_l', hand: 'hand_l',
    // optional: phalanges of each finger, from the base to the tip
    fingers: { thumb: ['thumb_01_l', 'thumb_02_l', 'thumb_03_l'], index: ['index_01_l', 'index_02_l', 'index_03_l'] /* … */ },
  },
  rightArm: { shoulder: 'clavicle_r', upperArm: 'upperarm_r', forearm: 'lowerarm_r', hand: 'hand_r' },
};
```

(Example names: copy them from step 1, not from here.) `left` and `right` are the **character's** (its left
leg), not the screen's.

| Part | Required? | If missing |
|---|---|---|
| `hips` | Yes | Error |
| `left` / `right`: `thigh`, `shin`, `foot` | Yes | Error |
| `left` / `right`: `toe` | No (highly recommended) | The tip of the foot is assumed to be 15 cm in front of the ankle (unverified), the foot doesn't tilt over bumps, the toes don't bend when the heel lifts and **you have to pass `forward`** |
| `spine`, `chest` | No | No shoulder counter-rotation or trunk lean |
| `neck`, `head` | No | No head stabilization or anticipation |
| `leftArm` / `rightArm` (`upperArm`, `forearm`, `hand`; `shoulder` optional) | No | The arm stays in its rest pose |
| `fingers` of each arm (`thumb`, `index`, `middle`, `ring`, `pinky`: phalanges from the base to the tip) | No | The fingers stay as in the model's rest pose (often spread). If the last phalanges are missing, the available ones are used; a finger without a base is ignored |
| Twist bones: `thighTwist`, `shinTwist` (legs), `upperArmTwist`, `forearmTwist` (arms) | No | Each segment rotates as a whole: when the hand or foot turns about the axis of the forearm or shin, the wrist or ankle twists abruptly (see [Twist bones](#twist-bones)) |

A missing optional bone, or an incomplete arm, is not an error: it leaves a warning in `human.warnings`.

## 3. Check

`createProceduralHuman` throws `RigMappingError` (with the list in `error.problems`) if a required bone is
missing or if the leg chain is not direct. It also warns (`human.warnings`) about:

- duplicate bone names;
- a thigh that doesn't hang from the hips, or toes that aren't direct children of the foot;
- feet pointing the opposite way from what is expected (probably `left`/`right` swapped).

And about the model (`checkModel`, also exported), with what to check in each case:

- **scale**: a leg length outside 0.1–5 m (almost certainly exported in centimeters);
- **rest pose**: knees bent more than 20°, legs more than 25° from vertical (Y axis up? standing?), toes that
  aren't at ground level (feet not flat), legs of different length;
- **origin**: ankles below the model's origin or far above it (the origin must be at the soles);
- **proportions outside what is tested**: thigh/shin outside 0.7–1.5, hips outside 0.12–0.4 × the leg length,
  feet (ankle → toes) outside 0.1–0.25 ×;
- **forward**: no toe bone and no `forward`, or a `forward` that contradicts the feet.

The tested models (Mixamo, Rigify) produce none of them, and neither do the proportions the tests generate.

Always show the warnings during development:

```ts
for (const warning of human.warnings) console.warn(warning);
```

## Model requirements

- **Direct leg chain**: `shin` is a direct child of `thigh` and `foot` of `shin` (Two-Bone IK needs it). Twist
  bones go **in parallel** (children of the segment, outside the chain), not in between: see
  [Twist bones](#twist-bones).
- **Standing rest pose**: straight legs and feet flat on the ground (T-pose or A-pose). The ankle height, the
  position of the toes and the leg length are measured in that pose. The legs can be somewhat apart and the feet
  somewhat forward or back: when walking, the feet go at hip width (`stepWidth`) and `ankleBack` behind the
  hips, and the hips rise just enough for the legs to keep the extension they had at rest.
- **Origin at the level of the soles**: the root of the model (`gltf.scene`) is on the ground, between the feet.
- **Scale in meters and Y axis up** (as glTF exports). A larger or smaller model works (`bodyScale: 'auto'`),
  but it must be a human with normal proportions.
- **Forward**: estimated from the toes (ankle → toes). Without `toe` in the mapping it can't be estimated, and
  if the character walks sideways or backwards the estimate is wrong: in both cases pass `forward` (the world
  direction the model faces at rest, e.g. `new Vector3(0, 0, 1)`).

## Twist bones

A segment with a single bone rotates as a whole: if the hand turns 80° about the axis of the forearm, the
forearm mesh doesn't turn at all and all the twist is concentrated at the wrist ("candy wrapper" effect). Twist
bones distribute that rotation, like the `twist` bones of game skeletons (e.g. Unreal's):

| Bone | Child of | Covers | Every frame |
|---|---|---|---|
| `forearmTwist` | `forearm` | lower half of the forearm | receives half of the hand's rotation about the forearm axis |
| `shinTwist` | `shin` | lower half of the shin | receives half of the foot's rotation about the shin axis |
| `upperArmTwist` | `upperArm` | upper half of the upper arm | undoes half of the arm's rotation about its axis (the shoulder doesn't twist) |
| `thighTwist` | `thigh` | upper half of the thigh | undoes half of the thigh's rotation about its axis (the hip doesn't twist) |

- They are **direct children** of the segment and are **not** part of the chain (the hand is still a child of
  the forearm): IK and the arms don't see them. One with a different parent is ignored with a warning.
- Only their rotation about the segment axis is touched; their rest orientation can be anything.
- The mesh is weighted between the segment and its twist bone (in the half the table indicates).
- If the mapping names them and the model has none (e.g. `rigifyMapping` with a metarig without twist bones),
  a single warning is left and everything works the same, without gradual twist.

## Rigify (Blender)

`rigifyMapping` is for the Rigify **metarig**: the mesh weighted directly to its bones (`spine`, `thigh.L`,
`shin.L`, `foot.L`, `toe.L`, `spine.003`, `upper_arm.L`…). It is the simple way to export to Three.js: the
metarig is a clean skeleton, without controls.

```ts
import { rigifyMapping } from 'three-procedural-locomotion';
createProceduralHuman({ model: gltf.scene, mapping: rigifyMapping, ground: [floor] });
```

- The rig **generated** by Rigify (`rig`, with `DEF-*`, `ORG-*`, `MCH-*` bones) doesn't work as is: its legs
  have intermediate twist bones (`DEF-thigh.L.001`) and the chain is not direct. Also, when exported with
  "deform bones only", thighs, shoulders and arms end up hanging from the root instead of the spine.
- **Twist** (optional): `rigifyMapping` looks for `thigh_twist.L`, `shin_twist.L`, `upper_arm_twist.L` and
  `forearm_twist.L` (and `.R`). Add them to the metarig in Edit Mode, unconnected, with the segment as parent
  and the position of the equivalent DEF bone of the generated rig: `thigh_twist` = `DEF-thigh`, `shin_twist` =
  `DEF-shin.001`, `upper_arm_twist` = `DEF-upper_arm`, `forearm_twist` = `DEF-forearm.001`. If the mesh was
  already weighted to the generated rig, its vertex groups are renamed that way and the other `DEF-x` /
  `DEF-x.001` become `x`.
- In Blender, before exporting: parent the mesh to the metarig (select the mesh, then the metarig,
  **Ctrl+P → With Automatic Weights**), apply scale and rotation to both (**Ctrl+A → All Transforms**) and export
  to glTF with **Skinning** enabled.

## Verification status

- **Mixamo** (`modelos/human_mix_propio.glb`: a Human Base Meshes mesh with a custom skeleton that has the
  hierarchy and names of Mixamo, five fingers, A-pose and the root rotated 90° and scaled 0.01 like an imported
  Mixamo model; generated by `scripts/blender/rig-mixamo-names.py`): the default model of all the tests, which
  pass. The previous one, rigged with Mixamo's auto-rigger (3 fingers, T-pose), passed them too.
- **Rigify, metarig** (`modelos/human.glb`, A-pose): all tests pass
  (`PH_MODEL=modelos/human.glb PH_MAPPING=rigify npm test`). The exact references (golden) and the twist test
  while walking are skipped: they are made with the default model.
- The Mixamo model before these (`humanoid.glb`, with other proportions: feet 3 cm behind the hips and legs
  vertical at rest) also passes all the motion tests.
- **Other proportions**: from each model, the tests generate variants with longer or shorter legs, thighs, shins,
  torso, hips, arms and feet (±15–50 %) and combinations; all of them walk, run, jump and reach their
  destination with the same requirements (`tests/proportions.test.ts`).
- Other rigs should work with their mapping if they meet the requirements, but they are not verified: try them
  with the tests (`PH_MODEL=path/to/model.glb`; for a
  custom mapping, add it in `tests/helpers/sim.ts`). The tests rotate and scale any model so that it faces −Z
  and has the reference size: they test its proportions and its rig.
