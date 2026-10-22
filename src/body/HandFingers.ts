import { type Bone, Quaternion, Vector3 } from 'three';

import { updateDown, worldQuaternion } from '../core/pose.ts';
import type { FingerBones, FingerName } from '../rig/HumanRig.ts';

const DEG = Math.PI / 180;

/**
 * Relaxed hand (degrees per phalanx, from the base to the tip, with `fingerCurl` = 1): how a hand hangs
 * while walking. The middle phalanx is the most bent, and each finger a little more than the previous one,
 * from the index to the little finger.
 */
const RELAXED_FLEX: Record<FingerName, readonly number[]> = {
  thumb: [0, 12, 18],
  index: [15, 25, 15],
  middle: [18, 30, 18],
  ring: [22, 34, 20],
  pinky: [26, 38, 22],
};
/**
 * Fraction of the gap between fingers (relative to the middle finger) that closes: the fingers come
 * together.
 */
const CLOSE_SPREAD = 0.6;
/** Fraction of the angle between the thumb and the index finger by which the thumb moves towards it. */
const THUMB_ADDUCTION = 0.3;

interface Phalanx {
  bone: Bone;
  rest: Quaternion;
  /** Flexion axis in the bone's local space (bending towards the palm = positive angle). */
  flexAxis: Vector3;
}

interface Finger {
  name: FingerName;
  phalanges: Phalanx[];
  /** Rotation of the first phalanx in its local space to bring the finger in (or the thumb closer). */
  base: Quaternion;
}

/**
 * Fingers of a hand: takes them from the model's rest pose to a relaxed hand.
 *
 * It doesn't assume local axes: in the rest pose it measures the direction of each phalanx and the normal
 * of the palm (with the hand rule: left and right are symmetric), and from that it derives, in each
 * bone's local space, the axis to bend it towards the palm.
 */
export class HandFingers {
  private readonly fingers: Finger[] = [];
  private readonly hand: Bone;
  private readonly q = new Quaternion();
  private readonly qWorld = new Quaternion();
  private readonly qParent = new Quaternion();

  /** `sign`: +1 right hand, −1 left. Call with the model in its rest pose. */
  constructor(hand: Bone, bones: FingerBones, sign: number) {
    this.hand = hand;
    hand.updateWorldMatrix(true, true);
    const pos = (b: Bone): Vector3 => b.getWorldPosition(new Vector3());
    const handPos = pos(hand);

    // Palma: dirección de los dedos (muñeca → base del corazón, o de los dedos que haya) y eje
    // lateral (índice → meñique). Su normal hacia la palma depende de la mano (simetría especular).
    const bases = (['index', 'middle', 'ring', 'pinky'] as const).filter((n) => bones[n]).map((n) => pos(bones[n]![0]));
    if (bases.length < 2) return; // sin al menos dos dedos no se sabe dónde está la palma
    const along = bones.middle ? pos(bones.middle[0]).sub(handPos) : bases.reduce((a, b) => a.add(b), new Vector3()).divideScalar(bases.length).sub(handPos);
    along.normalize();
    const lateral = bases[0].clone().sub(bases[bases.length - 1]); // del primero (índice) al último (meñique)
    const palm = sign > 0 ? new Vector3().crossVectors(lateral, along) : new Vector3().crossVectors(along, lateral);
    palm.normalize();
    const middleDir = bones.middle ? this.direction(bones.middle, 0, new Vector3()) : along.clone();

    for (const name of ['thumb', 'index', 'middle', 'ring', 'pinky'] as const) {
      const chain = bones[name];
      if (!chain) continue;
      const phalanges: Phalanx[] = chain.map((bone, i) => {
        const inverse = bone.getWorldQuaternion(new Quaternion()).invert();
        const d = this.direction(chain, i, new Vector3());
        const axis = new Vector3().crossVectors(d, palm);
        if (axis.lengthSq() < 1e-10) axis.crossVectors(d, lateral);
        return { bone, rest: bone.quaternion.clone(), flexAxis: axis.normalize().applyQuaternion(inverse) };
      });

      // Giro de la base: juntar el dedo al corazón (sobre la normal de la palma) o, el pulgar,
      // acercarlo al índice.
      const first = chain[0];
      const inverse = first.getWorldQuaternion(new Quaternion()).invert();
      const d0 = this.direction(chain, 0, new Vector3());
      const base = new Quaternion();
      if (name === 'thumb') {
        const toward = bones.index ? pos(bones.index[Math.min(1, bones.index.length - 1)]).sub(pos(first)).normalize() : null;
        if (toward) {
          const axis = new Vector3().crossVectors(d0, toward);
          if (axis.lengthSq() > 1e-10) base.setFromAxisAngle(axis.normalize().applyQuaternion(inverse), d0.angleTo(toward) * THUMB_ADDUCTION);
        }
      } else if (name !== 'middle') {
        // Ángulo (con signo, sobre la normal) del corazón a este dedo, en el plano de la palma.
        const spread = Math.atan2(new Vector3().crossVectors(middleDir, d0).dot(palm), middleDir.dot(d0));
        base.setFromAxisAngle(palm.clone().applyQuaternion(inverse), -spread * CLOSE_SPREAD);
      }
      this.fingers.push({ name, phalanges, base });
    }
  }

  /** Does it have fingers to move? */
  get active(): boolean {
    return this.fingers.length > 0;
  }

  /** Rest pose of the model. */
  resetPose(): void {
    for (const f of this.fingers) for (const p of f.phalanges) p.bone.quaternion.copy(p.rest);
  }

  /**
   * Relaxed hand: `curl` 0 = the model's rest pose, 1 = relaxed (more = more closed).
   * Works in each phalanx's local space: it can be applied before moving the arm.
   */
  pose(curl: number): void {
    const together = Math.min(curl, 1);
    for (const f of this.fingers) {
      const flex = RELAXED_FLEX[f.name];
      f.phalanges.forEach((p, i) => {
        p.bone.quaternion.copy(p.rest);
        if (i === 0) p.bone.quaternion.multiply(this.q.identity().slerp(f.base, together));
        const angle = (flex[Math.min(i, flex.length - 1)] ?? 0) * DEG * curl;
        if (angle !== 0) p.bone.quaternion.multiply(this.q.setFromAxisAngle(p.flexAxis, angle));
      });
    }
  }

  /**
   * Rotates the base of each finger by `angle` rad about `axis` (world): the fingers lag behind when the hand
   * swings. The hand must have its matrix up to date; the fingers' matrices are left pending (whoever moves
   * the arm updates them at the end).
   */
  sway(axis: Vector3, angle: number): void {
    if (angle === 0) return;
    this.q.setFromAxisAngle(axis, angle);
    for (const f of this.fingers) {
      const bone = f.phalanges[0].bone;
      updateDown(this.hand, bone);
      worldQuaternion(bone, this.qWorld).premultiply(this.q);
      // A espacio local: q_local = q_padre⁻¹ · q_world.
      bone.quaternion.copy(worldQuaternion(bone.parent!, this.qParent).invert().multiply(this.qWorld));
    }
  }

  /**
   * World direction (unit) of phalanx `i`: towards the next one, towards its child or, with no child, like
   * the previous one.
   */
  private direction(chain: Bone[], i: number, out: Vector3): Vector3 {
    const from = chain[i].getWorldPosition(new Vector3());
    // Siguiente falange, o el hijo del hueso (en muchos rigs, la punta del dedo).
    const next = chain[i + 1] ?? chain[i].children[0];
    if (next) return out.copy(next.getWorldPosition(new Vector3())).sub(from).normalize();
    if (i > 0) return this.direction(chain, i - 1, out);
    return out.set(0, 1, 0).applyQuaternion(chain[i].getWorldQuaternion(new Quaternion())).normalize();
  }
}
