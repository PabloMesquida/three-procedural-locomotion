import { type Bone, Matrix4, Quaternion, Vector3 } from 'three';

import { setWorldQuaternionNode, updateDown, updateSubtree, worldPosition, worldQuaternion } from '../core/pose.ts';

export interface TwoBoneIKInput {
  /** First bone of the chain (thigh). */
  rootBone: Bone;
  /** Middle bone (shin). Must be a direct child of rootBone. */
  middleBone: Bone;
  /** End bone (foot). Must be a direct child of middleBone. */
  endBone: Bone;
  /** Target position of the endBone, in world space. */
  target: Vector3;
  /** Point the middle joint (knee) must aim at, in world space. */
  poleTarget: Vector3;
  /** Keep the world orientation of the endBone (default: true). */
  preserveEndRotation?: boolean;
  /**
   * Hinge axis of the middle joint, in rootBone's local space (perpendicular to the plane the knee bends
   * in). If given, the root bone rotates as a whole to orient the knee towards the pole and the knee always
   * bends about that axis. Otherwise it is derived from the current pole.
   */
  hingeAxis?: Vector3;
}

export interface TwoBoneIKResult {
  /** The target is within the reach of the chain. */
  reachable: boolean;
  /** Final distance between the endBone and the target (world units). */
  error: number;
}

const EPS = 1e-8;

/**
 * Analytic IK solver for two-bone chains (hip-knee-foot, shoulder-elbow-hand).
 *
 * Steps:
 *  1. The law of cosines gives where the middle joint (knee) and the end (foot) must end up, in the
 *     hip–target–pole plane.
 *  2. The root bone is rotated by aligning its "frame" (bone direction + hinge axis) with the desired
 *     frame, so that the knee doesn't twist.
 *  3. The middle bone is rotated so that the end lands on the target.
 *  4. Optionally, the world orientation of the end is restored.
 *
 * Everything is computed in world space and converted to local using the parent's world rotation, so it
 * works with any Three.js hierarchy (including rotated or uniformly scaled parents).
 * Limitation: it doesn't support non-uniform scales in the hierarchy.
 */
export class TwoBoneIK {
  // Vectores y cuaterniones reutilizables (sin allocations por frame)
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly dir = new Vector3();
  private readonly poleDir = new Vector3();
  private readonly bDesired = new Vector3();
  private readonly cDesired = new Vector3();
  private readonly curDir = new Vector3();
  private readonly curHinge = new Vector3();
  private readonly curBinormal = new Vector3();
  private readonly newDir = new Vector3();
  private readonly newHinge = new Vector3();
  private readonly newBinormal = new Vector3();
  private readonly v1 = new Vector3();
  private readonly v2 = new Vector3();
  private readonly m0 = new Matrix4();
  private readonly m1 = new Matrix4();
  private readonly q = new Quaternion();
  private readonly qWorld = new Quaternion();
  private readonly qEnd = new Quaternion();

  solve(input: TwoBoneIKInput): TwoBoneIKResult {
    const { rootBone, middleBone, endBone, target, poleTarget } = input;
    const preserveEnd = input.preserveEndRotation ?? true;
    const { a, b, c, dir, poleDir, bDesired, cDesired } = this;

    // Solo la cadena: sus antepasados y raíz → intermedio → extremo (lo que cuelga, al final).
    rootBone.updateWorldMatrix(true, false);
    updateDown(rootBone, middleBone);
    updateDown(middleBone, endBone);
    worldPosition(rootBone, a);
    worldPosition(middleBone, b);
    worldPosition(endBone, c);
    if (preserveEnd) worldQuaternion(endBone, this.qEnd);

    const lenAB = a.distanceTo(b);
    const lenBC = b.distanceTo(c);
    const maxReach = lenAB + lenBC;
    const minReach = Math.abs(lenAB - lenBC);

    // --- 1. Geometría deseada -------------------------------------------
    dir.subVectors(target, a);
    const dist = dir.length();
    const reachable = dist <= maxReach && dist >= minReach;

    if (dist > EPS) dir.divideScalar(dist);
    else dir.subVectors(c, a).normalize(); // target en la cadera: mantener dirección actual

    // Se evita la cadena 100 % recta (la bisagra quedaría indefinida).
    const d = clamp(dist, minReach + maxReach * 1e-4, maxReach * (1 - 1e-4));

    // Dirección del pole, perpendicular a la línea cadera→target.
    perpendicularTo(dir, poleDir.subVectors(poleTarget, a), this.v1.subVectors(b, a));

    const cosA = clamp((lenAB * lenAB + d * d - lenBC * lenBC) / (2 * lenAB * d), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    bDesired.copy(a).addScaledVector(dir, lenAB * cosA).addScaledVector(poleDir, lenAB * sinA);
    cDesired.copy(a).addScaledVector(dir, d);

    // --- 2. Hueso raíz: alinear marco actual → marco deseado -------------
    // Marco = (dirección del hueso, eje de bisagra, binormal).
    // Eje de bisagra = perpendicular al plano cadera–pie–pole.
    const { curDir, curHinge, curBinormal, newDir, newHinge, newBinormal, v1, v2 } = this;

    curDir.subVectors(b, a).normalize();
    worldQuaternion(rootBone, this.qWorld);
    if (input.hingeAxis) {
      curHinge.copy(input.hingeAxis).applyQuaternion(this.qWorld);
    } else {
      v1.subVectors(c, a);
      if (v1.lengthSq() < EPS) v1.copy(curDir);
      v1.normalize();
      perpendicularTo(v1, v2.subVectors(poleTarget, a), curDir);
      curHinge.crossVectors(v1, v2);
    }
    orthonormalize(curHinge, curDir);
    curBinormal.crossVectors(curDir, curHinge);

    newDir.subVectors(bDesired, a).normalize();
    newHinge.crossVectors(dir, poleDir).normalize();
    newBinormal.crossVectors(newDir, newHinge);

    this.m0.makeBasis(curDir, curHinge, curBinormal).transpose(); // inversa (ortonormal)
    this.m1.makeBasis(newDir, newHinge, newBinormal).multiply(this.m0);
    this.q.setFromRotationMatrix(this.m1);

    setWorldQuaternionNode(rootBone, this.qWorld.premultiply(this.q));
    updateDown(rootBone, middleBone);
    updateDown(middleBone, endBone);

    // --- 3. Hueso intermedio: llevar el extremo al target ----------------
    worldPosition(middleBone, b);
    worldPosition(endBone, c);
    v1.subVectors(c, b).normalize();
    v2.subVectors(cDesired, b).normalize();
    this.q.setFromUnitVectors(v1, v2);

    worldQuaternion(middleBone, this.qWorld);
    setWorldQuaternionNode(middleBone, this.qWorld.premultiply(this.q));
    updateDown(middleBone, endBone);

    // --- 4. Extremo: conservar su orientación world ----------------------
    if (preserveEnd) setWorldQuaternionNode(endBone, this.qEnd);
    updateSubtree(endBone);

    worldPosition(endBone, c);
    return { reachable, error: c.distanceTo(target) };
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/**
 * Leaves in `v` its component perpendicular to `axis` (unit), normalized.
 * If `v` is almost parallel to `axis`, uses `fallback`; if that is too, any perpendicular.
 */
function perpendicularTo(axis: Vector3, v: Vector3, fallback: Vector3): Vector3 {
  v.addScaledVector(axis, -v.dot(axis));
  if (v.lengthSq() > EPS) return v.normalize();

  v.copy(fallback).addScaledVector(axis, -fallback.dot(axis));
  if (v.lengthSq() > EPS) return v.normalize();

  v.set(1, 0, 0);
  if (Math.abs(axis.x) > 0.9) v.set(0, 1, 0);
  return v.addScaledVector(axis, -v.dot(axis)).normalize();
}

/** Deja `v` perpendicular a `axis` (unitario) y normalizado. */
function orthonormalize(v: Vector3, axis: Vector3): void {
  v.addScaledVector(axis, -v.dot(axis));
  if (v.lengthSq() < EPS) perpendicularTo(axis, v.set(0, 0, 0), new Vector3(0, 0, 1));
  else v.normalize();
}
