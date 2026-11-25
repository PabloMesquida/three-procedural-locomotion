import { Vector3 } from 'three';

import type { Side } from '../../src/index.ts';
import { humanLandmarks } from '../helpers/humanLandmarks.ts';
import { createWorld, simulate } from '../helpers/sim.ts';

/**
 * Diagnóstico del salto (`jump()`), frame a frame: quieto, caminando y corriendo (y quieto con otras jumpSpeed, para
 * vuelos más cortos y más largos). Mide caderas, rodillas, brazos (hombro adelante y codo), tronco, pies y raíz, y
 * busca lo que lo hace robótico: mesetas, brusquedad, partes que arrancan a la vez, brazos y piernas en espejo y
 * parámetros que no cambian entre escenarios.
 *
 *   node .test-build/tests/tools/jumpDiag.js            (tablas)
 *   FRAMES=quieto node .test-build/tests/tools/jumpDiag.js   (además, frame a frame de un escenario)
 */
const DEG = 180 / Math.PI;
const SIDES: Side[] = ['left', 'right'];
const FWD = new Vector3(0, 0, -1);

interface Frame {
  t: number;
  phase: string;
  feet: string;
  hip: number;
  knee: Record<Side, number>;
  arm: Record<Side, number>;
  elbow: Record<Side, number>;
  trunk: number;
  footH: Record<Side, number>;
  sep: number;
  leg: Record<Side, number>;
  /** Tobillos delante de la pelvis (media, × pierna) y cabeza mirando abajo (°). */
  ahead: number;
  gaze: number;
  vx: number;
  vy: number;
  jArm: number;
  jHip: number;
  jLean: number;
}

interface Scenario {
  name: string;
  speed: number;
  config?: Record<string, number>;
  intent?: { distance?: number; height?: number };
}

let h0: ReturnType<typeof createWorld>['human'];
function run(sc: Scenario): { frames: Frame[]; request: number; liftoff: number; land: number; L: number } {
  const world = createWorld({ human: { config: sc.config ?? {} } });
  const h = world.human;
  h0 = h;
  const L = h.legLength;
  const at = sc.speed > 0 ? 3 : 1;
  const frames: Frame[] = [];
  let liftoff = -1;
  let land = -1;
  let t = 0;
  h.on('liftoff', () => { if (liftoff < 0) liftoff = t; });
  h.on('land', () => { if (land < 0) land = t; });
  const prev = new Vector3();
  let prevY = 0;
  simulate(world, at + 2.5, [[0, (x) => { x.targetHeading = 0; x.targetSpeed = sc.speed; }], [at, (x) => { x.jump(sc.intent); }]], {
    onFrame: (time) => {
      const dt = time - t;
      t = time;
      const m = humanLandmarks(h);
      const p = h.position;
      const angle = (a: Vector3, b: Vector3): number => {
        const v = b.clone().sub(a);
        return Math.atan2(v.dot(FWD), -v.y) * DEG;
      };
      const flex = (a: Vector3, b: Vector3, c: Vector3): number => b.clone().sub(a).angleTo(c.clone().sub(b)) * DEG;
      const j = h.locomotion.jumping;
      frames.push({
        t,
        phase: h.jumpPhase,
        feet: SIDES.map((s) => h.footPhase(s)[0]).join(''),
        hip: m.pelvis.y,
        knee: { left: flex(m.hip.left, m.knee.left, m.ankle.left), right: flex(m.hip.right, m.knee.right, m.ankle.right) },
        arm: { left: angle(m.shoulder.left, m.elbow.left), right: angle(m.shoulder.right, m.elbow.right) },
        elbow: { left: flex(m.shoulder.left, m.elbow.left, m.wrist.left), right: flex(m.shoulder.right, m.elbow.right, m.wrist.right) },
        trunk: Math.atan2(m.chest.clone().sub(m.pelvis).dot(FWD), m.chest.y - m.pelvis.y) * DEG,
        footH: { left: m.ankle.left.y, right: m.ankle.right.y },
        sep: m.ankle.left.clone().sub(m.ankle.right).dot(FWD),
        leg: { left: m.pelvis.distanceTo(m.ankle.left) / L, right: m.pelvis.distanceTo(m.ankle.right) / L },
        ahead: ((m.ankle.left.clone().sub(m.pelvis).dot(FWD) + m.ankle.right.clone().sub(m.pelvis).dot(FWD)) / 2) / L,
        gaze: Math.atan2(-(m.head.clone().sub(m.chest).dot(FWD)), m.head.y - m.chest.y) * -DEG,
        vx: dt > 0 ? Math.hypot(p.x - prev.x, p.z - prev.z) / dt : 0,
        vy: dt > 0 ? (p.y - prevY) / dt : 0,
        jArm: j.armForward(),
        jHip: j.hipOffset(),
        jLean: j.lean() * DEG,
      });
      prev.copy(p);
      prevY = p.y;
    },
  });
  return { frames, request: at, liftoff, land, L };
}

type Getter = (f: Frame) => number;
const SIGNALS: [string, Getter, number][] = [
  // nombre, valor, umbral de "quieto" por frame (° o m)
  ['caderas', (f) => f.hip, 0.0005],
  ['rodilla I', (f) => f.knee.left, 0.1],
  ['rodilla D', (f) => f.knee.right, 0.1],
  ['brazo I', (f) => f.arm.left, 0.1],
  ['brazo D', (f) => f.arm.right, 0.1],
  ['codo I', (f) => f.elbow.left, 0.1],
  ['codo D', (f) => f.elbow.right, 0.1],
  ['tronco', (f) => f.trunk, 0.05],
  ['pie I alto', (f) => f.footH.left, 0.0005],
  ['pie D alto', (f) => f.footH.right, 0.0005],
];

const pad = (s: string | number, n: number): string => String(s).padStart(n);
const f1 = (x: number): string => x.toFixed(1);
const f2 = (x: number): string => x.toFixed(2);

function analyze(sc: Scenario): void {
  const { frames, request, liftoff, land, L } = run(sc);
  const i0 = frames.findIndex((f) => f.t >= request);
  const iLift = frames.findIndex((f) => f.t >= liftoff);
  const iLand = frames.findIndex((f) => f.t >= land);
  const iEnd = Math.min(frames.findIndex((f, i) => i > iLand && f.phase === 'GROUNDED'), frames.length - 1);
  const base = frames.slice(Math.max(i0 - 60, 0), i0);
  const win = frames.slice(i0, iEnd + 1);
  const at = (i: number): string => `${f2(frames[i].t - request)} s ${frames[i].phase}`;
  console.log(`\n=== ${sc.name} (${sc.speed} m/s${sc.config ? ' ' + JSON.stringify(sc.config) : ''}${sc.intent ? ' ' + JSON.stringify(sc.intent) : ''}) ===`);
  const p = h0.locomotion.jumping.profile;
  console.log(`  perfil: esfuerzo ${f2(p.effort)}, flexión ${(100 * p.crouch).toFixed(1)} cm, bajar ${f2(p.descentTime)} s + empujar ${f2(p.pushTime)} s, brazos −${f1(p.armBack)}° → ${f1(p.armUp)}°, tronco ${f1(p.lean * DEG)}° → ${f1(p.leanTakeoff * DEG)}°${p.standing ? '' : ' (en carrera)'}`);
  const lift = frames[iLift];
  const pre = frames[iLift - 1];
  console.log(`  pedido → despegue ${f2(liftoff - request)} s · vuelo ${f2(land - liftoff)} s · amortiguación ${f2(frames[iEnd].t - land)} s · pies al despegar ${pre.feet} (P apoyado, S en el aire, L despegando)`);
  const hipBase = base.reduce((a, f) => a + f.hip, 0) / Math.max(base.length, 1);
  const takeoff = frames.slice(i0, iLift);
  const crouch = Math.min(...takeoff.map((f) => f.hip));
  const air = frames.slice(iLift, iLand);
  const apex = Math.max(...air.map((f) => f.hip));
  const absorb = frames.slice(iLand, iEnd + 1);
  const landMin = Math.min(...absorb.map((f) => f.hip));
  const vx = lift.vx;
  // Balístico: vy = g · vuelo / 2 (en llano).
  const vy = (9.81 * (land - liftoff)) / 2;
  console.log(`  caderas: antes ${f2(hipBase)} m, agachado −${(100 * (hipBase - crouch)).toFixed(1)} cm, arriba +${(100 * (apex - hipBase)).toFixed(1)} cm, al caer −${(100 * (hipBase - landMin)).toFixed(1)} cm`);
  console.log(`  despegue: vx ${f2(vx)} m/s, vy ${f2(vy)} m/s, ángulo ${f1(Math.atan2(vy, vx) * DEG)}°`);
  const kneeMax = (a: Frame[]) => Math.max(...a.map((f) => Math.max(f.knee.left, f.knee.right)));
  const kneeBase = Math.max(...base.map((f) => Math.max(f.knee.left, f.knee.right)));
  console.log(`  rodillas (la más doblada): antes ≤${f1(kneeBase)}°, preparación ${f1(kneeMax(takeoff))}°, aire ${f1(kneeMax(air))}°, contacto ${f1(Math.max(frames[iLand].knee.left, frames[iLand].knee.right))}°, pico al caer ${f1(kneeMax(absorb))}°`);
  const legOf = (f: Frame): number => (f.leg.left + f.leg.right) / 2;
  const legMin = Math.min(...air.map(legOf));
  const iLegMin = air.findIndex((f) => legOf(f) === legMin);
  const prep = Math.min(h0.locomotion.jumping.profile.landingPrep, land - liftoff);
  // Cuánto se queda el tuck quieto (dentro de 0,01 L del mínimo) y cuándo empiezan a recogerse (0,01 L menos).
  const hold = air.filter((f) => legOf(f) <= legMin + 0.01).length;
  const start = air.findIndex((f) => legOf(f) < legOf(air[0]) - 0.01);
  // Preparación del aterrizaje: desde el frame en que las piernas empiezan a estirarse de nuevo.
  console.log(`  aire: tuck (media de las piernas) ${f2(legMin)} L a los ${f2(air[iLegMin].t - liftoff)} s (${(100 * (air[iLegMin].t - liftoff) / (land - liftoff)).toFixed(0)} % del vuelo), quieto ${hold} fr, empieza a ${f2(start < 0 ? 0 : air[start].t - liftoff)} s; preparación del aterrizaje ${f2(prep)} s = ${(100 * prep / (land - liftoff)).toFixed(0)} % del vuelo; tobillos al tocar ${f2(frames[iLand].ahead)} L delante; cabeza ${f1(Math.min(...air.map((f) => f.gaze)))}…${f1(Math.max(...air.map((f) => f.gaze)))}° abajo`);
  for (const s of SIDES) {
    const v = win.map((f) => f.arm[s]);
    const e = win.map((f) => f.elbow[s]);
    console.log(`  brazo ${s === 'left' ? 'I' : 'D'}: ${f1(Math.min(...v))}…${f1(Math.max(...v))}° (antes ${f1(base.at(-1)!.arm[s])}°), codo ${f1(Math.min(...e))}…${f1(Math.max(...e))}°`);
  }
  console.log(`  tronco: ${f1(Math.min(...win.map((f) => f.trunk)))}…${f1(Math.max(...win.map((f) => f.trunk)))}° (antes ${f1(base.at(-1)!.trunk)}°) · jumping: armForward ${f1(Math.min(...win.map((f) => f.jArm)))}…${f1(Math.max(...win.map((f) => f.jArm)))}°, lean ≤${f1(Math.max(...win.map((f) => f.jLean)))}°`);

  // ¿armForward pasa por el muelle? Retraso (frames) entre su cambio y el del brazo: correlación cruzada de las derivadas.
  const dj = win.slice(1).map((f, i) => f.jArm - win[i].jArm);
  const da = win.slice(1).map((f, i) => (f.arm.left + f.arm.right) / 2 - (win[i].arm.left + win[i].arm.right) / 2);
  let best = 0;
  let bestLag = 0;
  for (let lag = 0; lag <= 12; lag++) {
    let c = 0;
    for (let i = 0; i + lag < da.length; i++) c += dj[i] * da[i + lag];
    if (c > best) { best = c; bestLag = lag; }
  }
  const resid = win.map((f) => (f.arm.left + f.arm.right) / 2 - f.jArm);
  console.log(`  armForward → brazo: retraso ${bestLag} frames; brazo − armForward: ${f1(Math.min(...resid))}…${f1(Math.max(...resid))}°`);

  // Mesetas, brusquedad y arranque por señal (en la ventana del salto).
  console.log(`  ${'señal'.padEnd(11)} ${pad('arranca', 8)} ${pad('pico', 7)} ${pad('meseta', 11)} ${pad('brusq. máx', 11)} ${pad('base p99', 9)}  dónde`);
  for (const [name, g, eps] of SIGNALS) {
    const v = win.map(g);
    const b = g(base.at(-1)!);
    const dev = v.map((x) => Math.abs(x - b));
    const maxDev = Math.max(...dev);
    const onset = dev.findIndex((d) => d > 0.1 * maxDev);
    const peak = dev.indexOf(maxDev);
    // Meseta: el tramo más largo con |Δ| < eps entre el pedido y el fin de la amortiguación.
    let run = 0;
    let longest = 0;
    let where = 0;
    for (let i = 1; i < v.length; i++) {
      run = Math.abs(v[i] - v[i - 1]) < eps ? run + 1 : 0;
      if (run > longest) { longest = run; where = i; }
    }
    const jerk = v.slice(2).map((x, i) => Math.abs(x - 2 * v[i + 1] + v[i]));
    const jMax = Math.max(...jerk);
    const jAt = jerk.indexOf(jMax) + 2;
    const bv = base.map(g);
    const bj = bv.slice(2).map((x, i) => Math.abs(x - 2 * bv[i + 1] + bv[i])).sort((a, c) => a - c);
    const p99 = bj[Math.floor(bj.length * 0.99)] ?? 0;
    const unit = name.startsWith('caderas') || name.startsWith('pie') ? 1000 : 1;
    console.log(`  ${name.padEnd(11)} ${pad(f2(win[Math.max(onset, 0)].t - request), 8)} ${pad(f2(win[peak].t - request), 7)} ${pad(longest > 2 ? `${longest} fr ${f2(win[where - longest].t - request)}` : '—', 11)} ${pad((jMax * unit).toFixed(2), 11)} ${pad((p99 * unit).toFixed(2), 9)}  ${at(i0 + jAt)}`);
  }
  // Espejo: correlación izquierda–derecha durante el salto.
  const corr = (a: number[], b: number[]): number => {
    const ma = a.reduce((x, y) => x + y, 0) / a.length;
    const mb = b.reduce((x, y) => x + y, 0) / b.length;
    let n = 0;
    let da2 = 0;
    let db2 = 0;
    for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da2 += (a[i] - ma) ** 2; db2 += (b[i] - mb) ** 2; }
    return n / Math.sqrt(da2 * db2 || 1);
  };
  const lr = (g: (f: Frame, s: Side) => number): string => {
    const a = win.map((f) => g(f, 'left'));
    const b = win.map((f) => g(f, 'right'));
    return `r ${f2(corr(a, b))}, |I−D| ≤ ${f1(Math.max(...a.map((x, i) => Math.abs(x - b[i]))))}`;
  };
  console.log(`  izquierda–derecha: brazos ${lr((f, s) => f.arm[s])}° · codos ${lr((f, s) => f.elbow[s])}° · rodillas ${lr((f, s) => f.knee[s])}°`);
  if (process.env.FRAMES === sc.name) {
    console.log('    t      fase      pies caderas rodI  rodD  brzI  brzD  codI  codD  tronco pieI  pieD  sep   vx   vy   jArm');
    for (const f of frames.slice(Math.max(i0 - 6, 0), iEnd + 6)) {
      console.log(`  ${pad(f2(f.t - request), 6)} ${f.phase.padEnd(9)} ${f.feet} ${pad(f2(f.hip), 6)} ${[f.knee.left, f.knee.right, f.arm.left, f.arm.right, f.elbow.left, f.elbow.right, f.trunk].map((x) => pad(f1(x), 5)).join(' ')} ${pad(f2(f.footH.left), 5)} ${pad(f2(f.footH.right), 5)} ${pad(f2(f.sep), 5)} ${pad(f2(f.vx), 4)} ${pad(f2(f.vy), 5)} ${pad(f1(f.jArm), 5)}`);
    }
  }
  void L;
}

const scenarios: Scenario[] = [
  { name: 'quieto', speed: 0 },
  { name: 'saltito', speed: 0, intent: { height: 0.1 } },
  { name: 'largo', speed: 0, intent: { distance: 1.5 } },
  { name: 'alto', speed: 0, intent: { height: 0.65 } },
  { name: 'caminando', speed: 1 },
  { name: 'corriendo', speed: 3 },
  { name: 'quieto-bajo', speed: 0, config: { jumpSpeed: 1.5 } },
  { name: 'quieto-alto', speed: 0, config: { jumpSpeed: 3.9 } },
];
for (const sc of scenarios) if (!process.env.ONLY || process.env.ONLY === sc.name) analyze(sc);

// Corriendo: ¿con qué pies despega según cuándo se pide el salto? (P apoyado, L despegando, S en el aire)
if (!process.env.ONLY) {
  const rows: string[] = [];
  for (let k = 0; k < 12; k++) {
    const world = createWorld();
    const h = world.human;
    let feet = '';
    let gait = '';
    simulate(world, 4.5, [[0, (x) => { x.targetHeading = 0; x.targetSpeed = 3; }], [3 + k * 0.03, (x) => { x.jump(); }]], {
      onFrame: () => {
        if (!feet && h.jumpPhase === 'TAKEOFF') gait = SIDES.map((s) => h.footPhase(s)[0]).join('');
        if (!feet && h.jumpPhase === 'AIRBORNE') feet = SIDES.map((s) => h.footPhase(s)[0]).join('');
      },
    });
    rows.push(`${(k * 0.03).toFixed(2)}:${gait}→${feet}`);
  }
  console.log(`\ncorriendo a 3 m/s, pedido a +t s: pies al pedir → al despegar\n  ${rows.join('  ')}`);
}
