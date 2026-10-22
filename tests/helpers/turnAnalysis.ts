import type { Vector3 } from 'three';

import type { LandmarkSeries } from './gaitAnalysis.ts';

/**
 * Análisis de vueltas a partir de los puntos del cuerpo (igual para mocap y para la librería): por
 * vuelta, ángulo, duración (del 10 al 90 % del giro), pasos que aterrizan durante el giro, giro de
 * cada paso (orientación del pie entre aterrizajes), cuánto pivota el pie apoyado, velocidad mínima,
 * cuánto se aparta la pelvis de la línea por la que llegaba, adelanto del pecho y velocidad de giro.
 */

const DEG = 180 / Math.PI;
const SIDES = ['left', 'right'] as const;

export interface Turn {
  angle: number;
  duration: number;
  steps: number;
  /** Giro medio de cada paso (°). */
  stepTurn: number;
  /** Lo máximo que gira un pie mientras está apoyado (°). */
  pivot: number;
  minSpeed: number;
  /** Separación máxima de la pelvis respecto a la línea de llegada (m). */
  lateral: number;
  /** Adelanto del pecho respecto a la pelvis al llegar a la mitad del giro (s). */
  chestLead: number;
  /** Velocidad de giro máxima de la pelvis (°/s). */
  peakRate: number;
}

/** Ángulo horizontal (rad) de la normal hacia delante de la línea izquierda → derecha. */
const facingOf = (left: Vector3, right: Vector3): number => {
  const d = left.clone().sub(right);
  return Math.atan2(-d.z, d.x);
};

function unwrap(angles: number[]): number[] {
  const out = [angles[0]];
  for (let i = 1; i < angles.length; i++) {
    const d = angles[i] - angles[i - 1];
    out.push(out[i - 1] + Math.atan2(Math.sin(d), Math.cos(d)));
  }
  return out;
}

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

/** Vueltas de más de `minAngle` grados en una toma: tramos en que la pelvis gira a más de 25 °/s. */
export function analyzeTurns(series: LandmarkSeries, minAngle = 60): Turn[] {
  const { frames, dt } = series;
  const n = frames.length;
  const r = Math.max(1, Math.round(0.08 / dt));
  const pelvis = smooth(unwrap(frames.map((f) => facingOf(f.hip.left, f.hip.right))), r);
  const chest = smooth(unwrap(frames.map((f) => facingOf(f.shoulder.left, f.shoulder.right))), r);
  const rate = pelvis.map((_, i) => (pelvis[Math.min(n - 1, i + 1)] - pelvis[Math.max(0, i - 1)]) / (2 * dt));
  const speed = frames.map((_, i) => {
    const a = frames[Math.max(0, i - r)].pelvis;
    const b = frames[Math.min(n - 1, i + r)].pelvis;
    return Math.hypot(b.x - a.x, b.z - a.z) / ((Math.min(n - 1, i + r) - Math.max(0, i - r)) * dt);
  });
  // Aterrizajes y orientación de cada pie.
  const footYaw = Object.fromEntries(
    SIDES.map((s) => [s, unwrap(frames.map((f) => {
      const d = f.toe[s].clone().sub(f.ankle[s]);
      return Math.atan2(d.x, d.z);
    }))]),
  ) as Record<(typeof SIDES)[number], number[]>;
  const planted = Object.fromEntries(
    SIDES.map((s) => [s, frames.map((_, i) => {
      const a = frames[Math.max(0, i - r)].ankle[s];
      const b = frames[Math.min(n - 1, i + r)].ankle[s];
      return Math.hypot(b.x - a.x, b.z - a.z) / ((Math.min(n - 1, i + r) - Math.max(0, i - r)) * dt) < 0.25;
    })]),
  ) as Record<(typeof SIDES)[number], boolean[]>;

  // Tramos girando (con huecos de menos de 0,4 s unidos).
  const segments: [number, number][] = [];
  let start = -1;
  let lastTurning = -1;
  for (let i = 0; i < n; i++) {
    if (Math.abs(rate[i]) * DEG > 25) {
      if (start < 0) start = i;
      lastTurning = i;
    } else if (start >= 0 && (i - lastTurning) * dt > 0.4) {
      segments.push([start, lastTurning]);
      start = -1;
    }
  }
  if (start >= 0) segments.push([start, lastTurning]);

  const turns: Turn[] = [];
  for (const [a, b] of segments) {
    const total = pelvis[b] - pelvis[a];
    if (Math.abs(total) * DEG < minAngle) continue;
    const at = (series: number[], fraction: number): number => {
      for (let i = a; i <= b; i++) if ((series[i] - pelvis[a]) / total >= fraction) return i;
      return b;
    };
    const s0 = at(pelvis, 0.1);
    const s1 = at(pelvis, 0.9);
    const approachFrom = frames[Math.max(0, a - Math.round(1 / dt))].pelvis;
    const approach = frames[a].pelvis.clone().sub(approachFrom).setY(0);
    if (approach.lengthSq() < 1e-6) approach.set(Math.sin(pelvis[a]), 0, Math.cos(pelvis[a]));
    approach.normalize();
    let lateral = 0;
    let minSpeed = Infinity;
    for (let i = a; i <= b; i++) {
      const d = frames[i].pelvis.clone().sub(frames[a].pelvis);
      lateral = Math.max(lateral, Math.abs(d.x * approach.z - d.z * approach.x));
      minSpeed = Math.min(minSpeed, speed[i]);
    }
    // Pasos: aterrizajes entre el 10 y el 90 % del giro (y un poco después, para el que lo termina).
    let steps = 0;
    const stepTurns: number[] = [];
    let pivot = 0;
    for (const s of SIDES) {
      let lastLanding = -1;
      for (let i = Math.max(1, a - Math.round(0.6 / dt)); i <= Math.min(n - 1, b + Math.round(0.3 / dt)); i++) {
        if (planted[s][i] && !planted[s][i - 1]) {
          if (i >= s0 && i <= s1 + Math.round(0.3 / dt)) {
            steps++;
            if (lastLanding >= 0) stepTurns.push(Math.abs(footYaw[s][i] - footYaw[s][lastLanding]) * DEG);
          }
          lastLanding = i;
        }
      }
      // Pivote: giro del pie mientras sigue apoyado, dentro del giro.
      let from = -1;
      for (let i = a; i <= b + 1 && i < n; i++) {
        if (planted[s][i] && from < 0) from = i;
        if ((!planted[s][i] || i === b + 1 || i === n - 1) && from >= 0) {
          pivot = Math.max(pivot, Math.abs(footYaw[s][i - 1] - footYaw[s][from]) * DEG);
          from = -1;
        }
      }
    }
    const chestMid = (() => {
      for (let i = a; i <= b; i++) if ((chest[i] - chest[a]) / total >= 0.5) return i;
      return b;
    })();
    turns.push({
      angle: Math.abs(total) * DEG,
      duration: (s1 - s0) * dt,
      steps,
      stepTurn: stepTurns.length ? stepTurns.reduce((x, y) => x + y, 0) / stepTurns.length : 0,
      pivot,
      minSpeed,
      lateral,
      chestLead: (at(pelvis, 0.5) - chestMid) * dt,
      peakRate: Math.max(...rate.slice(a, b + 1).map((w) => Math.abs(w))) * DEG,
    });
  }
  return turns;
}
