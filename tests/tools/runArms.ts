import { Vector3 } from 'three';

import type { Landmarks, LandmarkSeries } from '../helpers/gaitAnalysis.ts';
import { analyzeHumanGait } from '../helpers/humanLandmarks.ts';
import { loadMocap } from '../helpers/mocap.ts';

// Braceo al trotar y correr: mocap (CMU 35_17, 35_18, trote) frente a la librería.
//   node .test-build/tests/tools/runArms.js [velocidades m/s separadas por comas]
const DEG = 180 / Math.PI;
const UP = new Vector3(0, 1, 0);

interface Sample { arm: number; elbow: number; ahead: number; below: number; inward: number; forearm: number }

function measure(series: LandmarkSeries, from = 0.1, to = 0.9): { speed: number; samples: Sample[]; lag: number } {
  const f = series.frames.slice(Math.round(series.frames.length * from), Math.round(series.frames.length * to));
  const L = series.legLength;
  const fwd = f[f.length - 1].pelvis.clone().sub(f[0].pelvis).setY(0);
  const speed = fwd.length() / (series.dt * (f.length - 1));
  fwd.normalize();
  const right = new Vector3().crossVectors(fwd, UP);
  const samples: Sample[] = [];
  const armR: number[] = [];
  const legs: number[] = [];
  // Dirección de avance de cada momento (la de la pelvis en ±0,25 s): la toma puede no ir en línea recta.
  const span = Math.round(0.25 / series.dt);
  const all = series.frames;
  const offset = Math.round(series.frames.length * from);
  for (const [i, frame] of f.entries()) {
    const j = i + offset;
    fwd.copy(all[Math.min(j + span, all.length - 1)].pelvis).sub(all[Math.max(j - span, 0)].pelvis).setY(0).normalize();
    right.crossVectors(fwd, UP);
    for (const side of ['left', 'right'] as const) {
      const out = side === 'right' ? right : right.clone().negate();
      const s = frame.shoulder[side], e = frame.elbow[side], w = frame.wrist[side];
      const upper = e.clone().sub(s);
      const lower = w.clone().sub(e);
      const arm = Math.atan2(upper.dot(fwd), -upper.y) * DEG;
      if (side === 'right') armR.push(arm);
      samples.push({
        arm,
        elbow: upper.angleTo(lower) * DEG,
        ahead: w.clone().sub(s).dot(fwd) / L,
        below: -w.clone().sub(s).y / L,
        inward: -w.clone().sub(s).dot(out) / L,
        // Antebrazo respecto a la vertical, en el plano sagital (+ = la mano por delante del codo).
        forearm: Math.atan2(lower.dot(fwd), -lower.y) * DEG,
      });
    }
    legs.push(frame.ankle.left.clone().sub(frame.ankle.right).dot(fwd));
  }
  return { speed, samples, lag: lagOf(armR, legs, series.dt) };
}

/** Retraso (s) del brazo derecho respecto a la pierna izquierda (máximo de la correlación cruzada). */
function lagOf(a: number[], b: number[], dt: number): number {
  const mean = (x: number[]): number => x.reduce((s, v) => s + v, 0) / x.length;
  const ma = mean(a), mb = mean(b);
  let best = -Infinity, bestLag = 0;
  for (let k = -Math.round(0.3 / dt); k <= Math.round(0.3 / dt); k++) {
    let sum = 0;
    for (let i = Math.max(0, -k); i < a.length && i + k < b.length; i++) if (i + k >= 0) sum += (a[i + k] - ma) * (b[i] - mb);
    if (sum > best) { best = sum; bestLag = k; }
  }
  return bestLag * dt;
}

function report(label: string, m: { speed: number; samples: Sample[]; lag: number }): void {
  const s = m.samples;
  const stat = (k: keyof Sample): string => {
    const v = s.map((x) => x[k]).sort((a, b) => a - b);
    const q = (p: number): number => v[Math.min(v.length - 1, Math.floor(p * v.length))];
    return `${q(0.02).toFixed(k === 'arm' || k === 'elbow' || k === 'forearm' ? 0 : 2).padStart(6)} … ${q(0.98).toFixed(k === 'arm' || k === 'elbow' || k === 'forearm' ? 0 : 2).padStart(6)}`;
  };
  console.log(`\n${label}  (${m.speed.toFixed(2)} m/s, brazo detrás de la pierna ${(m.lag * 1000).toFixed(0)} ms)`);
  console.log(`  brazo° ${stat('arm')}   codo° ${stat('elbow')}   antebrazo° ${stat('forearm')}`);
  console.log(`  muñeca: adelante ${stat('ahead')}  bajo el hombro ${stat('below')}  hacia dentro ${stat('inward')}  (/pierna)`);
  // Por ángulo del brazo: cómo está el codo y dónde va la mano en cada punto del balanceo.
  const bins = new Map<number, Sample & { n: number }>();
  for (const x of s) {
    const k = Math.round(x.arm / 10) * 10;
    const b = bins.get(k) ?? { arm: 0, elbow: 0, ahead: 0, below: 0, inward: 0, forearm: 0, n: 0 };
    for (const key of ['elbow', 'ahead', 'below', 'inward', 'forearm'] as const) b[key] += x[key];
    b.n++;
    bins.set(k, b);
  }
  console.log('   brazo°   codo°  antebrazo°  adelante  bajo  dentro  frames');
  for (const [k, b] of [...bins].sort((a, c) => a[0] - c[0])) {
    if (b.n < s.length * 0.02) continue;
    console.log(`  ${String(k).padStart(6)} ${(b.elbow / b.n).toFixed(0).padStart(7)} ${(b.forearm / b.n).toFixed(0).padStart(10)} ${(b.ahead / b.n).toFixed(2).padStart(9)} ${(b.below / b.n).toFixed(2).padStart(5)} ${(b.inward / b.n).toFixed(2).padStart(7)} ${String(b.n).padStart(7)}`);
  }
}

if (!process.env.ONLYLIB) {
  for (const id of ['35_17', '35_18']) report(`CMU ${id} (trote)`, measure(loadMocap('recursos/mocap-cmu/35.asf', `recursos/mocap-cmu/${id}.amc`)));
}
const speeds = (process.argv[2] ?? '2.4,3').split(',').map(Number);
for (const v of speeds) {
  const { series } = analyzeHumanGait(v, {}, 6);
  report(`librería a ${v} m/s`, measure(series, 0, 1));
}
export type { Landmarks };
