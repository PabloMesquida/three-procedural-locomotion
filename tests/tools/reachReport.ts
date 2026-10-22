import type { Landmarks } from '../helpers/gaitAnalysis.ts';
import { loadMocap } from '../helpers/mocap.ts';

/**
 * Alcances en el mocap de CMU (tocar, alcanzar o empujar algo con la mano): cómo se acerca la mano.
 *
 * Divide el movimiento de cada muñeca (respecto a la pelvis) en unidades: de quieta a quieta, con la
 * velocidad por encima del 12 % de su máximo. Un alcance es una unidad que sale del brazo colgando y acaba
 * lejos de él. De cada uno: duración, velocidad máxima y cuándo llega a ella (0,5 = campana simétrica,
 * como el minimum jerk), cuánto se dobla el brazo a mitad (distancia hombro–muñeca mínima / brazo) y cuánto
 * al final, codo final, altura del objetivo respecto al hombro, cuánto se curva el recorrido y cuánto
 * acompaña el tronco (pecho respecto a la pelvis, hacia la mano).
 *
 *   node scripts/run-tests.mjs zzz && node .test-build/tests/tools/reachReport.js [toma…]   (RETURN=1: la vuelta a colgar)
 */
const TAKES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['144_22', '144_23', '144_24', '144_25', '13_10', '13_12', '14_07', '14_08', '14_09', '81_10', '22_18'];
const DEG = 180 / Math.PI;
const sides = ['left', 'right'] as const;
type Side = (typeof sides)[number];

const all: number[][] = [];
for (const id of TAKES) {
  const series = loadMocap(`recursos/mocap-cmu/${id.split('_')[0]}.asf`, `recursos/mocap-cmu/${id}.amc`);
  const { frames, dt } = series;
  const n = frames.length;
  for (const side of sides) {
    const arm = armLength(frames[0], side);
    const rel = (k: number) => frames[k].wrist[side].clone().sub(frames[k].pelvis);
    const raw = frames.map((_, i) => rel(Math.min(i + 1, n - 1)).sub(rel(Math.max(i - 1, 0))).length() / (2 * dt));
    // Media móvil de 50 ms (el mocap tiene algo de ruido de marcadores).
    const speed = raw.map((_, i) => {
      let s = 0, c = 0;
      for (let k = Math.max(i - 3, 0); k <= Math.min(i + 3, n - 1); k++) { s += raw[k]; c++; }
      return s / c;
    });
    let i = 0;
    while (i < n) {
      if (speed[i] < 0.5) { i++; continue; }
      // Unidad: alrededor de este tramo rápido, hasta que la velocidad baja al 12 % del máximo.
      let peak = i;
      let j = i;
      while (j < n && speed[j] >= 0.5) { if (speed[j] > speed[peak]) peak = j; j++; }
      const limit = 0.12 * speed[peak];
      let start = peak;
      while (start > 0 && speed[start] > limit) start--;
      let stop = peak;
      while (stop < n - 1 && speed[stop] > limit) stop++;
      i = stop + 1;
      const f0 = frames[start];
      const f1 = frames[stop];
      const reach = (f: Landmarks) => f.wrist[side].distanceTo(f.shoulder[side]) / arm;
      const height = (f: Landmarks) => (f.wrist[side].y - f.shoulder[side].y) / arm;
      // Sale del brazo colgando (muñeca > 0,75 brazos por debajo del hombro) y acaba arriba o lejos; con
      // RETURN=1, al revés: la vuelta a colgar.
      const back = process.env.RETURN === '1';
      if (back ? height(f1) > -0.75 || height(f0) < -0.6 : height(f0) > -0.75 || height(f1) < -0.6) continue;
      const p0 = rel(start);
      const line = rel(stop).sub(p0);
      if (line.length() < 0.3 * arm) continue;
      let bulge = 0;
      let minReach = Infinity;
      for (let k = start; k <= stop; k++) {
        const p = rel(k).sub(p0);
        const along = p.dot(line) / line.lengthSq();
        bulge = Math.max(bulge, p.addScaledVector(line, -along).length());
        minReach = Math.min(minReach, reach(frames[k]));
      }
      const toward = f1.wrist[side].clone().sub(f1.shoulder[side]).setY(0).normalize();
      const chest = (f: Landmarks) => f.chest.clone().sub(f.pelvis).dot(toward);
      const elbow = 180 - f1.elbow[side].clone().sub(f1.shoulder[side]).angleTo(f1.wrist[side].clone().sub(f1.elbow[side])) * DEG;
      const row = [(stop - start) * dt, speed[peak] / arm, (peak - start) / (stop - start), minReach, reach(f1), elbow, height(f1), bulge / line.length(), (chest(f1) - chest(f0)) / arm];
      all.push(row);
      console.log(
        `${id.padEnd(6)} ${side.padEnd(5)} ${(start * dt).toFixed(2).padStart(6)} s  dura ${row[0].toFixed(2)} s  ` +
          `v máx ${row[1].toFixed(2)} brazos/s a ${row[2].toFixed(2)}  brazo mín ${row[3].toFixed(2)} → final ${row[4].toFixed(2)}  ` +
          `codo ${row[5].toFixed(0)}°  altura ${row[6].toFixed(2)}  curva ${row[7].toFixed(2)}  tronco ${(row[8] * 100).toFixed(1)} % brazo`,
      );
    }
  }
}
if (all.length) {
  const names = ['dura (s)', 'v máx (brazos/s)', 'pico a', 'brazo mín', 'brazo final', 'codo (°)', 'altura', 'curva', 'tronco'];
  console.log(`\n${all.length} alcances — mediana [p10, p90]`);
  names.forEach((name, k) => {
    const v = all.map((r) => r[k]).sort((a, b) => a - b);
    const q = (p: number) => v[Math.min(Math.floor(p * v.length), v.length - 1)];
    console.log(`${name.padEnd(18)} ${q(0.5).toFixed(2)}  [${q(0.1).toFixed(2)}, ${q(0.9).toFixed(2)}]`);
  });
}

/** Hombro → codo → muñeca en la primera pose. */
function armLength(f: Landmarks, side: Side): number {
  return f.shoulder[side].distanceTo(f.elbow[side]) + f.elbow[side].distanceTo(f.wrist[side]);
}
