/**
 * Benchmark de rendimiento de la librería (`npm run bench`).
 *
 * Mide, sin navegador, lo que cuesta `human.update` con N personajes en varios escenarios:
 * tiempo por frame (media, p50, p99, máximo), matrices de Three recalculadas, consultas al suelo y
 * memoria asignada por frame. Suelos: plano, malla de 51.200 triángulos con el raycast de Three ('malla')
 * y la misma malla con StaticGroundDetector ('malla-static', un detector para todos los personajes). Las matrices y los raycasts se cuentan en una pasada aparte
 * (contar cuesta y falsearía los tiempos).
 *
 *   npm run bench                     todos los escenarios
 *   npm run bench -- --quick          1 y 10 personajes, solo caminando
 *   npm run bench -- --save-baseline  guarda los resultados como línea base (bench/baseline.json)
 *   PH_MODEL=modelos/human.glb PH_MAPPING=rigify npm run bench   otro modelo
 *
 * Si existe bench/baseline.json, cada fila muestra la diferencia de tiempo con ella.
 * Los tiempos dependen de la máquina: compara siempre en la misma.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { Mesh, MeshBasicMaterial, Object3D, PlaneGeometry } from 'three';

import { RaycastGroundDetector, StaticGroundDetector } from '../src/index.ts';

import { createWorld, MODEL_PATH, type World } from '../tests/helpers/sim.ts';

type Mode = 'parado' | 'caminando' | 'corriendo' | 'girando';
type Ground = 'plano' | 'malla' | 'malla-static';

interface Scenario {
  mode: Mode;
  ground: Ground;
  n: number;
}

interface Result extends Scenario {
  key: string;
  frames: number;
  meanMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  perCharacterMs: number;
  matricesPerFrame: number;
  raycastsPerFrame: number;
  kbPerFrame: number;
}

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const saveBaseline = args.includes('--save-baseline');
const BASELINE = 'bench/baseline.json';
/** Presupuesto de tiempo de medida por escenario (ms) y límites de frames. */
const BUDGET_MS = 3000;
const MIN_FRAMES = 20;
const MAX_FRAMES = 600;
const WARMUP_FRAMES = 120;
const DT = 1 / 60;

/** Suelo detallado: un plano de 100 × 100 m con 160 × 160 celdas (51.200 triángulos), como un terreno real. */
function detailedGround(): Object3D {
  const mesh = new Mesh(new PlaneGeometry(100, 100, 160, 160).rotateX(-Math.PI / 2), new MeshBasicMaterial());
  mesh.updateMatrixWorld(true);
  return mesh;
}

function scenarios(): Scenario[] {
  const list: Scenario[] = [];
  const counts = quick ? [1, 10] : [1, 10, 50, 100];
  const modes: Mode[] = quick ? ['caminando'] : ['parado', 'caminando', 'corriendo', 'girando'];
  const grounds: Ground[] = quick ? ['plano', 'malla-static'] : ['plano', 'malla', 'malla-static'];
  // Con el raycast de Three sobre la malla basta con 1 y 10: con más tarda minutos.
  for (const ground of grounds) for (const mode of modes) for (const n of counts) if (ground !== 'malla' || n <= 10) list.push({ mode, ground, n });
  return list;
}

/** Personajes repartidos en una cuadrícula (cada uno en su propio mundo, sobre el mismo tipo de suelo). */
function createCharacters(s: Scenario): World[] {
  const mesh = s.ground === 'plano' ? null : detailedGround();
  const ground = mesh && (s.ground === 'malla' ? new RaycastGroundDetector([mesh]) : new StaticGroundDetector([mesh]));
  return Array.from({ length: s.n }, (_, i) => {
    const world = createWorld({
      staticGround: false,
      human: { seed: i + 1, ...(ground ? { ground } : {}) },
      place: (model, scene) => {
        model.position.set((i % 10) * 1.5 - 7, 0, Math.floor(i / 10) * 1.5 - 7);
        scene.add(model);
      },
    });
    world.human.reset();
    return world;
  });
}

/** Órdenes de cada modo (el giro cambia de rumbo cada 2 s). */
function drive(worlds: World[], mode: Mode, frame: number): void {
  for (const { human } of worlds) {
    if (mode === 'caminando') human.targetSpeed = 1;
    else if (mode === 'corriendo') human.targetSpeed = 3;
    else if (mode === 'girando') {
      human.targetSpeed = 1;
      if (frame % 120 === 0) human.targetHeading = human.heading + Math.PI * 0.75;
    }
  }
}

/** Cuenta llamadas a un método del prototipo mientras corre `fn`. */
function countCalls(proto: object, name: string, fn: () => void): number {
  const target = proto as Record<string, (...a: unknown[]) => unknown>;
  const original = target[name];
  let calls = 0;
  target[name] = function (this: unknown, ...a: unknown[]) {
    calls++;
    return original.apply(this, a);
  };
  try {
    fn();
  } finally {
    target[name] = original;
  }
  return calls;
}

function run(s: Scenario): Result {
  const worlds = createCharacters(s);
  let frame = 0;
  const step = (): void => {
    drive(worlds, s.mode, frame++);
    for (const { human } of worlds) human.update(DT);
  };
  // Calentamiento (JIT) y entrada en régimen; con el suelo detallado, limitado por tiempo.
  const warmStart = performance.now();
  for (let i = 0; i < WARMUP_FRAMES && performance.now() - warmStart < BUDGET_MS; i++) step();

  // Tiempos, sin contadores.
  const times: number[] = [];
  let allocated = 0;
  let lastHeap = process.memoryUsage().heapUsed;
  const start = performance.now();
  while (times.length < MAX_FRAMES && (times.length < MIN_FRAMES || performance.now() - start < BUDGET_MS)) {
    const t0 = performance.now();
    step();
    times.push(performance.now() - t0);
    const heap = process.memoryUsage().heapUsed;
    if (heap > lastHeap) allocated += heap - lastHeap; // las bajadas son recolecciones
    lastHeap = heap;
  }

  // Recuentos, en una pasada aparte de 10 frames.
  const countFrames = 10;
  // Consultas al suelo (castDown) de cualquiera de los dos detectores.
  let raycastQueries = 0;
  let staticQueries = 0;
  const matrices = countCalls(Object3D.prototype, 'updateMatrix', () => {
    raycastQueries = countCalls(RaycastGroundDetector.prototype, 'castDown', () => {
      staticQueries = countCalls(StaticGroundDetector.prototype, 'castDown', () => {
        for (let i = 0; i < countFrames; i++) step();
      });
    });
  });
  const raycasts = raycastQueries + staticQueries;

  const sorted = [...times].sort((a, b) => a - b);
  const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return {
    ...s,
    key: `${s.ground}/${s.mode}/${s.n}`,
    frames: times.length,
    meanMs: mean,
    p50Ms: pick(0.5),
    p99Ms: pick(0.99),
    maxMs: sorted[sorted.length - 1],
    perCharacterMs: mean / s.n,
    matricesPerFrame: matrices / countFrames / s.n,
    raycastsPerFrame: raycasts / countFrames / s.n,
    kbPerFrame: allocated / times.length / s.n / 1024,
  };
}

const baseline: Record<string, Result> = existsSync(BASELINE)
  ? Object.fromEntries((JSON.parse(readFileSync(BASELINE, 'utf8')).results as Result[]).map((r) => [r.key, r]))
  : {};

const f = (v: number, d = 2): string => v.toFixed(d).padStart(8);
console.log(`Modelo: ${MODEL_PATH}${Object.keys(baseline).length ? ` · comparando con ${BASELINE}` : ''}\n`);
console.log('escenario                     frames   media ms     p50     p99    máx  ms/pers  matrices raycasts  KB/frame  vs base');
const results: Result[] = [];
for (const s of scenarios()) {
  const r = run(s);
  results.push(r);
  const base = baseline[r.key];
  const diff = base ? `${((r.meanMs / base.meanMs - 1) * 100).toFixed(0).padStart(5)} %` : '';
  console.log(
    `${r.key.padEnd(28)}${String(r.frames).padStart(6)} ${f(r.meanMs)}${f(r.p50Ms)}${f(r.p99Ms)}${f(r.maxMs, 1)}${f(r.perCharacterMs, 3)}${f(r.matricesPerFrame, 0)}${f(r.raycastsPerFrame, 1)}${f(r.kbPerFrame, 1)}  ${diff}`,
  );
}

const out = { date: new Date().toISOString(), model: MODEL_PATH, node: process.version, results };
mkdirSync('bench/results', { recursive: true });
const file = `bench/results/${out.date.replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(out, null, 1));
if (saveBaseline) writeFileSync(BASELINE, JSON.stringify(out, null, 1));
console.log(`\nGuardado en ${file}${saveBaseline ? ` y como línea base (${BASELINE})` : ''}.`);
