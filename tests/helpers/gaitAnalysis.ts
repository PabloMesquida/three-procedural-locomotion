import { Vector3 } from 'three';

import type { Side } from '../../src/index.ts';

/**
 * Análisis de marcha a partir de puntos del cuerpo (articulaciones), sin depender del esqueleto:
 * sirve igual para una captura de mocap que para el personaje de la librería. Todo en metros,
 * con Y hacia arriba.
 *
 * - Eventos (Zeni et al. 2008): apoyo de talón = tobillo más adelantado respecto a la pelvis;
 *   despegue = punta del pie más atrasada.
 * - Cada ciclo va de un apoyo de talón al siguiente del mismo pie y se normaliza a 0–100 %.
 * - Las curvas de los dos lados se promedian, con los signos laterales reflejados: "ipsi" es el
 *   lado del pie que empieza el ciclo.
 * - Ángulos en grados; longitudes divididas por el largo de pierna (cadera → rodilla → tobillo).
 */

export interface Landmarks {
  /** Centro de la pelvis. */
  pelvis: Vector3;
  /** Parte alta del tronco (base del cuello). */
  chest: Vector3;
  /** Base de la cabeza. */
  head: Vector3;
  hip: Record<Side, Vector3>;
  knee: Record<Side, Vector3>;
  ankle: Record<Side, Vector3>;
  /** Base de los dedos del pie. */
  toe: Record<Side, Vector3>;
  shoulder: Record<Side, Vector3>;
  elbow: Record<Side, Vector3>;
  wrist: Record<Side, Vector3>;
  /** Extremo de la mano (base de los dedos). */
  hand: Record<Side, Vector3>;
}

export interface LandmarkSeries {
  dt: number;
  legLength: number;
  /** Pose de reposo (para los ángulos que dependen de cómo está construido el esqueleto). */
  rest: Landmarks;
  frames: Landmarks[];
}

/** Curvas de un ciclo de marcha (medias, `SAMPLES` puntos de 0 a 100 %). */
export const CURVES = {
  thigh: 'Muslo respecto a la vertical (°, + adelante)',
  knee: 'Flexión de rodilla (°)',
  ankle: 'Flexión dorsal del tobillo respecto al reposo (°, + punta arriba)',
  footPitch: 'Inclinación del pie respecto al reposo (°, + punta arriba)',
  toeHeight: 'Altura de la base de los dedos sobre su mínimo (/ pierna)',
  ankleHeight: 'Altura del tobillo sobre su mínimo (/ pierna)',
  ankleAhead: 'Tobillo por delante de la cadera (/ pierna)',
  hipHeight: 'Altura de la cadera ipsi sobre su tobillo (/ pierna)',
  pelvisY: 'Altura de la pelvis (/ pierna, sin media)',
  pelvisX: 'Desplazamiento lateral de la pelvis hacia el lado ipsi (/ pierna, sin media)',
  pelvisYaw: 'Rotación de la pelvis (°, + cadera ipsi adelante)',
  pelvisRoll: 'Inclinación lateral de la pelvis (°, + cadera ipsi arriba)',
  trunkYaw: 'Rotación de los hombros respecto a la pelvis (°, + hombro ipsi adelante)',
  trunkPitch: 'Inclinación del tronco hacia delante respecto al reposo (°)',
  arm: 'Brazo ipsi respecto a la vertical (°, + adelante)',
  elbow: 'Flexión del codo ipsi (°)',
  neckPitch: 'Inclinación del cuello hacia delante respecto al reposo (°)',
  pelvisPitch: 'Basculación de la pelvis (°, + hacia delante, sin media)',
  shoulderRoll: 'Inclinación lateral de los hombros (°, + hombro ipsi arriba, sin media)',
  armCross: 'Brazo ipsi hacia fuera en el plano frontal (°, − hacia el centro, sin media)',
  forearmCross: 'Antebrazo ipsi hacia fuera en el plano frontal (°, − hacia el centro, sin media)',
  wristFrontal: 'Mano respecto al antebrazo en el plano frontal (°, + hacia fuera, sin media)',
  wristSagittal: 'Mano respecto al antebrazo en el plano sagital (°, + hacia delante, sin media)',
} as const;
export type CurveName = keyof typeof CURVES;
export const CURVE_NAMES = Object.keys(CURVES) as CurveName[];
export const SAMPLES = 51;

export interface GaitScalars {
  speed: number;
  /** Número de Froude: v² / (g·pierna). Caminar ≈ 0,1–0,4; se pasa a correr hacia 0,5. */
  froude: number;
  /** Pasos por minuto. */
  cadence: number;
  /** Zancada (dos pasos) / pierna. */
  strideLength: number;
  /** Fracción del ciclo con el pie apoyado. */
  stance: number;
  /** Fracción del ciclo con los dos pies apoyados. */
  doubleSupport: number;
  /** Separación lateral entre los tobillos en los apoyos / pierna. */
  stepWidth: number;
  /** Momento del ciclo (0–1) en que el brazo ipsi está más adelantado. */
  armPeak: number;
  /** Altura mínima de la base de los dedos en la mitad del vuelo / pierna. */
  toeClearance: number;
}

export interface GaitAnalysis {
  scalars: GaitScalars;
  /** Curvas medias del ciclo. */
  curves: Record<CurveName, number[]>;
  /** Desviación típica entre ciclos de cada punto de las curvas. */
  spread: Record<CurveName, number[]>;
  cycles: number;
}

const UP = new Vector3(0, 1, 0);
const G = 9.81;
const DEGREES = 180 / Math.PI;
const SIDES: readonly Side[] = ['left', 'right'];

const horizontal = (v: Vector3): Vector3 => new Vector3(v.x, 0, v.z);
const angleBetween = (a: Vector3, b: Vector3): number => a.angleTo(b) * DEGREES;
/** Ángulo de `v` en el plano sagital (adelante/arriba), medido desde la vertical hacia abajo; + adelante. */
const sagittal = (v: Vector3, fwd: Vector3): number => Math.atan2(v.dot(fwd), -v.dot(UP)) * DEGREES;

function smooth(values: number[], radius: number): number[] {
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      sum += values[j];
      n++;
    }
    return sum / n;
  });
}

/** Índices de máximos locales en una ventana de ±`radius` frames. */
function peaks(values: number[], radius: number): number[] {
  const out: number[] = [];
  for (let i = radius; i < values.length - radius; i++) {
    let best = true;
    for (let j = i - radius; j <= i + radius && best; j++) if (values[j] > values[i]) best = false;
    if (best && (out.length === 0 || i - out[out.length - 1] > radius)) out.push(i);
  }
  return out;
}

/** Remuestrea `values[a..b]` a SAMPLES puntos (interpolación lineal). */
function resample(values: number[], a: number, b: number): number[] {
  return Array.from({ length: SAMPLES }, (_, k) => {
    const x = a + ((b - a) * k) / (SAMPLES - 1);
    const i = Math.min(Math.floor(x), values.length - 2);
    const t = x - i;
    return values[i] * (1 - t) + values[i + 1] * t;
  });
}

/** Quita la tendencia lineal de una curva de ciclo (lo que avanza o deriva el cuerpo en un ciclo) y su media. */
function detrend(curve: number[]): number[] {
  const n = curve.length - 1;
  const line = (k: number): number => curve[0] + ((curve[n] - curve[0]) * k) / n;
  const flat = curve.map((v, k) => v - line(k));
  const mean = flat.reduce((s, v) => s + v, 0) / curve.length;
  return flat.map((v) => v - mean);
}

/** Ángulo en (−180, 180]. */
const wrapDegrees = (a: number): number => ((((a + 180) % 360) + 360) % 360) - 180;
const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / Math.max(xs.length, 1);
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

/**
 * Analiza un tramo de marcha en línea recta (o casi). `from`/`to`: tramo a usar (s), para dejar
 * fuera el arranque y la frenada.
 */
export function analyzeGait(series: LandmarkSeries, from = 0, to = Number.POSITIVE_INFINITY): GaitAnalysis {
  const { dt, legLength: L, rest } = series;
  const first = Math.max(0, Math.round(from / dt));
  const frames = series.frames.slice(first, Math.min(series.frames.length, Math.round(to / dt)));
  const n = frames.length;
  const radius = Math.max(1, Math.round(0.1 / dt));

  // Dirección de avance: velocidad horizontal de la pelvis, suavizada (±0,25 s).
  const window = Math.max(1, Math.round(0.25 / dt));
  const forward = frames.map((_, i) => {
    const a = frames[Math.max(0, i - window)].pelvis;
    const b = frames[Math.min(n - 1, i + window)].pelvis;
    const v = horizontal(b.clone().sub(a));
    return v.lengthSq() > 1e-12 ? v.normalize() : new Vector3(0, 0, -1);
  });
  const right = forward.map((f) => new Vector3().crossVectors(f, UP));
  const speeds = frames.slice(1).map((f, i) => horizontal(f.pelvis.clone().sub(frames[i].pelvis)).length() / dt);
  const speed = mean(speeds);

  // Eventos de cada pie.
  const ahead = (point: (f: Landmarks) => Vector3) =>
    smooth(frames.map((f, i) => point(f).clone().sub(f.pelvis).dot(forward[i])), radius);
  const events = Object.fromEntries(
    SIDES.map((side) => {
      const heel = ahead((f) => f.ankle[side]);
      const toe = ahead((f) => f.toe[side]);
      return [side, { strikes: peaks(heel, radius * 2), offs: peaks(toe.map((v) => -v), radius * 2) }];
    }),
  ) as Record<Side, { strikes: number[]; offs: number[] }>;

  // Ángulos de reposo (dependen de cómo está construido cada esqueleto).
  const restAnkle = (side: Side): number =>
    angleBetween(rest.ankle[side].clone().sub(rest.knee[side]), rest.toe[side].clone().sub(rest.ankle[side]));
  const restPitch = (side: Side): number => {
    const f = rest.toe[side].clone().sub(rest.ankle[side]);
    return Math.atan2(f.y, horizontal(f).length()) * DEGREES;
  };
  // Tronco y cuello: inclinación de reposo hacia donde apuntan los pies en reposo.
  const restForward = horizontal(
    rest.toe.left.clone().sub(rest.ankle.left).add(rest.toe.right).sub(rest.ankle.right),
  ).normalize();
  const pitchOf = (v: Vector3, fwd: Vector3): number => Math.atan2(v.dot(fwd), v.y) * DEGREES;
  const restTrunk = pitchOf(rest.chest.clone().sub(rest.pelvis), restForward);
  const restNeck = pitchOf(rest.head.clone().sub(rest.chest), restForward);
  const restPelvis = rest.hip.left.clone().add(rest.hip.right).multiplyScalar(0.5).sub(rest.pelvis);
  const restPelvisPitch = Math.atan2(restPelvis.dot(restForward), restPelvis.y) * DEGREES;
  const pelvisMeasurable = restPelvis.length() > 0.02 * L;
  const minToe = Object.fromEntries(SIDES.map((s) => [s, Math.min(...frames.map((f) => f.toe[s].y))])) as Record<Side, number>;
  const minAnkle = Object.fromEntries(SIDES.map((s) => [s, Math.min(...frames.map((f) => f.ankle[s].y))])) as Record<Side, number>;

  // Señales por frame, por lado (ipsi = `side`).
  const signal = (side: Side): Record<CurveName, number[]> => {
    const other: Side = side === 'left' ? 'right' : 'left';
    const lateral = side === 'right' ? 1 : -1;
    // Ángulo de la línea contralateral → ipsi en el plano horizontal: + si el lado ipsi va adelante.
    const yawOf = (a: Vector3, b: Vector3, i: number): number => {
      const v = a.clone().sub(b);
      return Math.atan2(v.dot(forward[i]), v.dot(right[i]) * lateral) * DEGREES;
    };
    const rollOf = (a: Vector3, b: Vector3): number => {
      const v = a.clone().sub(b);
      return Math.atan2(v.y, horizontal(v).length()) * DEGREES;
    };
    const out = Object.fromEntries(CURVE_NAMES.map((c) => [c, [] as number[]])) as Record<CurveName, number[]>;
    frames.forEach((f, i) => {
      const fwd = forward[i];
      const thigh = f.knee[side].clone().sub(f.hip[side]);
      const shank = f.ankle[side].clone().sub(f.knee[side]);
      const foot = f.toe[side].clone().sub(f.ankle[side]);
      const upperArm = f.elbow[side].clone().sub(f.shoulder[side]);
      const forearm = f.wrist[side].clone().sub(f.elbow[side]);
      const trunk = f.chest.clone().sub(f.pelvis);
      out.thigh.push(sagittal(thigh, fwd));
      out.knee.push(angleBetween(thigh, shank));
      out.ankle.push(angleBetween(shank, foot) - restAnkle(side));
      out.footPitch.push(Math.atan2(foot.y, horizontal(foot).length()) * DEGREES - restPitch(side));
      out.toeHeight.push((f.toe[side].y - minToe[side]) / L);
      out.ankleHeight.push((f.ankle[side].y - minAnkle[side]) / L);
      out.ankleAhead.push(f.ankle[side].clone().sub(f.hip[side]).dot(fwd) / L);
      out.hipHeight.push((f.hip[side].y - f.ankle[side].y) / L);
      out.pelvisY.push(f.pelvis.y / L);
      out.pelvisX.push(0); // se calcula por ciclo, con la dirección del inicio del ciclo
      out.pelvisYaw.push(yawOf(f.hip[side], f.hip[other], i));
      out.pelvisRoll.push(rollOf(f.hip[side], f.hip[other]));
      out.trunkYaw.push(yawOf(f.shoulder[side], f.shoulder[other], i) - yawOf(f.hip[side], f.hip[other], i));
      out.trunkPitch.push(pitchOf(trunk, fwd) - restTrunk);
      out.arm.push(sagittal(upperArm, fwd));
      out.elbow.push(angleBetween(upperArm, forearm));
      const neck = f.head.clone().sub(f.chest);
      out.neckPitch.push(pitchOf(neck, fwd) - restNeck);
      // Pelvis: el vector de su centro al punto medio de las caderas (rígido con ella, hacia arriba o
      // hacia abajo según el esqueleto), en el plano sagital y respecto al reposo.
      const pelvis = f.hip.left.clone().add(f.hip.right).multiplyScalar(0.5).sub(f.pelvis);
      // Si las caderas están a la altura del centro (SFU), el vector es nulo y no se puede medir: 0.
      out.pelvisPitch.push(pelvisMeasurable ? wrapDegrees(Math.atan2(pelvis.dot(fwd), pelvis.y) * DEGREES - restPelvisPitch) : 0);
      out.shoulderRoll.push(rollOf(f.shoulder[side], f.shoulder[other]));
      // Plano frontal: ángulo desde la vertical hacia fuera del lado ipsi.
      const out_ = right[i].clone().multiplyScalar(lateral);
      const frontal = (v: Vector3): number => Math.atan2(v.dot(out_), -v.y) * DEGREES;
      out.armCross.push(frontal(upperArm));
      out.forearmCross.push(frontal(forearm));
      // Con la palma hacia el muslo, en el plano frontal la muñeca se flexiona y extiende; en el
      // sagital se desvía (hacia el pulgar o el meñique).
      const hand = f.hand[side].clone().sub(f.wrist[side]);
      out.wristFrontal.push(frontal(hand) - frontal(forearm));
      out.wristSagittal.push(sagittal(hand, fwd) - sagittal(forearm, fwd));
    });
    return out;
  };

  const DETRENDED: CurveName[] = ['pelvisY', 'pelvisX', 'pelvisPitch', 'shoulderRoll', 'armCross', 'forearmCross', 'wristFrontal', 'wristSagittal'];
  const cycles: Record<CurveName, number[]>[] = [];
  const stance: number[] = [];
  const doubleSupport: number[] = [];
  const armPeak: number[] = [];
  const clearance: number[] = [];
  const widths: number[] = [];
  const durations: number[] = [];

  for (const side of SIDES) {
    const other: Side = side === 'left' ? 'right' : 'left';
    const s = signal(side);
    const { strikes, offs } = events[side];
    const typical = median(strikes.slice(1).map((v, i) => v - strikes[i]));
    for (let k = 0; k + 1 < strikes.length; k++) {
      const a = strikes[k];
      const b = strikes[k + 1];
      if (b - a < 0.7 * typical || b - a > 1.3 * typical) continue;
      const off = offs.find((o) => o > a && o < b);
      const otherStrike = events[other].strikes.find((o) => o > a && o < b);
      const otherOff = events[other].offs.find((o) => o > a && o < b);
      if (off === undefined || otherStrike === undefined || otherOff === undefined) continue;

      // Lateral: respecto a la pelvis y la dirección al inicio del ciclo (lejos del origen, una
      // pequeña variación del rumbo daría desplazamientos enormes).
      const lateral = side === 'right' ? 1 : -1;
      for (let i = a; i <= b; i++) s.pelvisX[i] = (frames[i].pelvis.clone().sub(frames[a].pelvis).dot(right[a]) * lateral) / L;
      const cycle = Object.fromEntries(
        CURVE_NAMES.map((c) => [c, DETRENDED.includes(c) ? detrend(resample(s[c], a, b)) : resample(s[c], a, b)]),
      ) as Record<CurveName, number[]>;
      cycles.push(cycle);
      durations.push((b - a) * dt);
      stance.push((off - a) / (b - a));
      doubleSupport.push((otherOff - a + (off - otherStrike)) / (b - a));
      armPeak.push(cycle.arm.indexOf(Math.max(...cycle.arm)) / (SAMPLES - 1));
      // Holgura: mínimo de la punta entre la flexión máxima de rodilla y el siguiente apoyo.
      const kneeMax = cycle.knee.indexOf(Math.max(...cycle.knee.slice(Math.floor(SAMPLES / 2))));
      clearance.push(Math.min(...cycle.toeHeight.slice(kneeMax, SAMPLES - 3)));
      const ankleA = frames[a].ankle[side];
      const ankleB = frames[otherStrike].ankle[other];
      widths.push(Math.abs(ankleA.clone().sub(ankleB).dot(right[a])) / L);
    }
  }

  const curves = {} as Record<CurveName, number[]>;
  const spread = {} as Record<CurveName, number[]>;
  for (const c of CURVE_NAMES) {
    curves[c] = Array.from({ length: SAMPLES }, (_, k) => mean(cycles.map((cy) => cy[c][k])));
    spread[c] = Array.from({ length: SAMPLES }, (_, k) =>
      Math.sqrt(mean(cycles.map((cy) => (cy[c][k] - curves[c][k]) ** 2))),
    );
  }
  const strideTime = mean(durations);
  return {
    scalars: {
      speed,
      froude: (speed * speed) / (G * L),
      cadence: 120 / strideTime,
      strideLength: (speed * strideTime) / L,
      stance: mean(stance),
      doubleSupport: mean(doubleSupport),
      stepWidth: mean(widths),
      armPeak: mean(armPeak),
      toeClearance: mean(clearance),
    },
    curves,
    spread,
    cycles: cycles.length,
  };
}

/**
 * Tramos de marcha casi recta de una toma (s): la pelvis avanza a más de 0,4 m/s y su rumbo gira
 * menos de `maxTurn` °/s durante al menos `minLength` s (un ciclo y medio). Se recortan `trim` s en
 * cada punta: al llegar a una vuelta la pelvis empieza a girar antes que la trayectoria. Para tomas
 * que dan vueltas (SFU); `analyzeGait` supone una línea recta.
 */
export function straightStretches(series: LandmarkSeries, maxTurn = 12, minLength = 2, trim = 0.5): [number, number][] {
  const { dt, frames } = series;
  const w = Math.round(0.5 / dt);
  const heading: number[] = [];
  const speed: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const a = frames[Math.max(0, i - w)].pelvis;
    const b = frames[Math.min(frames.length - 1, i + w)].pelvis;
    const v = horizontal(b.clone().sub(a));
    heading.push(Math.atan2(v.x, v.z));
    speed.push(v.length() / (Math.min(frames.length - 1, i + w) - Math.max(0, i - w)) / dt);
  }
  const stretches: [number, number][] = [];
  let start = -1;
  for (let i = w; i <= frames.length - w; i++) {
    const turn = i < frames.length - w ? Math.abs(Math.atan2(Math.sin(heading[i + w] - heading[i - w]), Math.cos(heading[i + w] - heading[i - w]))) / (2 * w * dt) : Infinity;
    const ok = speed[i] > 0.4 && turn * DEGREES < maxTurn;
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) {
      const [from, to] = [start * dt + trim, i * dt - trim];
      if (to - from >= minLength) stretches.push([from, to]);
      start = -1;
    }
  }
  return stretches;
}
