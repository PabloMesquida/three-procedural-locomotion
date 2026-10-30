# Naturalness: comparison with motion capture

[Español](../es/naturalness.md)

The library doesn't play recorded animations: all the motion is procedural. But whether it looks natural
can be **measured**. To do so, it is compared with real motion capture from the
[CMU database](https://mocap.cs.cmu.edu): people's gait and the character's are analyzed the same way, at
the same relative speed, and compared curve by curve.

## How it is compared

- **Body points, not bones**: hips, knees, ankles, base of the toes, shoulders, elbows, wrists, pelvis,
  base of the neck and head. That way the analysis is the same for the CMU skeleton and for any rig of
  the library (`tests/helpers/gaitAnalysis.ts`).
- **Events** (method of Zeni et al., 2008): heel strike = ankle furthest forward relative to the pelvis;
  toe-off = toes furthest back. Each cycle goes from one heel strike to the next one of the same foot and
  is normalized to 0–100 %. Both sides are averaged.
- **Same relative speed**: the character walks with the same Froude number (v² / (g·leg)) as the person.
  Lengths are measured in leg lengths.
- **What is measured**: cadence, stride, stance and double-support fractions, step width, toe clearance;
  and, over the cycle, thigh, knee, ankle, foot pitch, ankle and toe heights, position of the ankle
  relative to the hip, height and side-to-side motion of the pelvis, its rotation, lateral drop and tilt
  oscillation, rotation and lateral tilt of the shoulders, trunk, upper arm (also in the frontal plane),
  forearm, elbow and wrist.
- **Bone by bone**: `tests/tools/boneInventory.ts` measures how much each bone rotates, in the
  character's axes, compared with CMU and SFU ([bone inventory](bone-inventory.md)).

## Using it

The captures are not versioned (third-party license). They are downloaded to `recursos/mocap-cmu/`
(ignored by git) from `https://mocap.cs.cmu.edu/subjects/<subject>/<file>`:

| Subject | Files | Content |
|---|---|---|
| 35 | `35.asf`, `35_01.amc`, `35_02.amc`, `35_03.amc`, `35_17.amc`, `35_18.amc` | walking; jogging |
| 16 | `16.asf`, `16_15.amc`, `16_17.amc`, `16_33.amc` | walking; 90° turn; slow walking and stopping |
| 07 | `07.asf`, `07_04.amc`, `07_12.amc` | slow walking; fast walking |
| 17 | `17.asf`, `17_01.amc`, `17_03.amc`, `17_06.amc`, `17_08.amc` | styles: angry, sneaky, happy, heavyset |
| 36, 39, 47 | `36.asf`, `36_02.amc`, `36_03.amc`, `36_09.amc`, `39.asf`, `39_11.amc`, `47.asf`, `47_01.amc` | walk, turn around and come back |
| 69 | `69.asf`, `69_06.amc`, `69_07.amc`, `69_08.amc`, `69_13.amc` | walking and turning around (repeated); turning in place |
| 144, 13, 14, 81, 22 | `144.asf`, `144_22.amc`–`144_25.amc`, `13.asf`, `13_10.amc`, `13_12.amc`, `14.asf`, `14_07.amc`–`14_09.amc`, `81.asf`, `81_10.amc`, `22.asf`, `22_18.amc` | reaching to the sides and up; pushing something high; resting the hands (for touching in passing) |
| 83, 111, 113, 114, 143 | `83.asf`, `83_27.amc`–`83_32.amc`, `83_34.amc`, `83_35.amc`, `111.asf`, `111_27.amc`, `113.asf`, `113_19.amc`, `113_20.amc`, `114.asf`, `114_07.amc`–`114_09.amc`, `143.asf`, `143_17.amc` | stairs: going up (83); going up and down (the rest; 111, 113 and 114 are pregnant or postpartum women) |

```bash
npm run mocap                  # normal walking: mocap vs library, curve by curve
npm run mocap -- 35_17         # one take (or a type: walk, run, style); CURVES=1 adds the curves
npm run mocap -- swing         # shape of the foot in the air in the mocap
npm run mocap -- referencia    # regenerates tests/reference/cmu-caminar.json
```

`tests/reference/cmu-caminar.json` stores only the **per-cycle averages** of the four normal walking
takes (not the original data). The test `tests/naturalness.test.ts` uses them to check that the
library's gait doesn't drift away from a person's: if a change makes it worse, it fails.

Data license: free to use (also commercially), without reselling the data, not even converted.
CMU asks for this acknowledgment: *The data used in this project was obtained from mocap.cs.cmu.edu.
The database was created with funding from NSF EIA-0196217.*

### SFU captures

A second source, **for local measurement only**: the [SFU database](https://mocap.cs.sfu.ca) (BVH at
120 fps, in inches, Y up; reader in `tests/helpers/bvh.ts`). They are downloaded to `recursos/mocap-sfu/`
(ignored by git) from `https://mocap.cs.sfu.ca/nusmocap/<file>.bvh`:

| Subject | Files | Content |
|---|---|---|
| 0005 | `0005_Walking001.bvh`, `0005_BackwardsWalk001.bvh` | walking (with curves); backwards in a circle |
| 0007 | `0007_Walking001.bvh` | walking, long take |
| 0008 | `0008_Walking001.bvh`, `0008_Walking002.bvh` | walking in circles; walking with swagger and poses |
| 0018 | `0018_Walking001.bvh`, `0018_TipToe001.bvh`, `0018_Catwalk001.bvh` | straight lines with increasing stride; tiptoeing; catwalk |

```bash
npm run mocap -- sfu           # normal walking (0005, 0007, 0008): average of the straight stretches
npm run mocap -- 0018          # one take (or a type: sfu-walk, sfu-style); CURVES=1 adds the curves
```

The skeleton has 21 animated bones: pelvis, two spine segments (`Spine`, `Spine1`), neck, head,
clavicles, upper arm, forearm, hand, thigh, leg, foot and toes. The knee, the elbow and the toes rotate
about a single axis. It has no fingers: `HandThumb` and `*_Wrist_End` don't move. It has fewer bones than
the CMU one: what it adds is other people and other ways of walking.

Data license: **research only**. They cannot be used in commercial products or resold. That is why
nothing from SFU is stored in the repo (not even averages, as with CMU) and no default value comes from
SFU alone: it confirms or breaks ties between what CMU and the clinical literature say. SFU asks for this
acknowledgment: *The data used in this project was obtained from http://mocap.cs.sfu.ca. The database
was created with funding from NUS AcRF R-252-000-429-133 and SFU President's Research Start-up Grant.*

What was seen when comparing it with CMU:

- **Almost everything is walking in curves**: 0005 and 0008 turn more than 20 °/s almost all the time and
  0007 has a single straight stretch (one cycle). Gait analysis assumes a straight line, so only stretches
  with less than 12 °/s of turning for 2 s or more are used. For straight-line walking, 0018 is the most
  useful; the curved takes will be useful for turns.
- **0018 changes stride at a fixed cadence** (that is what was asked): ~121 steps/min at 1.1 and at
  1.4 m/s, with the stride going from 1.35 to 1.72 legs. It doesn't show how cadence changes with speed.
- **Knee almost straight in stance** (1–7°, as in the clinical literature and in CMU subject 07; CMU
  subjects 35 and 16 don't go below 13°). It confirms that the knee offset comes from the calibration of
  those skeletons.
- Between people, step width varies a lot (0.12–0.24 legs), as do the lateral drop of the pelvis (±4.6°
  in 0007, ±8.9° in 0018; CMU ±5°) and the elbow (SFU keeps it almost straight, CMU at 20–35°).

## Results (walking at 1.2 m/s)

Root mean square error of each curve against the mocap average, before and after tuning the library with
these measurements:

| | mocap | before | now |
|---|---|---|---|
| Cadence (steps/min) | 105 | 121 | 107 |
| Stride (× leg) | 1.60 | 1.39 | 1.57 |
| Stance / double support | 0.62 / 0.24 | 0.64 / 0.28 | 0.63 / 0.27 |
| Toe clearance (× leg) | 0.031 | 0.114 | 0.037 |
| Thigh | — | 8.4° | 4.7° |
| Knee | — | 13.1° | 7.5° |
| Ankle | — | 22.6° | 4.0° |
| Foot pitch | — | 23.1° | 4.7° |
| Upper arm | — | 11.4° | 4.3° |
| Elbow | — | 13.7° | 5.3° |
| Pelvic tilt oscillation | ±1.8° | 1.3° | 0.2° |

What changed, and why:

- **Cadence ∝ √speed.** In the mocap the cadence follows f ≈ 1.6·√v steps/s (the rest of the speed comes
  from the step length). Before, it grew linearly and the steps were short and fast.
- **Walking up to ~2 m/s.** Before, the transition to running started at 1 m/s: at a normal speed
  (1.2–1.4 m/s) the character was already half running (high knees, bent elbows). Now `walkSpeed` (1.4) is
  the normal speed and the transition starts at `runStartSpeed` (1.7), with its midpoint around 2 m/s
  (Froude ≈ 0.5), as in people.
- **Foot in the air** (`evaluateSwing`): it leaves with the toe-off velocity, reaches its highest point
  shortly after and glides down; the toes rise gradually and it lands on the heel at ~20° (before, it
  first rose in place, stayed high during the whole swing and landed almost flat).
- **Foot roll**: the heel starts rising around mid-stance and leaves at ~55° (25° before), rotating
  about the toe joint, with the toes bending and staying on the ground (before, the foot rotated rigidly
  about a point on the ground and the toes dug into it). The swing starts from the exact toe-off pose.
- **Stance further back** (`walkLandingLead`): the foot lands somewhat closer and the trailing leg extends
  before toe-off, as in the mocap (before, the stance was centered). It depends on the heel lifting: with
  flat feet (e.g. a low `heelLiftAngle`) the stance is centered again.
- **Knees**: almost straight when standing (`standKneeBend`), they cushion when taking the weight and the
  bend grows with speed.
- **Arms**: they swing somewhat further back than forward, growing with speed, in phase with the legs,
  and with more bent elbows.
- **Feet somewhat closer together** than the hips when walking (80 % of their width).
- **Smoothness**: at toe-off, the hips rise following a spring (never above what the legs allow) and the
  cadence changes continuously; on landing, each foot fixes its stance according to the higher of the
  current speed and the one it will have at toe-off. Hip jerks dropped to half or less across the whole
  range.
- **Pelvic tilt oscillation** (`pelvisTiltSwing`): it tilts forward at each heel strike and backward at
  mid-stance, twice per stride, ±1.8° as in CMU (before, its tilt was fixed). The lower spine absorbs it,
  so the trunk and the head don't nod with it. It goes through a spring: when stopping or jumping it fades
  in and out smoothly.
- **Stopping**: when stopping it takes a closing step and ends with one foot somewhat ahead (up to 20 % of
  `stepLength`) instead of taking another 6–15 cm step to square the feet. The rotation and drop of the
  pelvis go from the gait wave to the standing posture with speed, so when it comes to rest the pelvis
  doesn't snap back to the center (it shook the trunk and arms at ~60 °/s). And the elbow no longer bends
  too much when braking or straightens in one frame when coming to rest (a whip of up to 540 °/s). When
  setting off from standing, the planted foot no longer jumps to the heel-strike pose, and a foot planned
  while running that lands already walking lowers the toes from the angle at which the swing ended
  (before, the toes jumped ~16° in one frame).
- **Distributed lateral compensation** (`chestRollShare`): the drop of the pelvis is undone by the lower
  spine and the chest (~1/3, as in CMU), instead of only the lower spine. The shoulders stay just as level
  and the back curves instead of bending at one point. In exchange, the head moves somewhat more from side
  to side (5.3 cm with Mixamo, 5.6 with Rigify; in CMU, 4.8–5.3).

## Turning around

`tests/tools/turnReport.ts` measures each turn the same way in the mocap and in the library (with
`tests/helpers/turnAnalysis.ts`): angle, duration (from 10 to 90 % of the turn), steps, turn per step, how
much the planted foot pivots, minimum speed and how far the pelvis strays from the line of arrival.

```bash
node scripts/run-tests.mjs zzz && node .test-build/tests/tools/turnReport.js
```

In CMU there are two ways of turning around (180°): almost stopped, pivoting (subject 36: 3–5 steps of
55–124° in 1.1–1.9 s, straying 3–18 cm), or without stopping completely, in a very tight curve (subject 69:
0.3–0.5 m/s, 2–3 steps of ~115°, 40–80 cm). In both, each foot lands already rotated and the planted foot
barely pivots (~10°); on landing, the foot is 31° (median; maximum 54°) ahead of the pelvis. Turns of up to
~120° are made without stopping walking (CMU 16_17: 90° in 0.5 s at 0.57 m/s).

`moveTo` towards a destination behind (Mixamo model; walking at 1.4 m/s and the destination 4 m behind):

| | CMU | before | now |
|---|---|---|---|
| Duration of the turn | 1.1–1.9 s | 2.5–2.8 s | 1.1 s |
| Turning steps | 2–3 (average 3.3) | 7–8 | 2–3 |
| Turn per step | ~100–140° | 45–56° | 94° (from standing, 114°) |
| How far the foot moves on each step | — | 11–29 cm (they stepped on each other) | 54–75 cm |
| Minimum speed | 0.3–0.5 m/s (subject 69) | 0.1 m/s | 0.40–0.43 m/s |
| Strays from the line | 3–80 cm | 1.8–5.2 m | 27 cm |
| Knees, closest distance | — | — | ≥ 15 cm |

How: with the destination beyond 120°, `moveTo` brakes to ~0.3 × walkSpeed (not completely: that way each
step already moves in the new direction) and raises the turn limits of the body (× 2.5) and of each step
(× 2.5), more the slower it goes (arriving fast, it brakes first: turning at 150 °/s while still at speed,
the legs crossed). With the destination almost straight behind it turns towards the side of the foot that
takes off next, which opens the turn; the other way, that foot crossed in front of the supporting leg and
the knees collided. For the feet:
- the stance is estimated with the turn the body will have when landing (not with the one at toe-off,
  almost zero when it starts pivoting) and the foot lands at most 30° ahead of the body;
- the planted foot only pivots once the body has passed it, at 360 °/s at most, and when pivoting the hip
  allows 45° of twist before rotating it (a person, 31° median on landing and up to ~54°);
- in a step that rotates the foot a lot, if the straight line would pass over the planted foot, the swing
  goes around it on its own side (`swingDetour`). Only if it passes close in the central part of the swing
  (20–80 %) and by at most 0.2 × stepLength: the detour enters with sin²(π·t) and, if the closest point
  fell near toe-off or landing, it had to be huge to be noticeable (up to 1.35 legs) and the leg in the air
  stretched sideways, with the ankle 1.29 legs from the hip. Now, in turns of 125–170° to both sides,
  walking or from standing, the detour stays within 0.18 legs and the ankle within 0.56 legs of the hip.

The first step: receiving the turn while walking fast, the foot that was already in the air landed with a
full stride (147 cm at 1.4 m/s), because its landing was decided at toe-off. Now, if the requested speed
drops a lot in the first part of the swing, it is replanned (`retargetSwing`: the end goes from the
previous one to the new one with a smoothstep, without a jump in position or velocity), and when the turn
starts it brakes 1.6 × more than when stopping. It ends up at 118 cm, 0.8 times the stride (CMU:
0.68–0.95), and lands 15 cm ahead of the pelvis (CMU: 20–28). The same shortens the last step of an abrupt
stop.

The exit: at the end of the turn it switched abruptly to cruising speed; the foot that had pivoted was
left behind with the leg extended (the ankle 0.7 legs from the pelvis; walking, 0.4–0.5) and the next step
measured 1.88 legs (walking, 1.58–1.68). Now it sets off accelerating at 0.45 × `acceleration` up to its
cruising speed, in 3 steps (1.17 → 1.54 → 1.65 legs), as in CMU, and the foot that was in the air when the
turn ended is also replanned when the requested speed goes up.

Below 120°, the previous curve.

## Touching in passing

Neither CMU nor SFU has anyone walking and touching a wall, a column or a railing (in SFU, the closest
thing is vaulting over a fence with the hands). What CMU does have is reaches: subject 144 reaches to the
left and right for targets at different heights (144_22–25), plus "reach for" (13_10, 14_07–09) and
pushing something high (81_10). `tests/tools/reachReport.ts` measures each reach (from rest to rest, the
wrist relative to the pelvis) from the hanging arm:

```bash
node scripts/run-tests.mjs zzz && node .test-build/tests/tools/reachReport.js
```

| Reaches of subject 144 (30) | Median | p10–p90 |
|---|---|---|
| Duration | 0.76 s | 0.65–0.82 s (plus 3 of 2–5 s, with pauses) |
| Maximum wrist speed | 3.75 arms/s | 3.2–4.5 |
| … at what moment of the gesture | 47 % | 36–62 % |
| Wrist halfway (distance to the shoulder / arm) | 0.71 | 0.59–0.82 |
| Wrist at the end | 0.98 | 0.96–0.99 |
| Elbow at the end | 158° | 147–168° |
| Curvature of the path (deviation / distance) | 0.14 | 0.09–0.29 |
| Trunk towards the target (/ arm) | 0.03 | −0.05–0.43 (the low targets) |
| Hanging down again (`RETURN=1`, 29) | 0.68 s, peak at 51 % | from 0.61 s |

That gives the gesture: the hand goes from the swing to the surface in `touchReachTime` (0.75 s) with a
minimum jerk profile (Flash and Hogan; peak at 50 % instead of 47 %), along a path curved 12 % away from
the shoulder; the elbow bends halfway without having to ask for it (the straight line from the hanging arm
to the target passes close to the shoulder). It returns in `touchReleaseTime` (0.65 s). The trunk doesn't
follow: the surfaces it looks for are between the hip and the chest.

What the mocap doesn't decide, chosen by hand:

- **How close it touches**: the CMU reaches go as far as possible (arm at 98 %); touching in passing
  doesn't. It chooses surfaces it can reach with the arm at 75 % (elbow ~110°) and at most at 82 %
  (`touchMaxReach`), and lets go if it would have to go past 93 %. The bobbing of the gait moves the
  shoulder ±3–4 cm, which can't be predicted without the phase of the step: with a larger margin, the hand
  arrived with the arm straight and let go right away.
- **When**: it starts when the shoulder, at the current speed, will be beside the point when the gesture
  ends, with the point 20 % of the arm ahead; it lets go when the point is 15 % behind (or, standing still,
  after `touchHoldTime`).
- **The palm** faces the surface and the fingers point wherever the wrist rotates least relative to how the
  swing holds it (it tries 12 directions with the arm already solved): up on a wall to the side, outwards
  on a railing. With the fingers always pointing up, a wall to the right required rotating the palm ~180°
  relative to the forearm.
- **The elbow** points down and back, keeping half of the direction it was already bending towards (with
  the hand on a railing already passed, "down and back" runs almost along the arm).

**Sliding the hand.** Walking alongside a wall or a railing, the resting hand slides while it stays
alongside. There is no mocap of this either; it is chosen so that it looks like a hand brushing the wall:

- a critical spring (1.5 Hz) carries the contact point towards the side of the shoulder (10 % of the arm
  ahead), only along the surface and in the direction of travel (the bobbing of the body doesn't move it),
  with the body's velocity in the damper so that it doesn't fall behind; that velocity comes in over
  0.15 s (all at once, the hand started at ~28 m/s²) and it never slides backwards (if it touched ahead, it
  waits for the body);
- a short ray sticks it back onto the surface every frame; with the smoothed normal (0.1 s), the hand
  turns with it on a wide curved wall;
- on a wall it gradually lowers (0.6 s) to a little more than half an arm below the shoulder: resting at
  chest height while walking, with the arm almost horizontal, it looked like a wing;
- while sliding, the arm can go up to 97 % (when touching, 93 %): on a railing at hip height the hand
  rests with the arm almost straight, and the distance changes slowly;
- it ends (and lets go) if the ray doesn't find the surface, if the normal turns abruptly (a corner) or if
  the surface is very curved (the normal turns more than 1 rad per arm length traveled, radius < ~0.5 m: a
  column). On a column, going around it, the hand couldn't follow the body and the arm stretched sideways
  until it let go abruptly (up to 10 °/frame²); now it touches it and lets go when passing;
- the way back starts from where the wrist really is and with the velocity it has (after IK), not from the
  requested point: if the point was already out of reach, starting from it stopped the arm abruptly.

Measured (`tests/touch.test.ts` and by hand, at 0.8, 1.2 and 1.5 m/s, on both sides, with both models):
along an 8 m wall or a railing the hand stays resting until the end (6–8 m walking), with the center of
the palm less than 1 mm from the surface; the largest angular acceleration of the arm, 0.5–2.2 °/frame²
(the peak, when reaching).

No jerks: the tests (`tests/touch.test.ts`) require less than 2 °/frame² in the upper arm, forearm and hand
throughout the gesture (2.5 while sliding; walking without touching, ~0.4); currently, 0.5–2.2 on columns,
walls and railings on both sides, with both models. The resting hand without sliding doesn't move
(< 1 mm). What it took to get there, in case it shows up again:

- the hanging arm is almost straight (99 % of the arm) and the target, moving ahead, went past the reach:
  IK stretched it fully, where the elbow changes very fast with the distance. The distance to the shoulder
  is saturated (from the extension of the swing up to 92 % of the arm with the gesture);
- the orientation of the hand is blended relative to the forearm as it will be with the hand resting (a
  separate IK), not in world space nor relative to the hanging forearm, and always the same way round
  (with the sign of the quaternions continuous from one frame to the next);
- when letting go, the hand gradually goes from still on the surface to moving with the body (with the
  point fixed, the body moved away while it came back and the arm whipped backwards);
- the arm IK receives the axis of the elbow hinge as the swing bends it (if it derived it from the point
  the elbow aims at, the forearm twist changed from one frame to the next).

## Stairs

The CMU stair takes are short flights (2–3 steps of about 12–19 cm; the dimensions are not documented: they
come from the height at which the ankle stands still). Each swing is classified as going up, going down or
level, and compared with the library on 17 × 28 cm stairs:

| | Mocap, up | Mocap, down | Library, up | Library, down |
|---|---|---|---|---|
| Foot height at mid-swing (fraction of the rise; < 0: above the start) | 1.48 | −0.33 | 1.8 | −0.5 |
| Foot height at 75 % of the swing | 1.33 | 0.60 | 1.6 | −0.3 |
| Foot angle at landing (°, + toes up) | 0 | −3 | 0 | 0 |
| Trunk lean relative to the flat (°) | +7 | +2.5 | +7 | +2.4 |
| Highest knee bend of the stance leg (°) | 55 | 68 | ≈ 80 | ≈ 95 |

What was changed from it: on a step the foot lands flat (on the flat it lands on the heel, toes up); going
down, it first moves forward over the edge and then drops (before, it dropped from the start and cut the
nosing); and the trunk leans forward with the slope of the stairs. Going down, the library drops later than the
mocap: it waits until the back of the heel has passed the edge. The stance knee bends more than in the mocap:
the height of the hips is limited by the trailing leg, which reaches the lower tread; pending.

## Pose jumps

`tests/tools/popProbe.ts` measures the angular acceleration of each bone (°/frame²) over a route with
starting, stopping, turning, running, jumping and crouching, and lists the largest peaks with the state of
the gait:

```bash
node scripts/run-tests.mjs zzz && node .test-build/tests/tools/popProbe.js
```

It is useful for finding abrupt movements that a screenshot doesn't show (a bone that jumps for one frame
and comes back).

## What the CMU mocap doesn't decide

- **Knee**: in CMU it is ~10° more bent over the whole cycle than in the clinical literature (a typical
  offset of skeletons calibrated with markers). Its shape is used, not its value.
- **Lateral drop of the pelvis**: CMU puts the maximum ~25 % of the cycle later than the clinical
  literature (Kadaba); the clinical one is followed.
- **Vertical bounce**: the CMU subject goes up and down ~2.4 cm; the clinical literature gives 4–5 cm. The
  library is in between (~4 cm).
- **Trunk and neck**: they depend on each skeleton's rest pose; they are not compared.

## Pending

- **Running**: with two jogging takes (one cycle each) and the literature, the lean, the elbows, the arms
  (further back) and the heel were tuned; the cadence (174 steps/min at 3 m/s) was left within the range of
  the literature (160–180), somewhat above that of the CMU subject (160), because with fewer steps the hips
  dropped too much when turning while running. The foot in the air still gets too far ahead of the body
  before landing (thigh up to ~65° forward; in the mocap, ~38°): the running swing trajectory needs a
  redesign.
- **Upper arm**: it reaches its forward point somewhat late (58 % of the cycle; in the mocap, 51 %): its
  target comes from the distance between the feet, which doesn't change in double support.
- **Styles**: the takes of subject 17 (angry, sneaky, happy, heavyset) can be used to tune the predefined
  styles with the same method.
