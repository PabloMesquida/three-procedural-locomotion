# Bone inventory while walking

[Español](../es/bone-inventory.md)

Which bones the library moves today, what moves them and how much, compared with what those bones do in a
person. It is the starting point for making the gait move **all** the bones that deform the body.

```bash
node scripts/run-tests.mjs zzz && node .test-build/tests/tools/boneInventory.js
# another model: PH_MODEL=modelos/human.glb PH_MAPPING=rigify (in PowerShell, with $env:PH_MODEL=…)
```

## How it is measured

- The character walks in a straight line at 1.2 m/s for 8 s. For each bone, it measures **how much it
  oscillates around its average pose**, not its rest pose (each skeleton has its own: T-pose, A-pose…).
- The rotation is expressed in the character's axes: **flexion** (lateral axis), **turn** (vertical axis)
  and **tilt** (forward axis). Range = 95th percentile − 5th percentile, in degrees. The pelvis is
  measured relative to the heading.
- **People**, measured the same way:
  - **CMU**: the four normal walking takes of the naturalness test (subjects 35 and 16, ~1.2 m/s). It is
    the reference: its license allows using it for tuning.
  - **SFU**: subject 0018 in their straight stretches (1.1–1.4 m/s). Local only
    ([naturalness](naturalness.md#sfu-captures)): it confirms or breaks ties, but no value comes from SFU
    alone. It is a single person, with a much more mobile pelvis and head than in CMU.
- Limits of the mocap:
  - The SFU knee rotates about a single axis: its "tilt" is the knee axis rotated with the thigh.
  - The CMU clavicles don't move in these takes (constant channels).
  - In both, the toe joint is poorly measured with markers.
  - The CMU skeleton has its legs 20° apart at rest, so its foot can't be compared in absolute values,
    only in ranges.

## What moves each part

Left side (the right one is symmetric). Flexion / turn / tilt, in degrees. Library: Mixamo model; with
Rigify it is the same except where noted.

| Segment | Mixamo | Rigify | Moved by | Library | CMU | SFU |
|---|---|---|---|---|---|---|
| Pelvis | `Hips` | `spine` | PelvisController | 3.3 / 9.8 / 7.8 (previously 0.2 of flexion) | 4.2 / 10.3 / 10.6 | 6.7 / 9.0 / 16.6 |
| Lower spine | `Spine` | `spine.001` | TorsoController | 4.2 / 5.9 / 6.2 (previously 3.1 / 5.9 / 8.7) | 3.0 / 4.7 / 11.4 | 3.0 / 4.3 / 3.7 |
| Middle spine | `Spine1` | `spine.002` | **nothing** | still | 1.2 / 6.6 / 2.6 | (included in the chest) |
| Chest | `Spine2` | `spine.003` | TorsoController | 0.0 / 6.0 / 2.7 (previously 0 of tilt) | 1.7 / 3.9 / 6.0 | 4.6 / 3.6 / 13.9 |
| Neck | `Neck` | `spine.004` | TorsoController (only resets it) | **still** | 3.1 / 1.6 / 2.0 | 7.4 / 6.4 / 3.6 |
| Upper neck | — | `spine.005` | **nothing** | still | 4.9 / 2.2 / 2.8 | — |
| Head | `Head` | `spine.006` | TorsoController | 3.3 / 3.8 / 1.4 | 1.7 / 1.0 / 1.0 | 15.0 / 4.7 / 6.6 |
| Clavicle | `LeftShoulder` | `shoulder.L` | ArmController | 0.4 / 5.7 / 0.0 | (doesn't move) | 5.9 / 7.1 / 4.1 |
| Upper arm | `LeftArm` | `upper_arm.L` | ArmController | 21.9 / 0.7 / 3.5 | 15.3 / 19.6 / 7.5 | 42.0 / 25.6 / 12.4 |
| Forearm | `LeftForeArm` | `forearm.L` | ArmController | 14.7 / 1.4 / 2.6 | 14.8 / 2.3 / 3.2 | 23.7 / 10.2 / 8.2 |
| Forearm twist | — | `forearm_twist.L` (optional) | TwistController | doesn't oscillate | 1.5 / 10.0 / 3.5 | — |
| Hand | `LeftHand` | `hand.L` | ArmController | 8.5 / 1.0 / 0.0 | 13.9 / 4.6 / 5.1 | 8.4 / 3.5 / 6.7 |
| Fingers, 1st phalanx | `LeftHandIndex1`… | `f_index.01.L`… | HandFingers | 10 / 1 / 0 (+ relaxed pose) | — | — |
| Fingers, 2nd and 3rd | `LeftHandIndex2-3`… | `f_index.02-03.L`… | HandFingers | fixed pose, they don't oscillate | — | — |
| Thigh | `LeftUpLeg` | `thigh.L` | LegIK | 44.9 / 13.8 / 15.0 | 44.5 / 10.2 / 16.2 | 45.1 / 19.5 / 26.6 |
| Leg | `LeftLeg` | `shin.L` | LegIK | 48.8 / 2.2 / 3.4 (Rigify: 40.4) | 52.5 / 2.5 / 4.3 | 69.7 / 4.9 / 11.9 |
| Foot | `LeftFoot` | `foot.L` | LegIK + FootRoll | 31.6 / 7.9 / 19.3 (Rigify: 36.7 / 2.2 / 2.4) | 30.8 / 22.0 / 9.8 | 34.1 / 17.3 / 25.9 |
| Toes | `LeftToeBase` | `toe.L` | FootRoll | 42.8 / 0.0 / 12.4 | 23.6 / 3.3 / 3.2 | 19.0 / 3.5 / 5.3 |
| Twist (optional) | — | `upper_arm_twist.L`… | TwistController | upper arm 9.6 of turn, thigh 6.1 | — | — |

## Bones nothing moves

| Model | Bones | What they are |
|---|---|---|
| Mixamo | `Spine1` | middle spine: without a mapping, the curve of the back bends only at `Spine` and `Spine2` |
| Mixamo | `*_End`, `*Index4`, `*Ring4`, `*Thumb4`, `HeadTop_End` | tips: they don't deform the mesh |
| Rigify | `spine.002`, `spine.005` | middle spine and upper neck, like `Spine1` |
| Rigify | `pelvis.L/R`, `breast.L/R` | pelvis and chest of the mesh: they follow their parent; they could bounce a little |
| Rigify | `palm.01–04.L/R` | palm: opening or cupping it with the relaxed hand |
| Rigify | `forearm.L.001` | second segment of this model's forearm |
| Rigify | `heel.02.L/R` | metarig helper for the heel: doesn't deform |
| Rigify | face (`jaw`, `eye.L/R`, `lid.*`, `brow.*`, `lip.*`…, ~90) | outside the gait: gaze, blinking, jaw |

## The Mixamo foot doesn't twist

In the inventory, the Mixamo foot seems to tilt 19° sideways and the Rigify one 2°. It isn't a fault of the
foot roll:

- The Mixamo model has **the toes pointing 16° outwards at rest** (Rigify: 2°), and the library keeps
  that angle when walking (16.2° in stance).
- The foot bends about **its own lateral axis**, which is rotated by those 16°. Seen in the character's
  axes, part of that flexion shows up as sideways tilt (in world space, the character's lateral axis tilts
  from −5° to 13°).
- Measured about the foot's own axis, the sideways tilt is **exactly 0°** in both models, in stance and
  in flight.

Two things that do come out of this:

- **The toe-out angle depends on the model**: 16° with Mixamo, 2° with Rigify, 0° with `base_pbr_test_03`.
  The clinical literature gives about 5–7° outwards when walking. A toe-out angle parameter, independent
  of the model, would make everyone walk the same.
- **The foot never twists sideways** on flat ground (inversion and eversion). In people it twists a few
  degrees: inwards at toe-off, outwards when taking the weight.

## What the gait is missing

Sorted by how much the usable data (CMU and the literature) supports it and by how noticeable it is.

1. **The upper arm barely rotates about its own axis.** Library: 0.7° of turn; CMU: 19.6°; SFU: 25.6°. In
   a hanging arm, the turn about the vertical is mostly the rotation of the humerus about its axis
   (inwards and outwards), not a swing out of the plane: measured with points, the CMU arm opens outwards
   when going forward (±4.7°; the library, ±2.3°, in the same direction), and **the wrist trajectory
   already matches** CMU's (`tests/tools/mocapArm.ts`). What is missing is the rotation of the humerus,
   which shows in the twist of the arm mesh and in the plane of the elbow. The size of the arm swing is
   left alone: CMU swings less than the library and SFU more.
2. ~~**The pelvis doesn't tilt forward and back.**~~ Done (`pelvisTiltSwing`): ±1.8° twice per stride;
   error against CMU from 1.3° to 0.2°; range of the bone from 0.2° to 3.3° (CMU: 4.2°). Its lateral drop
   is still somewhat short (7.8° vs 10.6° in CMU; see
   [naturalness](naturalness.md#what-the-cmu-mocap-doesnt-decide)).
3. ~~**The chest only turns.**~~ Done (`chestRollShare`): the chest does ~1/3 of the compensation of the
   pelvic drop (sideways tilt from 0° to 2.7°; CMU: 6°) and the lower spine the rest (from 8.7° to 6.2°).
   The ratio between the two is CMU's, but in CMU both move more (11.4° and 6°) and with phase offsets:
   that needs the middle spine (point 4). The shoulders stay just as level (error against CMU: 1.0° →
   1.1°).
4. **The middle spine doesn't move.** In CMU it takes part of the counter-rotation (6.6° of turn). The
   turn and tilt need to be distributed among all the segments of the spine.
5. **The neck doesn't move.** In CMU its two segments bend 3–5° at each step and the head barely at all
   (1–2°). The library's head moves somewhat more (3–4°): part of that movement should go to the neck.
   SFU moves head and neck much more (15°), but that subject is the exception.
6. **The wrist: no data to decide.** CMU's `lhand` bone is ~1 cm long (almost the whole hand is `lwrist`,
   which only rotates about the forearm), so CMU doesn't measure the wrist: measured with points, its hand
   barely departs from the forearm (±1°). SFU does measure it: somewhat more towards the body than the
   library (range 6° vs 3.4°) and less forward and back (±1.4° vs ±5°). With a single source (and local
   only), it is left alone.
7. **The forearm doesn't rotate** (pronation and supination): CMU, 10°. It would only show in rigs with a
   forearm twist bone.
8. **The fingers are a fixed pose**: only the first phalanx oscillates (10°). As a chain of pendulums,
   each phalanx would follow the previous one with some lag. There is no finger mocap: this is tuned by
   eye.
9. **The foot is rigid sideways** and its toe-out depends on the model (see above).

Unchanged:
- **Clavicle**: only SFU moves it more (CMU doesn't measure it). By the SFU rule, it isn't touched without
  support from the literature.
- **Toes**: the library bends them 43° and both mocaps ~20°, but markers measure that joint poorly and the
  clinical literature gives quite a lot more than the mocap.
- **Fine as it is**: the turn of the pelvis, the lower spine, the thigh, the forearm and the flexion of
  the foot match CMU.
- **To look at later**: with Rigify the knee bends less when walking (40° vs 49° with Mixamo and 52° in
  CMU), probably because of the proportions of the model.

## Mapping proposal

Without breaking the current mappings:

- **Intermediate spine and neck bones, automatic**: the bones in the parent chain between `spine` and
  `chest` (`Spine1`, `spine.002`) and between `neck` and `head` (`spine.005`) are detected automatically
  when creating the character, and the turn is distributed among all the segments. The inventory tool
  already finds them this way. The mapping doesn't need to change. An optional field (for example
  `spineChain: string[]`) would allow setting them by hand.
- **Neck**: TorsoController distributes the movement of the head between `neck`, the upper neck (if it
  exists) and `head`.
- **Palm** (`palm.*`): optional `palm` field in each hand's fingers, to cup it with the relaxed hand. Low
  priority.
- **Rigify mesh bones** (`pelvis.L/R`, `breast.L/R`): not mapped. They follow their parent, which already
  moves. The bounce is a secondary effect that can come later.
- **Face**: outside this stage.

This changes the public API (new optional fields in `HumanRigMapping`): it has to be approved first.
Points 1 and 9 of the list above don't need new bones: they can be done with today's mapping (2 and 3
were already done that way).
