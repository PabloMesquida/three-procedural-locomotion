import { readFileSync } from 'node:fs';

import { Euler, Matrix4, Quaternion, Vector3 } from 'three';

import type { Landmarks, LandmarkSeries } from './gaitAnalysis.ts';

/**
 * Lector de capturas ASF/AMC (formato de la base de datos de mocap de CMU, mocap.cs.cmu.edu).
 *
 * El .asf describe el esqueleto de un sujeto (dirección y largo de cada hueso en reposo, sus
 * ejes y sus grados de libertad); cada .amc, una toma: los ángulos de cada hueso en cada frame.
 * Aquí solo se calcula la cinemática directa para obtener los puntos que usa el análisis de
 * marcha (caderas, rodillas, tobillos…), en metros y con Y hacia arriba.
 */

interface AsfBone {
  name: string;
  /** Dirección del hueso en reposo (world, unitaria). */
  direction: Vector3;
  length: number;
  /** Ejes locales del hueso (C) y su inversa. */
  axis: Matrix4;
  axisInv: Matrix4;
  dof: string[];
  children: string[];
}

export interface AsfSkeleton {
  /** Metros por unidad del archivo. */
  scale: number;
  bones: Map<string, AsfBone>;
  rootChildren: string[];
  rootOrder: string[];
}

const DEG = Math.PI / 180;

/** Rotación de los ángulos de Euler del formato: X, luego Y, luego Z (ejes fijos). */
function eulerXYZ(x: number, y: number, z: number): Matrix4 {
  return new Matrix4().makeRotationFromEuler(new Euler(x * DEG, y * DEG, z * DEG, 'ZYX'));
}

export function parseAsf(text: string): AsfSkeleton {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const bones = new Map<string, AsfBone>();
  const rootChildren: string[] = [];
  let rootOrder: string[] = [];
  let lengthUnit = 1;
  let section = '';
  let current: Partial<AsfBone> & { axisAngles?: number[] } = {};

  for (const line of lines) {
    if (line.startsWith(':')) {
      section = line.split(/\s+/)[0];
      continue;
    }
    const [key, ...rest] = line.split(/\s+/);
    if (section === ':units' && key === 'length') lengthUnit = Number(rest[0]);
    else if (section === ':root' && key === 'order') rootOrder = rest.map((s) => s.toLowerCase());
    else if (section === ':bonedata') {
      if (key === 'begin') current = { dof: [], children: [] };
      else if (key === 'name') current.name = rest[0];
      else if (key === 'direction') current.direction = new Vector3(...rest.slice(0, 3).map(Number)).normalize();
      else if (key === 'length') current.length = Number(rest[0]);
      else if (key === 'axis') current.axisAngles = rest.slice(0, 3).map(Number);
      else if (key === 'dof') current.dof = rest;
      else if (key === 'end') {
        const axis = eulerXYZ(...(current.axisAngles as [number, number, number]));
        bones.set(current.name!, { ...(current as AsfBone), axis, axisInv: axis.clone().invert() });
      }
    } else if (section === ':hierarchy' && key !== 'begin' && key !== 'end') {
      const children = key === 'root' ? rootChildren : bones.get(key)?.children;
      children?.push(...rest);
    }
  }
  // Unidades de CMU: largo = pulgadas × `length` del .asf.
  return { scale: 0.0254 / lengthUnit, bones, rootChildren, rootOrder };
}

/** Frames de un .amc: por frame, los valores de cada hueso (grados y unidades del archivo). */
export function parseAmc(text: string): Map<string, number[]>[] {
  const frames: Map<string, number[]>[] = [];
  let frame: Map<string, number[]> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(':')) continue;
    if (/^\d+$/.test(line)) {
      frame = new Map();
      frames.push(frame);
      continue;
    }
    const [name, ...values] = line.split(/\s+/);
    frame?.set(name, values.map(Number));
  }
  return frames;
}

/** Giro de un hueso respecto a su padre (en reposo, la identidad: los ejes de CMU son los de world) y orientación world del padre. */
export interface AsfRotation {
  local: Quaternion;
  parent: Quaternion;
}

/**
 * Posición del extremo de cada hueso (m, world) en un frame. Sin `values`: pose de reposo. Con
 * `rotations`, guarda además el giro de cada hueso (y de la raíz, `root`).
 */
export function forwardKinematics(skeleton: AsfSkeleton, values?: Map<string, number[]>, rotations?: Map<string, AsfRotation>): Map<string, Vector3> {
  const out = new Map<string, Vector3>();
  const root = values?.get('root') ?? [0, 0, 0, 0, 0, 0];
  const get = (channel: string): number => root[skeleton.rootOrder.indexOf(channel)] ?? 0;
  const rootPosition = new Vector3(get('tx'), get('ty'), get('tz')).multiplyScalar(skeleton.scale);
  const rootMatrix = eulerXYZ(get('rx'), get('ry'), get('rz'));
  out.set('root', rootPosition);
  rotations?.set('root', { local: new Quaternion().setFromRotationMatrix(rootMatrix), parent: new Quaternion() });

  const visit = (name: string, parentMatrix: Matrix4, parentEnd: Vector3): void => {
    const bone = skeleton.bones.get(name);
    if (!bone) return;
    const v = values?.get(name) ?? [];
    const angle = (axis: string): number => {
      const i = bone.dof.indexOf(axis);
      return i >= 0 ? v[i] ?? 0 : 0;
    };
    const local = bone.axis.clone().multiply(eulerXYZ(angle('rx'), angle('ry'), angle('rz'))).multiply(bone.axisInv);
    const matrix = parentMatrix.clone().multiply(local);
    rotations?.set(name, { local: new Quaternion().setFromRotationMatrix(local), parent: new Quaternion().setFromRotationMatrix(parentMatrix) });
    const end = bone.direction.clone().transformDirection(matrix).multiplyScalar(bone.length * skeleton.scale).add(parentEnd);
    out.set(name, end);
    for (const child of bone.children) visit(child, matrix, end);
  };
  for (const child of skeleton.rootChildren) visit(child, rootMatrix, rootPosition);
  return out;
}

function landmarksOf(p: Map<string, Vector3>): Landmarks {
  const g = (name: string): Vector3 => p.get(name)!.clone();
  return {
    pelvis: g('root'),
    chest: g('thorax'),
    head: g('upperneck'),
    hip: { left: g('lhipjoint'), right: g('rhipjoint') },
    knee: { left: g('lfemur'), right: g('rfemur') },
    ankle: { left: g('ltibia'), right: g('rtibia') },
    toe: { left: g('lfoot'), right: g('rfoot') },
    shoulder: { left: g('lclavicle'), right: g('rclavicle') },
    elbow: { left: g('lhumerus'), right: g('rhumerus') },
    wrist: { left: g('lradius'), right: g('rradius') },
    hand: { left: g('lhand'), right: g('rhand') },
  };
}

/** Carga una toma (.asf del sujeto + .amc) como serie de puntos para el análisis de marcha. */
export function loadMocap(asfPath: string, amcPath: string, fps = 120): LandmarkSeries {
  const skeleton = parseAsf(readFileSync(asfPath, 'utf8'));
  const frames = parseAmc(readFileSync(amcPath, 'utf8')).map((f) => landmarksOf(forwardKinematics(skeleton, f)));
  const rest = landmarksOf(forwardKinematics(skeleton));
  const bone = (name: string): number => skeleton.bones.get(name)!.length * skeleton.scale;
  const legLength = (bone('lfemur') + bone('ltibia') + bone('rfemur') + bone('rtibia')) / 2;
  return { dt: 1 / fps, legLength, rest, frames };
}
