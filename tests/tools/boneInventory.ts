import { existsSync, readFileSync } from 'node:fs';

import { Bone, Matrix4, type Object3D, Quaternion, Vector3 } from 'three';

import type { HumanRig } from '../../src/index.ts';
import { bvhPose, loadBvh, parseBvh } from '../helpers/bvh.ts';
import { type LandmarkSeries, straightStretches } from '../helpers/gaitAnalysis.ts';
import { type AsfRotation, forwardKinematics, loadMocap, parseAmc, parseAsf } from '../helpers/mocap.ts';
import { createWorld, MODEL_PATH, simulate } from '../helpers/sim.ts';

/**
 * Inventario de huesos: cuánto se mueve cada hueso del modelo de los tests al caminar a 1,2 m/s y quién
 * lo mueve, frente a los mismos segmentos en el mocap de SFU y de CMU (si están en recursos/).
 *
 *   node scripts/run-tests.mjs zzz && node .test-build/tests/tools/boneInventory.js
 *   (otro modelo: PH_MODEL=modelos/human.glb PH_MAPPING=rigify)
 *
 * Se mide la oscilación de cada hueso respecto a su pose media al caminar (no a la de reposo, que en
 * cada esqueleto es distinta: T-pose, A-pose…), en los ejes del personaje para que se compare igual
 * en cualquier rig: flexión (eje lateral), giro (eje vertical) e inclinación (eje de avance). La
 * pelvis, respecto al rumbo. Rango = percentil 95 − percentil 5, en grados.
 */

const UP = new Vector3(0, 1, 0);
const DEGREES = 180 / Math.PI;

interface Sample {
  /** Rotación local del hueso. */
  local: Quaternion;
  /** Orientación world de los ejes en que actúa `local` (la del padre). */
  parent: Quaternion;
  /** Dirección de avance (horizontal, unitaria). */
  forward: Vector3;
}

type Ranges = { flex: number; yaw: number; roll: number; mean: Quaternion };

/** Vector de rotación (eje × ángulo, rad) de `q`. */
function rotationVector(q: Quaternion): Vector3 {
  const h = q.w < 0 ? new Quaternion(-q.x, -q.y, -q.z, -q.w) : q;
  const s = Math.sqrt(Math.max(0, 1 - h.w * h.w));
  return s > 1e-9 ? new Vector3(h.x, h.y, h.z).multiplyScalar((2 * Math.acos(Math.min(1, h.w))) / s) : new Vector3();
}

/** Media de cuaternios cercanos (con el signo alineado). */
function meanQuaternion(list: Quaternion[]): Quaternion {
  const ref = list[0];
  const sum = [0, 0, 0, 0];
  for (const q of list) {
    const k = q.dot(ref) < 0 ? -1 : 1;
    sum[0] += q.x * k;
    sum[1] += q.y * k;
    sum[2] += q.z * k;
    sum[3] += q.w * k;
  }
  return new Quaternion(...(sum as [number, number, number, number])).normalize();
}

function ranges(samples: Sample[]): Ranges {
  const mean = meanQuaternion(samples.map((s) => s.local));
  const inverse = mean.clone().invert();
  const parts = samples.map((s) => {
    // Desvío respecto a la pose media, con sus ejes llevados a world.
    const v = rotationVector(inverse.clone().multiply(s.local)).applyQuaternion(s.parent.clone().multiply(mean));
    const right = new Vector3().crossVectors(s.forward, UP);
    return [v.dot(right), v.dot(UP), v.dot(s.forward)];
  });
  const spread = (k: number): number => {
    const v = parts.map((p) => p[k]).sort((a, b) => a - b);
    return (v[Math.floor(0.95 * (v.length - 1))] - v[Math.floor(0.05 * (v.length - 1))]) * DEGREES;
  };
  return { flex: spread(0), yaw: spread(1), roll: spread(2), mean };
}

/** Papel de cada hueso del rig y qué parte de la librería lo mueve. */
function roles(rig: HumanRig): Map<Object3D, { role: string; by: string }> {
  const out = new Map<Object3D, { role: string; by: string }>();
  const set = (bone: Object3D | undefined, role: string, by: string): void => {
    if (bone) out.set(bone, { role, by });
  };
  // Huesos intermedios de la cadena de padres (columna media, cuello alto): no están en el mapping.
  const between = (lower: Object3D | undefined, upper: Object3D | undefined, role: string): void => {
    for (let b = upper?.parent; lower && b && b !== lower; b = b.parent) set(b, role, 'nadie');
  };
  set(rig.hips, 'hips', 'PelvisController');
  set(rig.spine, 'spine', 'TorsoController');
  set(rig.chest, 'chest', 'TorsoController');
  set(rig.neck, 'neck', 'TorsoController');
  set(rig.head, 'head', 'TorsoController');
  between(rig.spine, rig.chest, 'spine.mid');
  between(rig.neck, rig.head, 'neck.mid');
  for (const side of ['left', 'right'] as const) {
    const leg = rig[side];
    set(leg.thigh, `${side}.thigh`, 'LegIK');
    set(leg.shin, `${side}.shin`, 'LegIK');
    set(leg.foot, `${side}.foot`, 'LegIK + FootRoll');
    set(leg.toe, `${side}.toe`, 'FootRoll');
    set(leg.thighTwist, `${side}.thighTwist`, 'TwistController');
    set(leg.shinTwist, `${side}.shinTwist`, 'TwistController');
    const arm = side === 'left' ? rig.leftArm : rig.rightArm;
    if (!arm) continue;
    set(arm.shoulder, `${side}.shoulder`, 'ArmController');
    set(arm.upperArm, `${side}.upperArm`, 'ArmController');
    set(arm.forearm, `${side}.forearm`, 'ArmController');
    set(arm.hand, `${side}.hand`, 'ArmController');
    set(arm.upperArmTwist, `${side}.upperArmTwist`, 'TwistController');
    set(arm.forearmTwist, `${side}.forearmTwist`, 'TwistController');
    for (const [finger, bones] of Object.entries(arm.fingers ?? {})) bones.forEach((b, i) => set(b, `${side}.${finger}${i + 1}`, 'HandFingers'));
  }
  return out;
}

/** La librería: cada hueso del modelo caminando en recta a 1,2 m/s (8 s tras 4 s de arranque). */
function library(): { name: string; role: string; by: string; r: Ranges; pose: number }[] {
  const world = createWorld();
  const human = world.human;
  const bones: Bone[] = [];
  world.model.traverse((o) => {
    if (o instanceof Bone) bones.push(o);
  });
  // La pelvis se mide en world (la librería también gira el modelo), el resto respecto a su padre.
  const hips = human.rig.hips;
  const pose = (b: Bone): Sample => ({
    local: b === hips ? b.getWorldQuaternion(new Quaternion()) : b.quaternion.clone(),
    parent: b === hips || !b.parent ? new Quaternion() : b.parent.getWorldQuaternion(new Quaternion()),
    forward: UP, // se rellena al final (marcha en recta)
  });
  human.restPose();
  world.model.updateMatrixWorld(true);
  const rest = bones.map((b) => pose(b).local);
  human.reset();
  const dt = 1 / 120;
  simulate(world, 4, [[0, (h) => { h.targetSpeed = 1.2; }]], { dt });
  const samples: Sample[][] = bones.map(() => []);
  const start = hips.getWorldPosition(new Vector3());
  simulate(world, 8, [], { dt, start: 4, onFrame: () => bones.forEach((b, i) => samples[i].push(pose(b))) });
  const forward = human.rig.hips.getWorldPosition(new Vector3()).sub(start).setY(0).normalize();
  for (const list of samples) for (const s of list) s.forward = forward;
  const info = roles(human.rig);
  return bones.map((b, i) => {
    const r = ranges(samples[i]);
    // Cuánto se aparta su pose media de la de reposo (una pose fija, como la mano relajada, no oscila).
    return { name: b.name, ...(info.get(b) ?? { role: '—', by: '—' }), r, pose: r.mean.angleTo(rest[i]) * DEGREES };
  });
}

/** Rumbo de la pelvis en ±0,5 s (un paso) en el frame `f`: los tramos "rectos" aún derivan algunos grados por segundo. */
function forwardAt(series: LandmarkSeries, f: number): Vector3 {
  const w = Math.round(0.5 / series.dt);
  const a = series.frames[Math.max(0, f - w)].pelvis;
  const b = series.frames[Math.min(series.frames.length - 1, f + w)].pelvis;
  return b.clone().sub(a).setY(0).normalize();
}

/** Promedio de los rangos de varios tramos (cada tramo pesa igual). */
function averageRanges(list: Map<string, Ranges>[]): Map<string, Ranges> {
  const out = new Map<string, Ranges>();
  for (const name of list[0].keys()) {
    const rs = list.map((m) => m.get(name)!);
    const mean = (k: 'flex' | 'yaw' | 'roll'): number => rs.reduce((sum, r) => sum + r[k], 0) / rs.length;
    out.set(name, { flex: mean('flex'), yaw: mean('yaw'), roll: mean('roll'), mean: rs[0].mean });
  }
  return out;
}

/**
 * Rangos de cada hueso de una toma de mocap en cada tramo (s). `pose(f)` da el giro de cada hueso
 * respecto a su padre; la raíz se mide respecto al rumbo. Los dos esqueletos (SFU y CMU) miran hacia
 * +Z en reposo.
 */
function mocapRanges(
  series: LandmarkSeries,
  stretches: [number, number][],
  root: string,
  pose: (f: number) => Map<string, { local: Quaternion; parent: Quaternion }>,
): Map<string, Ranges>[] {
  return stretches.map(([a, b]) => {
    const samples = new Map<string, Sample[]>();
    for (let f = Math.round(a / series.dt); f < Math.round(b / series.dt); f++) {
      const forward = forwardAt(series, f);
      const heading = new Quaternion().setFromAxisAngle(UP, Math.atan2(forward.x, forward.z));
      for (const [name, r] of pose(f)) {
        const sample = name === root ? { local: heading.clone().invert().multiply(r.local), parent: heading, forward } : { ...r, forward };
        if (!samples.has(name)) samples.set(name, []);
        samples.get(name)!.push(sample);
      }
    }
    return new Map([...samples].map(([name, list]) => [name, ranges(list)]));
  });
}

/** SFU: tramos rectos de 0018_Walking001 (los de npm run mocap -- 0018). */
function sfu(): Map<string, Ranges> | null {
  const path = 'recursos/mocap-sfu/0018_Walking001.bvh';
  if (!existsSync(path)) return null;
  const motion = parseBvh(readFileSync(path, 'utf8'));
  const series = loadBvh(path);
  return averageRanges(mocapRanges(series, straightStretches(series), 'Hips', (f) => {
    const { local, world } = bvhPose(motion, motion.frames[f]);
    return new Map(motion.joints.map((joint, i) => [joint.name, {
      local: local[i],
      parent: joint.parent >= 0 ? new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(world[joint.parent])) : new Quaternion(),
    }]));
  }));
}

/** CMU: las cuatro tomas de caminar normal (las de tests/reference/cmu-caminar.json), enteras: son rectas y cortas (3–4 s). */
const CMU_WALK = ['35_01', '35_02', '35_03', '16_15'];

function cmu(): Map<string, Ranges> | null {
  const dir = 'recursos/mocap-cmu/';
  if (!existsSync(`${dir}35.asf`)) return null;
  return averageRanges(CMU_WALK.flatMap((id) => {
    const asf = `${dir}${id.split('_')[0]}.asf`;
    const amc = `${dir}${id}.amc`;
    const skeleton = parseAsf(readFileSync(asf, 'utf8'));
    const frames = parseAmc(readFileSync(amc, 'utf8'));
    const series = loadMocap(asf, amc);
    return mocapRanges(series, [[0, series.frames.length * series.dt]], 'root', (f) => {
      const rotations = new Map<string, AsfRotation>();
      forwardKinematics(skeleton, frames[f], rotations);
      return rotations;
    });
  }));
}

/**
 * Segmentos del cuerpo: papel en el rig (`*.mid`: huesos intermedios de la cadena, sin mapping) y
 * hueso equivalente en SFU y en CMU (lado izquierdo).
 */
const SEGMENTS: [label: string, role: string, sfu: string, cmu: string][] = [
  ['pelvis', 'hips', 'Hips', 'root'],
  ['columna baja', 'spine', 'Spine', 'lowerback'],
  ['columna media', 'spine.mid', '', 'upperback'],
  ['pecho', 'chest', 'Spine1', 'thorax'],
  ['cuello', 'neck', 'Neck', 'lowerneck'],
  ['cuello alto', 'neck.mid', '', 'upperneck'],
  ['cabeza', 'head', 'Head', 'head'],
  ['clavícula', 'left.shoulder', 'LeftShoulder', 'lclavicle'],
  ['brazo', 'left.upperArm', 'LeftArm', 'lhumerus'],
  ['antebrazo', 'left.forearm', 'LeftForeArm', 'lradius'],
  ['giro del antebrazo', 'left.forearmTwist', '', 'lwrist'],
  ['mano', 'left.hand', 'LeftHand', 'lhand'],
  ['muslo', 'left.thigh', 'LeftUpLeg', 'lfemur'],
  ['pierna', 'left.shin', 'LeftLeg', 'ltibia'],
  ['pie', 'left.foot', 'LeftFoot', 'lfoot'],
  ['dedos del pie', 'left.toe', 'LeftToeBase', 'ltoes'],
];

const fmt = (r: Ranges | undefined): string => (r ? `${r.flex.toFixed(1)} / ${r.yaw.toFixed(1)} / ${r.roll.toFixed(1)}` : '');
const MOVES = 0.5; // grados: por debajo, el hueso se considera quieto
const moves = (r: Ranges): boolean => Math.max(r.flex, r.yaw, r.roll) > MOVES;

const lib = library();
const sfuRanges = sfu();
const cmuRanges = cmu();
console.log(`\nModelo: ${MODEL_PATH}, ${lib.length} huesos. Rangos al caminar a 1,2 m/s: flexión / giro / inclinación (°).\n`);
console.log('| hueso | papel | lo mueve | pose media − reposo | librería |');
console.log('|---|---|---|---|---|');
const quiet: string[] = [];
for (const b of lib) {
  if (b.role.startsWith('right.') || /R(\d{3})?$|^mixamorigRight/.test(b.name)) continue; // simétrico: basta el izquierdo (GLTFLoader quita los puntos: thighR, forearmR001)
  if (!moves(b.r) && b.pose < MOVES && b.role === '—') {
    quiet.push(b.name);
    continue;
  }
  console.log(`| ${b.name} | ${b.role} | ${b.by} | ${b.pose.toFixed(0)}° | ${moves(b.r) ? fmt(b.r) : 'no oscila'} |`);
}
console.log(`\nSin mapear, quietos y en su pose de reposo, lado izquierdo y centro (${quiet.length}): ${quiet.join(', ')}`);

console.log(`\nPor segmento, frente a personas (SFU: 0018_Walking001; CMU: ${CMU_WALK.join(', ')}; tramos rectos):\n`);
console.log('| segmento | librería | SFU | CMU |');
console.log('|---|---|---|---|');
for (const [label, role, sfuJoint, cmuBone] of SEGMENTS) {
  const bones = lib.filter((b) => b.role === role);
  const own = bones.length === 0 ? '—' : bones.map((b) => (moves(b.r) ? fmt(b.r) : 'quieto') + (bones.length > 1 ? ` (${b.name})` : '')).join('; ');
  console.log(`| ${label} | ${own} | ${fmt(sfuRanges?.get(sfuJoint))} | ${fmt(cmuRanges?.get(cmuBone))} |`);
}
