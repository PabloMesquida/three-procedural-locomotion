import { writeFileSync } from 'node:fs';

import { loadBvh } from '../helpers/bvh.ts';
import { analyzeGait, CURVE_NAMES, type CurveName, type GaitAnalysis, type GaitScalars, straightStretches } from '../helpers/gaitAnalysis.ts';
import { analyzeHumanGait } from '../helpers/humanLandmarks.ts';
import { loadMocap } from '../helpers/mocap.ts';
import { createWorld } from '../helpers/sim.ts';

/**
 * Compara la marcha de la librería con capturas de movimiento de CMU (mocap.cs.cmu.edu), a la misma
 * velocidad relativa (número de Froude). Necesita las tomas en recursos/mocap-cmu/ (no se versionan;
 * ver docs/en/naturalness.md).
 *
 *   npm run mocap                   caminar normal: media de los sujetos 35 y 16 frente a la librería
 *   npm run mocap -- 35_17          una toma (o un tipo: walk, run, style); CURVES=1 añade las curvas
 *   npm run mocap -- referencia     escribe tests/reference/cmu-caminar.json (lo usa el test de naturalidad)
 *   npm run mocap -- sfu            caminar normal en las tomas de SFU (recursos/mocap-sfu/), solo los tramos rectos
 *   npm run mocap -- 0018           una toma de SFU (o un tipo: sfu-walk, sfu-style)
 *
 * SFU solo se usa para medir en local: su licencia no permite uso comercial, así que de sus tomas no
 * se guarda nada en el repo (no hay `referencia` de SFU).
 */

const DIR = 'recursos/mocap-cmu/';
const SFU_DIR = 'recursos/mocap-sfu/';
const REFERENCE = 'tests/reference/cmu-caminar.json';
const G = 9.81;

interface Trial {
  id: string;
  kind: 'walk' | 'run' | 'style';
  label: string;
}

const TRIALS: Trial[] = [
  { id: '35_01', kind: 'walk', label: 'caminar' },
  { id: '35_02', kind: 'walk', label: 'caminar' },
  { id: '35_03', kind: 'walk', label: 'caminar' },
  { id: '16_15', kind: 'walk', label: 'caminar' },
  { id: '07_04', kind: 'walk', label: 'caminar lento' },
  { id: '07_12', kind: 'walk', label: 'caminar rápido' },
  { id: '35_17', kind: 'run', label: 'trotar' },
  { id: '35_18', kind: 'run', label: 'trotar' },
  { id: '17_01', kind: 'style', label: 'enojado' },
  { id: '17_03', kind: 'style', label: 'sigiloso' },
  { id: '17_06', kind: 'style', label: 'alegre' },
  { id: '17_08', kind: 'style', label: 'corpulento' },
];

/** Caminar normal: los sujetos con marcha más típica (el 07 gira mucho la pelvis). */
const NORMAL_WALK = ['35_01', '35_02', '35_03', '16_15'];

function mocap(trial: Trial): GaitAnalysis {
  const subject = trial.id.split('_')[0];
  return analyzeGait(loadMocap(`${DIR}${subject}.asf`, `${DIR}${trial.id}.amc`));
}

interface SfuTrial {
  id: string;
  kind: 'sfu-walk' | 'sfu-style';
  label: string;
}

const SFU_TRIALS: SfuTrial[] = [
  { id: '0005_Walking001', kind: 'sfu-walk', label: 'caminar con curvas' },
  { id: '0007_Walking001', kind: 'sfu-walk', label: 'caminar, toma larga' },
  { id: '0008_Walking001', kind: 'sfu-walk', label: 'caminar en círculos' },
  { id: '0018_Walking001', kind: 'sfu-walk', label: 'rectas con zancada creciente' },
  { id: '0008_Walking002', kind: 'sfu-style', label: 'aire chulesco con poses' },
  { id: '0018_Catwalk001', kind: 'sfu-style', label: 'pasarela' },
  { id: '0018_TipToe001', kind: 'sfu-style', label: 'de puntillas' },
];

/** Caminar normal en SFU (0018_Walking001 cambia de zancada y para: se mira aparte). */
const SFU_NORMAL_WALK = ['0005_Walking001', '0007_Walking001', '0008_Walking001'];

/** Una toma de SFU: media de sus tramos rectos (null si no tiene ninguno con ciclos completos). */
function sfu(trial: SfuTrial): GaitAnalysis | null {
  const series = loadBvh(`${SFU_DIR}${trial.id}.bvh`);
  const parts = straightStretches(series)
    .map(([from, to]) => analyzeGait(series, from, to))
    .filter((a) => a.cycles > 0);
  return parts.length > 0 ? average(parts) : null;
}

/** La librería a la misma velocidad relativa (mismo número de Froude con su largo de pierna). */
function library(froude: number): GaitAnalysis {
  const legLength = createWorld().human.legLength;
  return analyzeHumanGait(Math.sqrt(froude * G * legLength)).analysis;
}

/** Media de varios análisis, ponderada por número de ciclos. */
function average(list: GaitAnalysis[]): GaitAnalysis {
  const total = list.reduce((s, a) => s + a.cycles, 0);
  const w = (a: GaitAnalysis): number => a.cycles / total;
  const scalars = Object.fromEntries(
    (Object.keys(list[0].scalars) as (keyof GaitScalars)[]).map((k) => [k, list.reduce((s, a) => s + a.scalars[k] * w(a), 0)]),
  ) as unknown as GaitScalars;
  const curve = (pick: (a: GaitAnalysis) => number[]): number[] =>
    pick(list[0]).map((_, i) => list.reduce((s, a) => s + pick(a)[i] * w(a), 0));
  const curves = Object.fromEntries(CURVE_NAMES.map((c) => [c, curve((a) => a.curves[c])])) as Record<CurveName, number[]>;
  const spread = Object.fromEntries(CURVE_NAMES.map((c) => [c, curve((a) => a.spread[c])])) as Record<CurveName, number[]>;
  return { scalars, curves, spread, cycles: total };
}

const range = (v: number[]): [number, number] => [Math.min(...v), Math.max(...v)];
const rms = (a: number[], b: number[]): number => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) / a.length);
const digits = (curve: string): number => (/Y$|X$|Height|Ahead/.test(curve) ? 3 : 1);

const SCALARS: [keyof GaitScalars, string, number][] = [
  ['speed', 'velocidad (m/s)', 2],
  ['froude', 'Froude', 3],
  ['cadence', 'cadencia (pasos/min)', 0],
  ['strideLength', 'zancada / pierna', 2],
  ['stance', 'apoyo (fracción)', 2],
  ['doubleSupport', 'doble apoyo', 2],
  ['stepWidth', 'ancho de paso / pierna', 3],
  ['armPeak', 'brazo adelante (fase)', 2],
  ['toeClearance', 'holgura de la punta / pierna', 3],
];

function summary(title: string, m: GaitAnalysis, lib: GaitAnalysis): string {
  const lines = [`\n## ${title} (${m.cycles} ciclos mocap, ${lib.cycles} librería)`, '| | mocap | librería |', '|---|---|---|'];
  for (const [k, label, d] of SCALARS) lines.push(`| ${label} | ${m.scalars[k].toFixed(d)} | ${lib.scalars[k].toFixed(d)} |`);
  lines.push('', '| curva | mocap (mín…máx) | librería (mín…máx) | RMS |', '|---|---|---|---|');
  for (const name of CURVE_NAMES) {
    const d = digits(name);
    const [a, b] = range(m.curves[name]);
    const [e, f] = range(lib.curves[name]);
    lines.push(`| ${name} | ${a.toFixed(d)} … ${b.toFixed(d)} | ${e.toFixed(d)} … ${f.toFixed(d)} | ${rms(m.curves[name], lib.curves[name]).toFixed(d)} |`);
  }
  return lines.join('\n');
}

/** Curvas cada 10 % del ciclo, mocap frente a librería. */
function curveTable(m: GaitAnalysis, lib: GaitAnalysis): string {
  const lines = ['', '| curva | | ' + Array.from({ length: 11 }, (_, i) => `${i * 10}%`).join(' | ') + ' |', '|---|---|' + '---|'.repeat(11)];
  for (const c of CURVE_NAMES) {
    const row = (a: GaitAnalysis): string => Array.from({ length: 11 }, (_, i) => a.curves[c][i * 5].toFixed(digits(c) === 3 ? 3 : 0)).join(' | ');
    lines.push(`| ${c} | mocap | ${row(m)} |`, `| | lib | ${row(lib)} |`);
  }
  return lines.join('\n');
}

function main(arg = 'normal'): void {
  if (arg === 'sfu') {
    const list = SFU_TRIALS.filter((t) => SFU_NORMAL_WALK.includes(t.id)).map(sfu).filter((a) => a !== null);
    const m = average(list);
    console.log(summary(`SFU caminar normal — media de ${SFU_NORMAL_WALK.join(', ')} (tramos rectos)`, m, library(m.scalars.froude)));
    if (process.env.CURVES) console.log(curveTable(m, library(m.scalars.froude)));
    return;
  }
  const sfuTrials = SFU_TRIALS.filter((t) => t.id.includes(arg) || t.kind === arg);
  if (sfuTrials.length > 0) {
    for (const trial of sfuTrials) {
      const m = sfu(trial);
      if (!m) {
        console.log(`\n## ${trial.id} — ${trial.label}: sin tramos rectos con ciclos completos`);
        continue;
      }
      const lib = library(m.scalars.froude);
      console.log(summary(`${trial.id} — ${trial.label}`, m, lib) + (process.env.CURVES ? curveTable(m, lib) : ''));
    }
    return;
  }
  if (arg === 'normal' || arg === 'referencia') {
    const m = average(TRIALS.filter((t) => NORMAL_WALK.includes(t.id)).map(mocap));
    if (arg === 'referencia') {
      // Solo medias por ciclo (datos derivados), no las capturas originales.
      const round = (x: number): number => Math.round(x * 1000) / 1000;
      const reference = {
        fuente: `CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu), tomas ${NORMAL_WALK.join(', ')}: medias por ciclo de marcha calculadas con tests/tools/mocapReport.ts.`,
        agradecimiento: 'The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.',
        ciclos: m.cycles,
        escalares: Object.fromEntries(Object.entries(m.scalars).map(([k, v]) => [k, round(v)])),
        curvas: Object.fromEntries(CURVE_NAMES.map((c) => [c, m.curves[c].map(round)])),
      };
      writeFileSync(REFERENCE, `${JSON.stringify(reference, null, 1)}\n`);
      console.log(`Escrito ${REFERENCE} (${m.cycles} ciclos, Froude ${m.scalars.froude.toFixed(3)}).`);
      return;
    }
    const lib = library(m.scalars.froude);
    console.log(summary('caminar normal — media de 35_01–03 y 16_15', m, lib));
    console.log(curveTable(m, lib));
    return;
  }
  for (const trial of TRIALS.filter((t) => t.id.includes(arg) || t.kind === arg)) {
    const m = mocap(trial);
    const lib = library(m.scalars.froude);
    console.log(summary(`${trial.id} — ${trial.label}`, m, lib) + (process.env.CURVES ? curveTable(m, lib) : ''));
  }
}

main(process.argv[2]);
