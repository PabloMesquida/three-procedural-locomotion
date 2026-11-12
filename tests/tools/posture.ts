// Postura y movimiento del tronco, la cabeza y los hombros (en llano, subiendo y bajando escaleras, trotando):
// capturas de CMU frente a la librería (ver docs/en/naturalness.md). Inclinación media del tronco y de la cabeza y
// cuánto oscilan con los pasos (RMS sin la media móvil de 1 s): cabeceo y ladeo de la cabeza, inclinación de la
// línea de los hombros, giro de los hombros respecto a las caderas, rebote de la cabeza respecto a la pelvis.
//
//   npm run mocap -- postura
//   ONLYLIB=1 LIBCFG='{"headInertia":0.5}' npm run mocap -- postura    solo la librería, con otra configuración
import { readFileSync } from 'node:fs';
import { BoxGeometry, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from 'three';

import { forwardKinematics, parseAmc, parseAsf } from '../helpers/mocap.ts';
import { createWorld, simulate } from '../helpers/sim.ts';

interface Frame {
  pelvis: Vector3;
  chest: Vector3;
  headBase: Vector3;
  headTop: Vector3;
  shoulders: [Vector3, Vector3];
  hips: [Vector3, Vector3];
}

const DEG = 180 / Math.PI;

/** Media móvil centrada de `values` (ventana de `n` muestras). */
function smooth(values: number[], n: number): number[] {
  const half = Math.floor(n / 2);
  return values.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(values.length - 1, i + half); k++) {
      sum += values[k];
      count++;
    }
    return sum / count;
  });
}

const rms = (v: number[]): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / Math.max(v.length, 1));
const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / Math.max(v.length, 1);

interface Measure {
  frames: number;
  lean: number;
  leanOsc: number;
  headPitch: number;
  headOsc: number;
  headRate: number;
  bob: number;
  accRatio: number;
  speed: number;
  climb: number;
  trunkRoll: number;
  headRoll: number;
  shoulderTilt: number;
  twist: number;
}

/**
 * Mide en los frames [a, b) de una serie a `dt`: inclinación del tronco (pelvis → base del cuello) y de la cabeza
 * (base → coronilla) en el plano sagital (°, + hacia delante), su oscilación con los pasos (RMS tras quitar la media
 * móvil de 1 s), el cabeceo (RMS de la velocidad angular, °/s), el rebote de la cabeza respecto de la pelvis (RMS
 * de su altura relativa sin la media, cm) y el cociente de aceleraciones verticales cabeza / pelvis (RMS).
 */
function measure(frames: Frame[], dt: number, a: number, b: number): Measure {
  const window = Math.round(1 / dt);
  const lean: number[] = [];
  const head: number[] = [];
  const rel: number[] = [];
  const headY: number[] = [];
  const pelvisY: number[] = [];
  const speeds: number[] = [];
  const climbs: number[] = [];
  const trunkRoll: number[] = [];
  const headRoll: number[] = [];
  const shoulderTilt: number[] = [];
  const twist: number[] = [];
  const step = Math.max(1, Math.round(0.25 / dt));
  for (let i = a; i < b; i++) {
    const f = frames[i];
    const i0 = Math.max(0, i - step);
    const i1 = Math.min(frames.length - 1, i + step);
    const fwd = new Vector3().subVectors(frames[i1].pelvis, frames[i0].pelvis).setY(0);
    const horizontal = fwd.length() / ((i1 - i0) * dt);
    fwd.normalize();
    const trunk = new Vector3().subVectors(f.chest, f.pelvis);
    lean.push(Math.atan2(trunk.dot(fwd), trunk.y) * DEG);
    const axis = new Vector3().subVectors(f.headTop, f.headBase);
    head.push(Math.atan2(axis.dot(fwd), axis.y) * DEG);
    rel.push(f.headBase.y - f.pelvis.y);
    const right = new Vector3().crossVectors(fwd, new Vector3(0, 1, 0)).normalize();
    trunkRoll.push(Math.atan2(trunk.dot(right), trunk.y) * DEG);
    headRoll.push(Math.atan2(axis.dot(right), axis.y) * DEG);
    const sh = new Vector3().subVectors(f.shoulders[0], f.shoulders[1]);
    shoulderTilt.push(Math.asin(sh.y / sh.length()) * DEG);
    const hp = new Vector3().subVectors(f.hips[0], f.hips[1]);
    twist.push((Math.atan2(sh.z, sh.x) - Math.atan2(hp.z, hp.x)) * DEG);
    headY.push(f.headBase.y);
    pelvisY.push(f.pelvis.y);
    speeds.push(horizontal);
    climbs.push((frames[i1].pelvis.y - frames[i0].pelvis.y) / ((i1 - i0) * dt));
  }
  const highPass = (v: number[]): number[] => {
    const s = smooth(v, window);
    return v.map((x, i) => x - s[i]);
  };
  const accel = (y: number[]): number[] => {
    const s = smooth(y, Math.max(1, Math.round(0.05 / dt)));
    const out: number[] = [];
    for (let i = 1; i < s.length - 1; i++) out.push((s[i + 1] - 2 * s[i] + s[i - 1]) / (dt * dt));
    return out;
  };
  const headSmooth = smooth(head, Math.max(1, Math.round(0.05 / dt)));
  const rate: number[] = [];
  for (let i = 1; i < headSmooth.length; i++) rate.push((headSmooth[i] - headSmooth[i - 1]) / dt);
  return {
    frames: b - a,
    lean: mean(lean),
    leanOsc: rms(highPass(lean)),
    headPitch: mean(head),
    headOsc: rms(highPass(head)),
    headRate: rms(rate),
    bob: rms(highPass(rel)) * 100,
    accRatio: rms(accel(headY)) / Math.max(rms(accel(pelvisY)), 1e-9),
    speed: mean(speeds),
    climb: mean(climbs),
    trunkRoll: rms(highPass(trunkRoll)),
    headRoll: rms(highPass(headRoll)),
    shoulderTilt: rms(highPass(shoulderTilt)),
    twist: rms(highPass(twist.map((x) => ((x + 540) % 360) - 180))),
  };
}

function print(name: string, m: Measure): void {
  console.log(
    `${name.padEnd(34)} ${String(m.frames).padStart(5)}  tronco ${m.lean.toFixed(1).padStart(5)}° ±${m.leanOsc.toFixed(2)}  ` +
      `cabeza ${m.headPitch.toFixed(1).padStart(5)}° ±${m.headOsc.toFixed(2)} (${m.headRate.toFixed(1)} °/s)  ` +
      `rebote ${m.bob.toFixed(2)} cm  acel. ${m.accRatio.toFixed(2)}  lateral: tronco ±${m.trunkRoll.toFixed(2)} cabeza ±${m.headRoll.toFixed(2)} hombros ±${m.shoulderTilt.toFixed(2)} giro hombros/caderas ±${m.twist.toFixed(2)}  v ${m.speed.toFixed(2)} sube ${m.climb.toFixed(2)}`,
  );
}

/** Tramos de una toma: subiendo, bajando o en llano (por la velocidad vertical de la pelvis, suavizada 0,5 s). */
function segments(frames: Frame[], dt: number): Record<'up' | 'down' | 'flat', [number, number][]> {
  const vy: number[] = [];
  const vh: number[] = [];
  const k = Math.round(0.25 / dt);
  for (let i = 0; i < frames.length; i++) {
    const i0 = Math.max(0, i - k);
    const i1 = Math.min(frames.length - 1, i + k);
    vy.push((frames[i1].pelvis.y - frames[i0].pelvis.y) / ((i1 - i0) * dt));
    vh.push(new Vector3().subVectors(frames[i1].pelvis, frames[i0].pelvis).setY(0).length() / ((i1 - i0) * dt));
  }
  const kind = (i: number): 'up' | 'down' | 'flat' | null =>
    vh[i] < 0.3 ? null : vy[i] > 0.08 ? 'up' : vy[i] < -0.08 ? 'down' : Math.abs(vy[i]) < 0.03 ? 'flat' : null;
  const out: Record<'up' | 'down' | 'flat', [number, number][]> = { up: [], down: [], flat: [] };
  let start = 0;
  for (let i = 1; i <= frames.length; i++) {
    if (i < frames.length && kind(i) === kind(start)) continue;
    const kd = kind(start);
    if (kd && (i - start) * dt > 0.5) out[kd].push([start, i]);
    start = i;
  }
  return out;
}

function loadCmu(subject: string, take: string): Frame[] {
  const skeleton = parseAsf(readFileSync(`recursos/mocap-cmu/${subject}.asf`, 'utf8'));
  return parseAmc(readFileSync(`recursos/mocap-cmu/${take}.amc`, 'utf8')).map((values) => {
    const p = forwardKinematics(skeleton, values);
    return {
      pelvis: p.get('root')!.clone(), chest: p.get('thorax')!.clone(), headBase: p.get('upperneck')!.clone(), headTop: p.get('head')!.clone(),
      shoulders: [p.get('lclavicle')!.clone(), p.get('rclavicle')!.clone()], hips: [p.get('lhipjoint')!.clone(), p.get('rhipjoint')!.clone()],
    };
  });
}

const takes: [string, string][] = process.env.ONLYLIB ? [] : [
  ['83', '83_27'], ['83', '83_28'], ['83', '83_29'], ['83', '83_30'], ['83', '83_31'], ['83', '83_32'], ['83', '83_34'], ['83', '83_35'],
  ['111', '111_27'], ['113', '113_19'], ['113', '113_20'], ['114', '114_07'], ['114', '114_08'], ['114', '114_09'], ['143', '143_17'],
];
const all: Record<'up' | 'down' | 'flat', { frames: Frame[]; range: [number, number]; subject: string }[]> = { up: [], down: [], flat: [] };
const dtCmu = 1 / 120;
for (const [subject, take] of takes) {
  const frames = loadCmu(subject, take);
  const seg = segments(frames, dtCmu);
  for (const kind of ['up', 'down', 'flat'] as const) {
    for (const range of seg[kind]) {
      all[kind].push({ frames, range, subject });

    }
  }
}
const pooled = (kind: 'up' | 'down' | 'flat', subject?: string): Measure => {
  const ms = all[kind].filter((s) => !subject || s.subject === subject).map(({ frames, range }) => measure(frames, dtCmu, range[0], range[1]));
  const total = ms.reduce((s, m) => s + m.frames, 0);
  const w = (f: (m: Measure) => number): number => ms.reduce((s, m) => s + f(m) * m.frames, 0) / total;
  return {
    frames: total, lean: w((m) => m.lean), leanOsc: w((m) => m.leanOsc), headPitch: w((m) => m.headPitch), headOsc: w((m) => m.headOsc),
    headRate: w((m) => m.headRate), bob: w((m) => m.bob), accRatio: w((m) => m.accRatio), speed: w((m) => m.speed), climb: w((m) => m.climb),
    trunkRoll: w((m) => m.trunkRoll), headRoll: w((m) => m.headRoll), shoulderTilt: w((m) => m.shoulderTilt), twist: w((m) => m.twist),
  };
};
console.log('');
for (const kind of ['flat', 'up', 'down'] as const) print(`CMU (todas) ${kind}`, pooled(kind));
for (const kind of ['flat', 'up'] as const) print(`CMU 83 ${kind}`, pooled(kind, '83'));
const walkTakes: [string, string][] = process.env.ONLYLIB ? [] : [['35', '35_01'], ['35', '35_02'], ['35', '35_03'], ['16', '16_15'], ['07', '07_04'], ['35', '35_17'], ['35', '35_18']];
for (const take of process.env.ONLYLIB ? [] : ['35_17', '35_18']) { const frames = loadCmu('35', take); print(`CMU ${take} trote (toda)`, measure(frames, dtCmu, Math.round(frames.length * 0.15), Math.round(frames.length * 0.85))); }
for (const [subject, take] of walkTakes) { const frames = loadCmu(subject, take); const seg = segments(frames, dtCmu); for (const range of seg.flat) print(`CMU ${take} caminar`, measure(frames, dtCmu, range[0], range[1])); }

// La librería: en llano y subiendo una escalera de 17 × 28 cm (hacia −Z), a 1 m/s.
function library(stairs: boolean, speed = 1): Measure {
  const world = createWorld({
    human: { config: JSON.parse(process.env.LIBCFG ?? '{}') },
    buildTerrain: (t) => {
      if (!stairs) return;
      for (let k = 1; k <= 24; k++) {
        const box = new Mesh(new BoxGeometry(1.6, 0.17 * k, 0.28), new MeshBasicMaterial());
        box.position.set(0, 0.085 * k, -2 - 0.28 * (k - 0.5));
        t.add(box);
      }
    },
  });
  const { human } = world;
  const rig = human.rig;
  const head = rig.head!;
  // Eje de la cabeza: el "arriba" del personaje en reposo, en el espacio local del hueso.
  const restUp = new Vector3(0, 0.2, 0).applyQuaternion(head.getWorldQuaternion(new Quaternion()).invert());
  const frames: Frame[] = [];
  const dt = 1 / 60;
  simulate(world, 9, [[0, (h) => { h.targetSpeed = speed; }]], {
    onFrame: () => {
      const base = head.getWorldPosition(new Vector3());
      frames.push({
        pelvis: rig.hips.getWorldPosition(new Vector3()),
        chest: (rig.neck ?? rig.chest ?? rig.hips).getWorldPosition(new Vector3()),
        headBase: base,
        headTop: restUp.clone().applyQuaternion(head.getWorldQuaternion(new Quaternion())).add(base),
        shoulders: [rig.leftArm!.upperArm.getWorldPosition(new Vector3()), rig.rightArm!.upperArm.getWorldPosition(new Vector3())],
        hips: [rig.left.thigh.getWorldPosition(new Vector3()), rig.right.thigh.getWorldPosition(new Vector3())],
      });
    },
  });
  // De 3 a 8 s: ya subiendo (o caminando) a ritmo.
  return measure(frames, dt, Math.round(3 / dt), Math.round(8 / dt));
}
console.log('');
print('Librería, llano', library(false));
print('Librería, subiendo 17 × 28', library(true));
print('Librería, llano a 1,4 m/s', library(false, 1.4));
print('Librería, corriendo a 3 m/s', library(false, 3));
