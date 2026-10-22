import { Vector3 } from 'three';

import { estimateForward, type HumanRig, measureLegLength, type Side } from './HumanRig.ts';

/**
 * Limits of what counts as a usable model (fractions of the leg length unless stated otherwise). The real
 * models tested (Mixamo and Rigify) are well inside; the proportion limits come from what the tests check
 * with generated skeletons (`tests/proportions.test.ts`).
 */
const LIMITS = {
  /** Leg length (m): outside this, the model is almost certainly not in meters. */
  legLength: [0.1, 5],
  /** Difference in length between the two legs. */
  asymmetry: 0.05,
  /** Knee bend in the rest pose (degrees). */
  restKneeBend: 20,
  /** Angle of the leg (hip → ankle) with the vertical at rest (degrees). */
  legTilt: 25,
  /** Height of the ankle above the model's origin. */
  ankleHeight: [0, 0.3],
  /** Height of the toes above the model's origin (± this value). */
  toeHeight: 0.08,
  /** Muslo / tibia. */
  thighToShin: [0.7, 1.5],
  /** Distance between the hips (thigh joints). */
  hipWidth: [0.12, 0.4],
  /** Length of the foot seen from above (ankle → toes). */
  footLength: [0.1, 0.25],
  /** Angle between `forward` and the direction of the feet (degrees). */
  forwardMismatch: 45,
} as const;

const SIDES: readonly Side[] = ['left', 'right'];
const DEG = 180 / Math.PI;

/**
 * Checks that the model meets the requirements of the locomotion (see docs/en/skeletons.md) and returns
 * readable warnings, one per problem, saying what to check. It doesn't throw: a model with warnings may
 * work, but it will most likely look wrong. It is measured in the current pose, which must be the rest
 * pose.
 *
 * `forward`: the forward direction passed when creating the character, if any.
 */
export function checkModel(rig: HumanRig, forward?: Vector3): string[] {
  const warnings: string[] = [];
  rig.root.updateWorldMatrix(true, true);
  const p = (o: { getWorldPosition(v: Vector3): Vector3 }): Vector3 => o.getWorldPosition(new Vector3());
  const root = p(rig.root);
  const L = measureLegLength(rig);
  const f = (x: number): string => x.toFixed(2);

  if (L < LIMITS.legLength[0] || L > LIMITS.legLength[1]) {
    warnings.push(
      `Leg length of ${f(L)} m: the model must be in meters (if it was exported in centimeters, scale it × 0.01 or apply the scale when exporting).`,
    );
  }

  const legs = SIDES.map((side) => {
    const hip = p(rig[side].thigh);
    const knee = p(rig[side].shin);
    const ankle = p(rig[side].foot);
    return { side, hip, knee, ankle, thigh: hip.distanceTo(knee), shin: knee.distanceTo(ankle) };
  });
  const [left, right] = legs;
  const asymmetry = Math.abs(left.thigh + left.shin - right.thigh - right.shin) / L;
  if (asymmetry > LIMITS.asymmetry) {
    warnings.push(`The legs have different lengths (${f(asymmetry * 100)} %): is a bone mapped wrong, or is one leg in a different pose?`);
  }

  for (const leg of legs) {
    const name = leg.side;
    const title = name === 'left' ? 'Left' : 'Right'; // al principio de la frase
    const bend = 180 - leg.hip.clone().sub(leg.knee).angleTo(leg.ankle.clone().sub(leg.knee)) * DEG;
    if (bend > LIMITS.restKneeBend) {
      warnings.push(
        `${title} knee bent ${f(bend)}° in the rest pose: the leg length and the standing height are measured in that pose; export the model standing, with straight legs (T-pose or A-pose).`,
      );
    }
    const tilt = leg.ankle.clone().sub(leg.hip).angleTo(new Vector3(0, -1, 0)) * DEG;
    if (tilt > LIMITS.legTilt) {
      warnings.push(
        `The ${name} leg is at ${f(tilt)}° from the vertical: the model must have the Y axis up and be standing in its rest pose.`,
      );
    }
    const ankleHeight = (leg.ankle.y - root.y) / L;
    if (ankleHeight < LIMITS.ankleHeight[0] || ankleHeight > LIMITS.ankleHeight[1]) {
      warnings.push(
        `${title} ankle ${f(leg.ankle.y - root.y)} m from the model's origin: the origin (the root) must be on the ground, at the level of the soles of the feet.`,
      );
    }
    const toe = rig[leg.side].toe;
    if (toe && Math.abs(p(toe).y - root.y) / L > LIMITS.toeHeight && ankleHeight >= LIMITS.ankleHeight[0] && ankleHeight <= LIMITS.ankleHeight[1]) {
      warnings.push(`The toes of the ${name} foot are not at ground level (${f(p(toe).y - root.y)} m): in the rest pose the feet must be flat.`);
    }
  }

  const thighToShin = (left.thigh + right.thigh) / (left.shin + right.shin);
  if (thighToShin < LIMITS.thighToShin[0] || thighToShin > LIMITS.thighToShin[1]) {
    warnings.push(`Thigh / shin = ${f(thighToShin)}: outside the tested range (${LIMITS.thighToShin.join('–')}); the gait may look odd.`);
  }
  const hipWidth = left.hip.distanceTo(right.hip) / L;
  if (hipWidth < LIMITS.hipWidth[0] || hipWidth > LIMITS.hipWidth[1]) {
    warnings.push(
      `Hips of ${f(hipWidth)} × the leg length: outside the tested range (${LIMITS.hipWidth.join('–')}); adjust \`stepWidth\` if the feet end up too close together or too far apart.`,
    );
  }
  if (rig.left.toe && rig.right.toe) {
    const footLength = SIDES.reduce((sum, side) => {
      const ankle = p(rig[side].foot);
      const toe = p(rig[side].toe!);
      return sum + Math.hypot(toe.x - ankle.x, toe.z - ankle.z);
    }, 0) / 2 / L;
    if (footLength < LIMITS.footLength[0] || footLength > LIMITS.footLength[1]) {
      warnings.push(`Feet of ${f(footLength)} × the leg length (ankle → toes): outside the tested range (${LIMITS.footLength.join('–')}).`);
    }
  }

  if (!rig.left.toe || !rig.right.toe) {
    if (!forward) {
      warnings.push(
        'Without the toe bone (`toe`) there is no way to tell which way the model faces: pass `forward` (the direction it faces at rest) when creating the character.',
      );
    }
  } else if (forward) {
    const toes = estimateForward(rig, 'toes');
    const angle = toes.angleTo(new Vector3(forward.x, 0, forward.z).normalize()) * DEG;
    if (angle > LIMITS.forwardMismatch) {
      warnings.push(`\`forward\` is at ${f(angle)}° from the direction of the feet: is it the direction the model faces at rest?`);
    }
  }
  return warnings;
}
