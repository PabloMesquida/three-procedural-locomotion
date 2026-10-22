import { type Object3D, Vector3 } from 'three';

import { type HumanRig, mapHumanRig, type Side } from '../../src/index.ts';
import { MODEL_MAPPING } from './sim.ts';

/**
 * Proporciones de un esqueleto, como factores sobre las del modelo de los tests (1 = igual).
 * Cada uno alarga o acorta un segmento sin tocar los demás; después los tests normalizan el
 * modelo al largo de pierna de referencia, así que lo que cambia es la proporción entre partes.
 */
export interface Proportions {
  /** Muslo y tibia a la vez. */
  legs?: number;
  /** Muslo (cadera → rodilla). */
  thigh?: number;
  /** Tibia (rodilla → tobillo). */
  shin?: number;
  /** Torso: de las caderas al cuello (columna, pecho; los brazos y la cabeza suben con él). */
  torso?: number;
  /** Separación lateral de las articulaciones de la cadera. */
  hips?: number;
  /** Brazo y antebrazo. */
  arms?: number;
  /** Largo del pie en planta (tobillo → dedos), sin cambiar su altura. */
  feet?: number;
}

/** Variantes que se prueban: humanos de proporciones distintas, no deformes. */
export const PROPORTION_VARIANTS: Record<string, Proportions> = {
  'piernas largas': { legs: 1.2 },
  'piernas cortas': { legs: 0.8 },
  'muslo largo, tibia corta': { thigh: 1.15, shin: 0.87 },
  'muslo corto, tibia larga': { thigh: 0.87, shin: 1.15 },
  'torso largo': { torso: 1.25 },
  'torso corto': { torso: 0.8 },
  'caderas anchas': { hips: 1.5 },
  'caderas estrechas': { hips: 0.6 },
  'brazos largos': { arms: 1.2 },
  'brazos cortos': { arms: 0.8 },
  'pies largos': { feet: 1.25 },
  'pies cortos': { feet: 0.8 },
  // Combinaciones: piernas cortas y torso largo (más cerca de un niño o de un cuerpo robusto) y al revés.
  'piernas cortas, torso largo, caderas anchas': { legs: 0.85, torso: 1.15, hips: 1.3 },
  'piernas largas, torso corto, caderas estrechas': { legs: 1.15, torso: 0.85, hips: 0.75 },
};

const SIDES: readonly Side[] = ['left', 'right'];

/**
 * Devuelve una función que cambia las proporciones del esqueleto (para `createWorld({ prepare })`).
 * Mueve las posiciones locales de los huesos (el largo de un hueso es la posición de su hijo) y
 * después sube o baja las caderas para que los tobillos queden a la misma altura que antes: los
 * pies siguen apoyados en el suelo, a la altura de la raíz, como en un modelo exportado.
 */
export function reshape(p: Proportions): (model: Object3D) => void {
  return (model) => {
    model.updateMatrixWorld(true);
    const { rig } = mapHumanRig(model, MODEL_MAPPING);
    const ankleHeight = averageAnkleY(rig);

    const thigh = (p.legs ?? 1) * (p.thigh ?? 1);
    const shin = (p.legs ?? 1) * (p.shin ?? 1);
    for (const side of SIDES) {
      rig[side].shin.position.multiplyScalar(thigh);
      rig[side].foot.position.multiplyScalar(shin);
    }

    if (p.torso !== undefined) {
      // Cada hueso entre las caderas y el cuello (incluidos los que el mapping no nombra).
      let bone: Object3D | null = rig.neck ?? rig.chest ?? rig.spine ?? null;
      while (bone && bone !== rig.hips) {
        bone.position.multiplyScalar(p.torso);
        bone = bone.parent;
      }
    }

    if (p.hips !== undefined) {
      // Solo la componente lateral de la posición de cada muslo (en el espacio de las caderas).
      const lateral = new Vector3().subVectors(rig.right.thigh.position, rig.left.thigh.position).normalize();
      for (const side of SIDES) {
        const position = rig[side].thigh.position;
        position.addScaledVector(lateral, position.dot(lateral) * (p.hips - 1));
      }
    }

    if (p.arms !== undefined) {
      for (const arm of [rig.leftArm, rig.rightArm]) {
        if (!arm) continue;
        arm.forearm.position.multiplyScalar(p.arms);
        arm.hand.position.multiplyScalar(p.arms);
      }
    }

    model.updateMatrixWorld(true);
    if (p.feet !== undefined) {
      for (const side of SIDES) {
        const { foot, toe } = rig[side];
        if (!toe) continue;
        const ankle = foot.getWorldPosition(new Vector3());
        const offset = toe.getWorldPosition(new Vector3()).sub(ankle);
        const target = ankle.add(new Vector3(offset.x * p.feet, offset.y, offset.z * p.feet));
        toe.position.copy(foot.worldToLocal(target));
      }
      model.updateMatrixWorld(true);
    }

    // Los tobillos, a la altura que tenían: las caderas suben o bajan lo que cambió la pierna.
    const hips = rig.hips;
    const target = hips.getWorldPosition(new Vector3());
    target.y += ankleHeight - averageAnkleY(rig);
    hips.position.copy(hips.parent!.worldToLocal(target));
    model.updateMatrixWorld(true);
  };
}

function averageAnkleY(rig: HumanRig): number {
  const v = new Vector3();
  return (rig.left.foot.getWorldPosition(v).y + rig.right.foot.getWorldPosition(v).y) / 2;
}
