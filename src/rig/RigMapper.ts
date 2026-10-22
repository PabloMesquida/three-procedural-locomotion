import { Bone, type Object3D, PropertyBinding } from 'three';

import {
  type ArmBones,
  type ArmMapping,
  estimateForward,
  FINGER_NAMES,
  type FingerBones,
  type FingerMapping,
  type HumanRig,
  type HumanRigMapping,
  type LegBones,
  type LegMapping,
} from './HumanRig.ts';

export interface RigMappingResult {
  rig: HumanRig;
  /** Problemas no bloqueantes (bones opcionales ausentes, sospechas…). */
  warnings: string[];
}

/** Thrown when required bones are missing or the chain of a leg is invalid. */
export class RigMappingError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid rig mapping:\n- ${problems.join('\n- ')}`);
    this.name = 'RigMappingError';
    this.problems = problems;
  }
}

/**
 * Builds a HumanRig from a loaded model and an explicit mapping.
 *
 * The names in the mapping are looked up as they are and, if not found, in the form sanitized by Three
 * (`mixamorig:Hips` → `mixamorigHips`), so both Blender names and the ones the inspector shows work.
 */
export function mapHumanRig(root: Object3D, mapping: HumanRigMapping): RigMappingResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Índice nombre → bone
  const bonesByName = new Map<string, Bone>();
  root.traverse((obj) => {
    if (!(obj instanceof Bone)) return;
    if (bonesByName.has(obj.name)) warnings.push(`Duplicate bone name: "${obj.name}"`);
    else bonesByName.set(obj.name, obj);
  });

  const find = (name: string): Bone | undefined =>
    bonesByName.get(name) ?? bonesByName.get(PropertyBinding.sanitizeNodeName(name));

  const required = (label: string, name: string): Bone | undefined => {
    const bone = find(name);
    if (!bone) errors.push(`Missing required bone ${label} ("${name}")`);
    return bone;
  };

  const optional = (label: string, name: string | undefined): Bone | undefined => {
    if (name === undefined) return undefined;
    const bone = find(name);
    if (!bone) warnings.push(`Optional bone ${label} ("${name}") not found`);
    return bone;
  };

  // Huesos de torsión: opcionales y cosméticos. Si el mapping los nombra pero el modelo no tiene
  // ninguno (p. ej. el preset de Rigify con un metarig sin twist) se avisa una sola vez.
  const twistMissing: string[] = [];
  let twistFound = 0;
  const twist = (label: string, name: string | undefined, segment: Bone): Bone | undefined => {
    if (name === undefined) return undefined;
    const bone = find(name);
    if (!bone) {
      twistMissing.push(`${label} ("${name}")`);
      return undefined;
    }
    twistFound++;
    if (bone.parent !== segment) {
      warnings.push(`${label}: "${bone.name}" is not a direct child of "${segment.name}", ignored`);
      return undefined;
    }
    return bone;
  };

  const mapLeg = (side: string, m: LegMapping): LegBones | undefined => {
    const thigh = required(`${side}.thigh`, m.thigh);
    const shin = required(`${side}.shin`, m.shin);
    const foot = required(`${side}.foot`, m.foot);
    const toe = optional(`${side}.toe`, m.toe);
    if (!thigh || !shin || !foot) return undefined;

    // El Two-Bone IK necesita una cadena directa muslo → tibia → pie.
    if (shin.parent !== thigh) errors.push(`${side}: "${shin.name}" is not a direct child of "${thigh.name}"`);
    if (foot.parent !== shin) errors.push(`${side}: "${foot.name}" is not a direct child of "${shin.name}"`);
    if (toe && toe.parent !== foot) warnings.push(`${side}: "${toe.name}" is not a direct child of "${foot.name}"`);

    return {
      thigh,
      shin,
      foot,
      toe,
      thighTwist: twist(`${side}.thighTwist`, m.thighTwist, thigh),
      shinTwist: twist(`${side}.shinTwist`, m.shinTwist, shin),
    };
  };

  const mapArm = (side: string, m: ArmMapping | undefined): ArmBones | undefined => {
    if (!m) return undefined;
    const upperArm = optional(`${side}.upperArm`, m.upperArm);
    const forearm = optional(`${side}.forearm`, m.forearm);
    const hand = optional(`${side}.hand`, m.hand);
    const shoulder = optional(`${side}.shoulder`, m.shoulder);
    if (!upperArm || !forearm || !hand) {
      warnings.push(`${side}: incomplete arm, ignored`);
      return undefined;
    }
    return {
      shoulder,
      upperArm,
      forearm,
      hand,
      fingers: mapFingers(side, m.fingers),
      upperArmTwist: twist(`${side}.upperArmTwist`, m.upperArmTwist, upperArm),
      forearmTwist: twist(`${side}.forearmTwist`, m.forearmTwist, forearm),
    };
  };

  // Cada dedo es opcional: si falta una falange o la cadena no es directa, se ignora ese dedo.
  const mapFingers = (side: string, m: FingerMapping | undefined): FingerBones | undefined => {
    if (!m) return undefined;
    const fingers: FingerBones = {};
    for (const name of FINGER_NAMES) {
      const names = m[name];
      if (!names || names.length === 0) continue;
      // Se usan las falanges encontradas desde la base, sin aviso: muchos rigs no exportan la última
      // como hueso porque no tiene pesos (p. ej. algunos Mixamo).
      const chain: Bone[] = [];
      for (const n of names) {
        const bone = find(n);
        if (!bone) break;
        chain.push(bone);
      }
      if (chain.length === 0) {
        warnings.push(`${side}: base of finger ${name} ("${names[0]}") not found, ignored`);
        continue;
      }
      if (chain.some((b, i) => i > 0 && b.parent !== chain[i - 1])) {
        warnings.push(`${side}: the phalanges of finger ${name} do not form a direct chain, ignored`);
        continue;
      }
      fingers[name] = chain;
    }
    return Object.keys(fingers).length > 0 ? fingers : undefined;
  };

  const hips = required('hips', mapping.hips);
  const left = mapLeg('left', mapping.left);
  const right = mapLeg('right', mapping.right);

  if (errors.length > 0 || !hips || !left || !right) throw new RigMappingError(errors);

  for (const leg of [left, right]) {
    if (!isDescendantOf(leg.thigh, hips)) {
      warnings.push(`"${leg.thigh.name}" does not hang from the hips "${hips.name}"`);
    }
  }

  const rig: HumanRig = {
    root,
    hips,
    left,
    right,
    spine: optional('spine', mapping.spine),
    chest: optional('chest', mapping.chest),
    neck: optional('neck', mapping.neck),
    head: optional('head', mapping.head),
    leftArm: mapArm('leftArm', mapping.leftArm),
    rightArm: mapArm('rightArm', mapping.rightArm),
  };

  if (twistMissing.length > 0) {
    if (twistFound === 0) warnings.push('The model has none of the twist bones in the mapping: arms and legs rotate without gradual twist');
    else for (const missing of twistMissing) warnings.push(`Twist bone ${missing} not found`);
  }

  // Comprobación de coherencia: si los pies apuntan hacia atrás respecto
  // al eje izquierda→derecha, probablemente left/right están intercambiados.
  if (left.toe && right.toe) {
    root.updateWorldMatrix(true, true);
    const byToes = estimateForward(rig, 'toes');
    const byLateral = estimateForward(rig, 'lateral');
    if (byToes.dot(byLateral) < 0) {
      warnings.push('The feet point the opposite way from what is expected: are left/right swapped in the mapping?');
    }
  }

  return { rig, warnings };
}

function isDescendantOf(obj: Object3D, ancestor: Object3D): boolean {
  for (let p = obj.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}
