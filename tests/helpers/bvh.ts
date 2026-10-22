import { readFileSync } from 'node:fs';

import { Matrix4, Quaternion, Vector3 } from 'three';

import type { Landmarks, LandmarkSeries } from './gaitAnalysis.ts';

/**
 * Lector de capturas BVH (formato de la base de datos de mocap de SFU, mocap.cs.sfu.ca).
 *
 * Un .bvh trae el esqueleto (offset de cada articulación respecto a su padre, en reposo) y, por
 * frame, los canales de cada articulación: posición (solo la raíz) y rotaciones de Euler en el
 * orden en que se declaran (`Xrotation Yrotation Zrotation` → Rx·Ry·Rz). Aquí solo se calcula la
 * cinemática directa para obtener los puntos que usa el análisis de marcha, en metros y con Y
 * hacia arriba.
 */

interface BvhJoint {
  name: string;
  parent: number;
  offset: Vector3;
  channels: string[];
  /** Índice de su primer canal en cada frame. */
  first: number;
}

export interface BvhMotion {
  joints: BvhJoint[];
  dt: number;
  /** Valores de los canales por frame (grados y unidades del archivo). */
  frames: number[][];
}

/** SFU usa pulgadas (pierna cadera → tobillo ≈ 31 unidades en sujetos de ~1,6 m). */
export const SFU_SCALE = 0.0254;

const DEG = Math.PI / 180;

export function parseBvh(text: string): BvhMotion {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const joints: BvhJoint[] = [];
  // Pila de articulaciones abiertas; -1 para los `End Site` (sin canales, no se guardan).
  const stack: number[] = [];
  let channelCount = 0;
  let i = 0;
  for (; i < lines.length && lines[i] !== 'MOTION'; i++) {
    const [key, ...rest] = lines[i].split(/\s+/);
    if (key === 'ROOT' || key === 'JOINT') {
      const parent = [...stack].reverse().find((j) => j >= 0) ?? -1;
      joints.push({ name: rest[0], parent, offset: new Vector3(), channels: [], first: channelCount });
      stack.push(joints.length - 1);
    } else if (key === 'End') stack.push(-1);
    else if (key === '}') stack.pop();
    else if (key === 'OFFSET' && stack[stack.length - 1] >= 0) joints[stack[stack.length - 1]].offset.set(...(rest.slice(0, 3).map(Number) as [number, number, number]));
    else if (key === 'CHANNELS') {
      const joint = joints[stack[stack.length - 1]];
      joint.first = channelCount;
      joint.channels = rest.slice(1);
      channelCount += joint.channels.length;
    }
  }
  const count = Number(lines[i + 1].split(':')[1]);
  const dt = Number(lines[i + 2].split(':')[1]);
  const frames = lines.slice(i + 3, i + 3 + count).map((l) => l.split(/\s+/).map(Number));
  return { joints, dt, frames };
}

const AXES = { X: new Vector3(1, 0, 0), Y: new Vector3(0, 1, 0), Z: new Vector3(0, 0, 1) } as const;

/** Rotación local de cada articulación (la del frame; en reposo es la identidad) y su transformación world, en unidades del archivo. */
export function bvhPose(motion: BvhMotion, frame?: number[]): { local: Quaternion[]; world: Matrix4[] } {
  const local: Quaternion[] = [];
  const world: Matrix4[] = [];
  const rotation = new Matrix4();
  for (const [index, joint] of motion.joints.entries()) {
    const m = new Matrix4().makeTranslation(joint.offset.x, joint.offset.y, joint.offset.z);
    const r = new Matrix4();
    joint.channels.forEach((channel, c) => {
      const value = frame?.[joint.first + c] ?? 0;
      const axis = AXES[channel[0] as keyof typeof AXES];
      if (channel.endsWith('position')) m.multiply(new Matrix4().makeTranslation(axis.x * value, axis.y * value, axis.z * value));
      else r.multiply(rotation.makeRotationAxis(axis, value * DEG));
    });
    m.multiply(r);
    local[index] = new Quaternion().setFromRotationMatrix(r);
    world[index] = joint.parent >= 0 ? world[joint.parent].clone().multiply(m) : m;
  }
  return { local, world };
}

/** Posición de cada articulación (m, world) en un frame. Sin `frame`: pose de reposo. */
export function bvhForwardKinematics(motion: BvhMotion, scale: number, frame?: number[]): Map<string, Vector3> {
  const { world } = bvhPose(motion, frame);
  return new Map(motion.joints.map((joint, i) => [joint.name, new Vector3().setFromMatrixPosition(world[i]).multiplyScalar(scale)]));
}

/** Puntos del cuerpo en el esqueleto de SFU (cada articulación está en su origen). */
function landmarksOf(p: Map<string, Vector3>): Landmarks {
  const g = (name: string): Vector3 => p.get(name)!.clone();
  const sides = (left: string, right: string) => ({ left: g(left), right: g(right) });
  return {
    pelvis: g('Hips'),
    chest: g('Neck'),
    head: g('Head'),
    hip: sides('LeftUpLeg', 'RightUpLeg'),
    knee: sides('LeftLeg', 'RightLeg'),
    ankle: sides('LeftFoot', 'RightFoot'),
    toe: sides('LeftToeBase', 'RightToeBase'),
    shoulder: sides('LeftArm', 'RightArm'),
    elbow: sides('LeftForeArm', 'RightForeArm'),
    wrist: sides('LeftHand', 'RightHand'),
    hand: sides('L_Wrist_End', 'R_Wrist_End'),
  };
}

/** Carga una toma .bvh de SFU como serie de puntos para el análisis de marcha. */
export function loadBvh(path: string, scale = SFU_SCALE): LandmarkSeries {
  const motion = parseBvh(readFileSync(path, 'utf8'));
  const frames = motion.frames.map((f) => landmarksOf(bvhForwardKinematics(motion, scale, f)));
  const rest = landmarksOf(bvhForwardKinematics(motion, scale));
  const leg = (side: 'left' | 'right'): number => rest.hip[side].distanceTo(rest.knee[side]) + rest.knee[side].distanceTo(rest.ankle[side]);
  return { dt: motion.dt, legLength: (leg('left') + leg('right')) / 2, rest, frames };
}
