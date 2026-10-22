import { existsSync } from 'node:fs';

import { Vector3 } from 'three';

import { loadBvh } from '../helpers/bvh.ts';
import type { LandmarkSeries } from '../helpers/gaitAnalysis.ts';
import { humanLandmarks } from '../helpers/humanLandmarks.ts';
import { analyzeTurns, type Turn } from '../helpers/turnAnalysis.ts';
import { loadMocap } from '../helpers/mocap.ts';
import { createWorld, simulate } from '../helpers/sim.ts';

/**
 * Vueltas: cómo gira una persona (CMU, SFU) y cómo gira la librería con moveTo hacia un destino detrás,
 * medido igual en los dos (tests/helpers/turnAnalysis.ts).
 *
 *   node scripts/run-tests.mjs zzz && node .test-build/tests/tools/turnReport.js
 */

/** La librería: desde parada o caminando, moveTo hacia un destino detrás (a `back` m). */
function library(back: number, walking: boolean): LandmarkSeries {
  const world = createWorld();
  const human = world.human;
  const dt = 1 / 120;
  human.restPose();
  const rest = humanLandmarks(human);
  human.reset();
  const frames = [humanLandmarks(human)];
  const script: [number, (h: typeof human) => void][] = walking
    ? [[0, (h) => { h.targetSpeed = 1.4; }], [3, (h) => h.moveTo(h.position.clone().add(new Vector3(0, 0, back)))]]
    : [[0.5, (h) => h.moveTo(new Vector3(0, 0, back))]];
  simulate(world, walking ? 11 : 8, script, { dt, onFrame: () => frames.push(humanLandmarks(human)) });
  return { dt, legLength: human.legLength, rest, frames };
}

const fmt = (label: string, t: Turn): string =>
  `| ${label} | ${t.angle.toFixed(0)}° | ${t.duration.toFixed(2)} s | ${t.steps} | ${t.stepTurn.toFixed(0)}° | ${t.pivot.toFixed(0)}° | ${t.minSpeed.toFixed(2)} m/s | ${(t.lateral * 100).toFixed(0)} cm | ${t.chestLead.toFixed(2)} s | ${t.peakRate.toFixed(0)}°/s |`;

console.log('| toma | giro | duración | pasos | giro por paso | pivote del pie | vel. mín. | se aparta | pecho adelantado | giro máx. |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
const CMU: [string, string][] = [
  ['36_02', 'ida, vuelta y regreso'], ['36_03', 'ida, vuelta y regreso'], ['36_09', 'ida, vuelta y regreso'],
  ['39_11', 'ida, vuelta y regreso'], ['47_01', 'ida, vuelta y regreso'],
  ['69_06', 'caminar y girar'], ['69_07', 'caminar y girar'], ['69_08', 'caminar y girar'], ['69_13', 'caminar y girar en el sitio'],
  ['16_17', 'giro de 90°'],
];
const big: Turn[] = [];
for (const [id, what] of CMU) {
  const subject = id.split('_')[0];
  const asf = `recursos/mocap-cmu/${subject}.asf`;
  if (!existsSync(asf) || !existsSync(`recursos/mocap-cmu/${id}.amc`)) continue;
  for (const t of analyzeTurns(loadMocap(asf, `recursos/mocap-cmu/${id}.amc`))) {
    console.log(fmt(`CMU ${id} (${what})`, t));
    if (t.angle > 150) big.push(t);
  }
}
for (const id of ['0018_Walking001', '0018_Catwalk001', '0018_TipToe001']) {
  const path = `recursos/mocap-sfu/${id}.bvh`;
  if (existsSync(path)) for (const t of analyzeTurns(loadBvh(path))) console.log(fmt(`SFU ${id}`, t));
}
if (big.length) {
  const mean = (k: keyof Turn): number => big.reduce((s, t) => s + t[k], 0) / big.length;
  console.log(`| **CMU, media de ${big.length} vueltas de más de 150°** | ${mean('angle').toFixed(0)}° | ${mean('duration').toFixed(2)} s | ${mean('steps').toFixed(1)} | ${mean('stepTurn').toFixed(0)}° | ${mean('pivot').toFixed(0)}° | ${mean('minSpeed').toFixed(2)} m/s | ${(mean('lateral') * 100).toFixed(0)} cm | ${mean('chestLead').toFixed(2)} s | ${mean('peakRate').toFixed(0)}°/s |`);
}
for (const [back, walking] of [[3, false], [6, false], [4, true]] as [number, boolean][]) {
  for (const t of analyzeTurns(library(back, walking))) console.log(fmt(`librería: ${walking ? 'caminando, destino 4 m detrás' : `parada, destino ${back} m detrás`}`, t));
}
