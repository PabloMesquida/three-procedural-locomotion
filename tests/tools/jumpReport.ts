import { Vector3 } from 'three';

import type { Landmarks, LandmarkSeries } from '../helpers/gaitAnalysis.ts';
import { humanLandmarks } from '../helpers/humanLandmarks.ts';
import { loadMocap } from '../helpers/mocap.ts';
import { simulate } from '../helpers/sim.ts';
import { gapWorld } from './gapLab.ts';

// Saltos de un pie a otro: capturas de CMU (recursos/mocap-cmu/, ver docs/en/naturalness.md) frente al salto sobre un
// hueco de la librería (maxGapJump). En cada toma busca el vuelo más largo y mide el despegue, el punto más alto y el
// aterrizaje: ángulos de muslo y rodilla de cada pierna, apertura de las piernas, tronco, brazos y pelvis.
//   node .test-build/tests/tools/jumpReport.js [tomas separadas por comas]     LIB=ancho:velocidad,… para la librería
const DEG = 180 / Math.PI;
const DIR = 'recursos/mocap-cmu/';
type Side = 'left' | 'right';
const SIDES: readonly Side[] = ['left', 'right'];
const other = (s: Side): Side => (s === 'left' ? 'right' : 'left');

/** Tomas: id → fotogramas por segundo (las del sujeto 75 son a 60). */
const TRIALS: Record<string, number> = {
  '127_25': 120, '127_26': 120, '127_27': 120, '127_28': 120,
  '49_04': 120, '49_05': 120, '75_01': 60, '75_02': 60, '75_03': 60,
  '16_05': 120, '16_06': 120, '16_09': 120, '16_10': 120, '13_11': 120, '13_13': 120,
  '83_42': 120, '83_43': 120,
};

interface Pose {
  /** Muslo respecto a la vertical, en el plano de avance (°, + adelante) y flexión de rodilla (°), de cada pierna. */
  thigh: Record<Side, number>;
  knee: Record<Side, number>;
  /** Tobillo respecto a la pelvis, a lo largo del avance (× pierna, + delante) y altura del tobillo sobre el suelo (× pierna). */
  ahead: Record<Side, number>;
  lift: Record<Side, number>;
  /** Brazo (húmero) respecto a la vertical (°, + adelante) y codo (°). */
  arm: Record<Side, number>;
  elbow: Record<Side, number>;
  /** Tobillo en punta respecto al reposo (°, + punta abajo: entre tibia y pie, más abierto que en reposo). */
  point: Record<Side, number>;
  /** Tronco respecto a la vertical (°, + adelante); pelvis sobre el suelo (× pierna). */
  trunk: number;
  pelvis: number;
}

interface Jump {
  label: string;
  /** Pie que despega y pie que cae primero (null: los dos a la vez). */
  takeoff: Side | 'both';
  landing: Side | 'both';
  speed: number;
  flight: number;
  distance: number;
  /** Pelvis antes de la preparación (media en el medio segundo antes), mínima en ella, al despegar, más alta, al caer, mínima después (× pierna). */
  pelvisBefore: number;
  pelvisCrouch: number;
  pelvisMinAfter: number;
  /** Tiempo de la preparación (pelvis por debajo de su altura de antes hasta despegar) y de la amortiguación (s). */
  crouchTime: number;
  absorbTime: number;
  atTakeoff: Pose;
  atApex: Pose;
  atLanding: Pose;
  after: Pose;
}

function flatten(v: Vector3, fwd: Vector3): { a: number; up: number } {
  return { a: v.dot(fwd), up: v.y };
}

function pose(f: Landmarks, rest: Landmarks, fwd: Vector3, floor: number, L: number): Pose {
  const thigh = {} as Record<Side, number>;
  const knee = {} as Record<Side, number>;
  const ahead = {} as Record<Side, number>;
  const lift = {} as Record<Side, number>;
  const arm = {} as Record<Side, number>;
  const elbow = {} as Record<Side, number>;
  const point = {} as Record<Side, number>;
  const ankleAngle = (q: Landmarks, s: Side): number => q.ankle[s].clone().sub(q.knee[s]).angleTo(q.toe[s].clone().sub(q.ankle[s])) * DEG;
  for (const s of SIDES) {
    point[s] = ankleAngle(f, s) - ankleAngle(rest, s);
    const t = flatten(f.knee[s].clone().sub(f.hip[s]), fwd);
    thigh[s] = Math.atan2(t.a, -t.up) * DEG;
    knee[s] = f.knee[s].clone().sub(f.hip[s]).angleTo(f.ankle[s].clone().sub(f.knee[s])) * DEG;
    ahead[s] = f.ankle[s].clone().sub(f.pelvis).dot(fwd) / L;
    lift[s] = (f.ankle[s].y - floor) / L;
    const u = flatten(f.elbow[s].clone().sub(f.shoulder[s]), fwd);
    arm[s] = Math.atan2(u.a, -u.up) * DEG;
    elbow[s] = f.elbow[s].clone().sub(f.shoulder[s]).angleTo(f.wrist[s].clone().sub(f.elbow[s])) * DEG;
  }
  const tr = flatten(f.chest.clone().sub(f.pelvis), fwd);
  return { thigh, knee, ahead, lift, arm, elbow, point, trunk: Math.atan2(tr.a, tr.up) * DEG, pelvis: (f.pelvis.y - floor) / L };
}

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(Math.max(Math.round(p * (s.length - 1)), 0), s.length - 1)];
}

/** El vuelo más largo de la serie (los dos pies en el aire), medido. null si no hay ninguno de más de 0,12 s. */
function analyze(series: LandmarkSeries, label: string): Jump | null {
  const { frames, dt, legLength: L } = series;
  const floorToe = percentile(frames.flatMap((f) => [f.toe.left.y, f.toe.right.y]), 0.02);
  const floorAnkle = percentile(frames.flatMap((f) => [f.ankle.left.y, f.ankle.right.y]), 0.02);
  const contact = (f: Landmarks, s: Side): boolean => f.toe[s].y < floorToe + 0.04 * L || f.ankle[s].y < floorAnkle + 0.04 * L;
  let best = [-1, -1];
  for (let i = 0; i < frames.length; ) {
    if (contact(frames[i], 'left') || contact(frames[i], 'right')) {
      i++;
      continue;
    }
    let j = i;
    while (j < frames.length && !contact(frames[j], 'left') && !contact(frames[j], 'right')) j++;
    if (i > 0 && j < frames.length && j - i > best[1] - best[0]) best = [i, j];
    i = j;
  }
  const [start, end] = best;
  if (start < 0 || (end - start) * dt < 0.12) return null;
  const t0 = start - 1;
  const t1 = end;
  const fwd = frames[t1].pelvis.clone().sub(frames[t0].pelvis).setY(0);
  const distance = fwd.length() / L;
  fwd.normalize();
  const floor = (floorAnkle + floorToe) / 2 - 0.0;
  const before = frames.slice(Math.max(t0 - Math.round(0.6 / dt), 0), Math.max(t0 - Math.round(0.3 / dt), 1));
  const pelvisBefore = before.reduce((s, f) => s + f.pelvis.y, 0) / before.length;
  const back = Math.max(t0 - Math.round(0.3 / dt), 0);
  const speed = frames[t0].pelvis.clone().sub(frames[back].pelvis).setY(0).length() / ((t0 - back) * dt);
  let apex = start;
  for (let k = start; k < end; k++) if (frames[k].pelvis.y > frames[apex].pelvis.y) apex = k;
  // Preparación: desde que la pelvis baja de la altura de antes hasta despegar.
  let crouchStart = t0;
  let crouchMin = t0;
  for (let k = t0; k > Math.max(t0 - Math.round(1 / dt), 0); k--) {
    if (frames[k].pelvis.y < frames[crouchMin].pelvis.y) crouchMin = k;
    if (frames[k].pelvis.y > pelvisBefore - 0.01 * L) {
      crouchStart = k;
      break;
    }
  }
  const window = frames.slice(t1, Math.min(t1 + Math.round(0.5 / dt), frames.length));
  let minAfter = 0;
  for (let k = 0; k < window.length; k++) if (window[k].pelvis.y < window[minAfter].pelvis.y) minAfter = k;
  let absorbEnd = minAfter;
  while (absorbEnd < window.length - 1 && window[absorbEnd].pelvis.y < pelvisBefore - 0.02 * L) absorbEnd++;
  const who = (k: number): Side | 'both' => {
    const l = contact(frames[k], 'left');
    const r = contact(frames[k], 'right');
    return l && r ? 'both' : l ? 'left' : 'right';
  };
  return {
    label,
    takeoff: who(t0),
    landing: who(t1),
    speed: speed,
    flight: (end - start) * dt,
    distance,
    pelvisBefore: (pelvisBefore - floor) / L,
    pelvisCrouch: (frames[crouchMin].pelvis.y - floor) / L,
    pelvisMinAfter: (window[minAfter].pelvis.y - floor) / L,
    crouchTime: (t0 - crouchStart) * dt,
    absorbTime: absorbEnd * dt,
    atTakeoff: pose(frames[t0], series.rest, fwd, floor, L),
    atApex: pose(frames[apex], series.rest, fwd, floor, L),
    atLanding: pose(frames[t1], series.rest, fwd, floor, L),
    after: pose(frames[Math.min(t1 + Math.round(0.15 / dt), frames.length - 1)], series.rest, fwd, floor, L),
  };
}

/** La librería: salto sobre un hueco de `width` m a `speed` m/s (con 10 m de carrera), como serie de puntos. */
function library(width: number, speed: number): LandmarkSeries {
  const world = gapWorld(width, 10);
  const { human } = world;
  human.restPose();
  const rest = humanLandmarks(human);
  human.reset();
  const frames: Landmarks[] = [];
  let landed = -1;
  let t = 0;
  human.on('land', () => { if (landed < 0) landed = t; });
  let liftoff = -1;
  human.on('liftoff', () => { if (liftoff < 0) liftoff = frames.length; });
  simulate(world, 60, [[0, (h) => { h.targetHeading = 0; h.targetSpeed = speed; }]], {
    dt: 1 / 120,
    onFrame: () => {
      t += 1 / 120;
      if (landed < 0 || t < landed + 0.6) frames.push(humanLandmarks(human));
    },
  });
  // Desde 1 s antes de despegar (antes, parado al empezar, también tenía los pies algo por encima del suelo).
  return { dt: 1 / 120, legLength: human.legLength, rest, frames: frames.slice(Math.max(liftoff - 120, 0)) };
}

const f0 = (x: number): string => x.toFixed(0).padStart(4);
const f2 = (x: number): string => x.toFixed(2).padStart(5);
function row(j: Jump): void {
  const lead: Side = j.landing === 'both' ? 'right' : j.landing;
  const trail = other(lead);
  const p = (name: string, q: Pose): string =>
    `${name} muslo ${f0(q.thigh[lead])}/${f0(q.thigh[trail])} rodilla ${f0(q.knee[lead])}/${f0(q.knee[trail])} tobillo ${f2(q.ahead[lead])}/${f2(q.ahead[trail])} alto ${f2(q.lift[lead])}/${f2(q.lift[trail])} brazo ${f0(q.arm[lead])}/${f0(q.arm[trail])} codo ${f0(q.elbow[lead])}/${f0(q.elbow[trail])} punta ${f0(q.point[lead])}/${f0(q.point[trail])} tronco ${f0(q.trunk)} pelvis ${f2(q.pelvis)}`;
  console.log(`\n${j.label}: despega ${j.takeoff}, cae ${j.landing} · ${j.speed.toFixed(2)} m/s · vuelo ${j.flight.toFixed(2)} s, ${j.distance.toFixed(2)} piernas`);
  console.log(`  pelvis antes ${f2(j.pelvisBefore)} · preparación ${f2(j.pelvisCrouch)} en ${j.crouchTime.toFixed(2)} s · tras caer ${f2(j.pelvisMinAfter)}, amortigua ${j.absorbTime.toFixed(2)} s   (× pierna; pierna de caída / la otra)`);
  console.log('  ' + p('despegue', j.atTakeoff));
  console.log('  ' + p('arriba  ', j.atApex));
  console.log('  ' + p('caída   ', j.atLanding));
  console.log('  ' + p('+0,15 s ', j.after));
}

const ids = (process.argv[2] ?? Object.keys(TRIALS).join(',')).split(',').filter(Boolean);
for (const id of ids) {
  if (!(id in TRIALS)) continue;
  const subject = id.split('_')[0];
  const j = analyze(loadMocap(`${DIR}${subject}.asf`, `${DIR}${id}.amc`, TRIALS[id]), `CMU ${id}`);
  if (j) row(j);
  else console.log(`\nCMU ${id}: sin vuelo largo`);
}
for (const spec of (process.env.LIB ?? '').split(',').filter(Boolean)) {
  const [width, speed] = spec.split(':').map(Number);
  const j = analyze(library(width, speed), `librería, hueco ${width} m a ${speed} m/s`);
  if (j) row(j);
}
