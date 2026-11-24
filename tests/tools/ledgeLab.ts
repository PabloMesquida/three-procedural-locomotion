import { BoxGeometry, IcosahedronGeometry, Mesh, MeshBasicMaterial, type Object3D, Vector3 } from 'three';

import type { ProceduralHuman, Side } from '../../src/index.ts';
import { createWorld, simulate, type World } from '../helpers/sim.ts';

// El acantilado con cornisa del Laboratorio (lab/terrains.ts, cliffLedge): plataforma, cornisa de 35 cm y otra
// plataforma, con escaleras por fuera y rocas en la cara. Recorre la cornisa con moveTo y mide las piernas.
//   node ledgeLab.js [cruzar|volver]    LEG_TRACE=1: frame a frame lo raro
const FACE = -11;
const H = 0.17 * 8;
const HALF = 3;
const PLATFORM = 2.5;
const DEPTH = 2;

function box(parent: Object3D, w: number, h: number, d: number, x: number, y: number, z: number): void {
  const mesh = new Mesh(new BoxGeometry(w, h, d), new MeshBasicMaterial());
  mesh.position.set(x, y + h / 2, z);
  parent.add(mesh);
}
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

export function cliffWorld(x: number, z: number): World {
  const world = createWorld({
    buildTerrain: (g) => {
      const outer = HALF + PLATFORM;
      box(g, 2 * outer, 4.2, 2.5, 0, 0, FACE - 1.25);
      box(g, 2 * HALF, H, 0.35, 0, 0, FACE + 0.175);
      for (const side of [-1, 1]) {
        box(g, PLATFORM, H, DEPTH, side * (HALF + PLATFORM / 2), 0, FACE + DEPTH / 2);
        for (let k = 1; k < 8; k++) box(g, 0.28, 0.17 * k, 1.2, side * (outer + 0.28 * (8 - 1 - k + 0.5)), 0, FACE + DEPTH - 0.6);
      }
      const random = seededRandom(11);
      const geometry = new IcosahedronGeometry(1, 1);
      for (let bx = -HALF + 0.3; bx < HALF - 0.2; bx += lerp(0.45, 0.9, random())) {
        const bump = new Mesh(geometry, new MeshBasicMaterial());
        bump.scale.set(lerp(0.18, 0.35, random()), lerp(0.15, 0.4, random()), lerp(0.03, 0.09, random()));
        bump.rotation.z = (random() - 0.5) * 0.8;
        bump.position.set(bx, H + lerp(0.55, 1.6, random()), FACE);
        g.add(bump);
      }
    },
  });
  world.model.position.set(x, H, z);
  world.model.updateMatrixWorld(true);
  world.human.reset();
  return world;
}

/** Problemas de una pierna en este frame (vacío = bien). */
export function legIssues(human: ProceduralHuman, side: Side): string[] {
  const leg = human.rig[side];
  const p = (o: Object3D): Vector3 => o.getWorldPosition(new Vector3());
  const hip = p(leg.thigh);
  const knee = p(leg.shin);
  const ankle = p(leg.foot);
  const toe = leg.toe ? p(leg.toe) : ankle.clone().add(new Vector3(0, 0, 0.1));
  const issues: string[] = [];
  // Hacia dónde se dobla la rodilla (perpendicular a cadera–tobillo) frente a hacia dónde apunta el pie.
  const axis = ankle.clone().sub(hip).normalize();
  const bend = knee.clone().sub(hip);
  bend.addScaledVector(axis, -bend.dot(axis));
  const footDir = toe.clone().sub(ankle).setY(0);
  if (bend.length() > 0.02 && footDir.lengthSq() > 1e-6) {
    bend.setY(0);
    if (bend.lengthSq() > 1e-6) {
      const angle = (bend.angleTo(footDir) * 180) / Math.PI;
      if (angle > 60) issues.push(`rodilla ${angle.toFixed(0)}° del pie`);
    }
  }
  return issues;
}

const scenario = process.argv[1]?.endsWith("ledgeLab.js") ? (process.argv[2] ?? "cruzar") : "";
if (scenario === 'entrar') {
  // Desde la plataforma derecha (sx, sz desde la cara) a un punto de la cornisa (tx): pies en la pared y cruzados.
  const [sx, sz, tx] = process.argv.slice(3, 6).map(Number);
  const world = cliffWorld(sx, FACE + sz);
  const { human } = world;
  let inWall = 0;
  let crossed = 0;
  let firstBad = -1;
  let time = 0;
  simulate(world, 14, [[0, (h) => h.moveTo(new Vector3(tx, H, FACE + 0.17))]], {
    onFrame: () => {
      time += 1 / 60;
      for (const side of ['left', 'right'] as const) {
        const leg = human.rig[side];
        const pts = [leg.foot, leg.toe ?? leg.foot].map((b) => b.getWorldPosition(new Vector3()));
        const depth = Math.max(...pts.map((p) => FACE + 0.01 - p.z));
        if (depth > inWall) { inWall = depth; if (depth > 0.01 && firstBad < 0) firstBad = time; }
      }
      const F = human.locomotion.body.state.forward;
      const right = new Vector3().crossVectors(F, new Vector3(0, 1, 0));
      const apart = human.rig.right.foot.getWorldPosition(new Vector3()).sub(human.rig.left.foot.getWorldPosition(new Vector3())).dot(right);
      if (-apart > crossed) { crossed = -apart; if (crossed > 0.03 && firstBad < 0) firstBad = time; }
    },
  });
  console.log(`entrar desde (${sx}, cara+${sz}) → cornisa x ${tx}: pie en la pared ${(inWall * 100).toFixed(1)} cm, pies cruzados ${(crossed * 100).toFixed(1)} cm${firstBad >= 0 ? `, desde t ${firstBad.toFixed(2)}` : ''}; final x ${human.position.x.toFixed(2)}`);
  process.exit(0);
}
if (scenario === 'pasos') {
  // Cada aterrizaje al cruzar (o volver: pasos volver t): cuánto avanzó ese pie y cómo estaba la cornisa.
  const back = process.argv[3] === 'volver';
  const t0 = Number(process.argv[4] ?? 9);
  // DEST=x,z (desde la cara): adónde cruza.
  const [dx, dz] = (process.env.DEST ?? `${HALF + 1.2},1`).split(',').map(Number);
  const world = cliffWorld(-HALF - 1.2, FACE + 1);
  const { human } = world;
  const was: Record<Side, boolean> = { left: false, right: false };
  const last: Record<Side, Vector3 | null> = { left: null, right: null };
  let t = 0;
  const steps: [number, (h: ProceduralHuman) => void][] = [[0, (h) => h.moveTo(new Vector3(dx, H, FACE + dz))]];
  if (back) steps.push([t0, (h) => h.moveTo(new Vector3(-HALF - 1.2, H, FACE + 1))]);
  simulate(world, back ? t0 + 16 : 32, steps, {
    onFrame: () => {
      t += 1 / 60;
      const [from, to] = (process.env.TRACE ?? '').split(',').map(Number);
      if (t >= from && t <= to) {
        const st = human.locomotion.body.state;
        const feet = (human.locomotion as unknown as { feet: Record<Side, { phase: string; swing: { landing: Vector3 }; planted: Vector3 }> }).feet;
        const fs2 = (side: Side): string => { const ft = feet[side]; const p = ft.phase === 'SWING' ? ft.swing.landing : ft.planted; return `${side[0]} ${ft.phase.padEnd(6)} ${p.x.toFixed(2)},${(p.z - FACE).toFixed(2)}`; };
        console.log(`  ${t.toFixed(2)} cuerpo ${st.position.x.toFixed(2)},${(st.position.z - FACE).toFixed(2)} v ${st.speed.toFixed(2)}→${human.locomotion.body.targetSpeed.toFixed(2)} lim ${human.locomotion.body.speedLimit.toFixed(2)} ledge ${human.ledge.toFixed(2)} giro ${((st.facingOffset * 180) / Math.PI).toFixed(0)} | ${fs2('left')} | ${fs2('right')}`);
      }
      for (const side of ['left', 'right'] as const) {
        const air = human.footPhase(side) === 'SWING';
        if (was[side] && !air) {
          const p = human.rig[side].foot.getWorldPosition(new Vector3());
          const d = last[side] ? p.distanceTo(last[side]!) : 0;
          const other = human.rig[side === 'left' ? 'right' : 'left'].foot.getWorldPosition(new Vector3());
          console.log(`t ${t.toFixed(2)} ${side.padEnd(5)} x ${p.x.toFixed(2)} cara+${(p.z - FACE).toFixed(2)} paso ${d.toFixed(2)} sep ${p.distanceTo(other).toFixed(2)} ledge ${human.ledge.toFixed(2)} v ${human.speed.toFixed(2)} ${human.gaitMode}`);
          last[side] = p;
        }
        was[side] = air;
      }
    },
  });
  process.exit(0);
}
if (scenario === 'cerca') {
  // Parado en la cornisa cerca de su final (x), y un clic en la plataforma de al lado (tx, tz desde la cara).
  const [x, tx, tz] = process.argv.slice(3, 6).map(Number);
  const world = cliffWorld(-HALF - 1.2, FACE + 1);
  const { human } = world;
  simulate(world, 22, [[0, (h) => h.moveTo(new Vector3(x, H, FACE + 0.17))]]);
  const start = human.position.clone();
  let moved = 0;
  simulate(world, 8, [[0, (h) => h.moveTo(new Vector3(tx, H, FACE + tz))]], {
    start: 22,
    onFrame: () => { moved = Math.max(moved, human.position.distanceTo(start)); },
  });
  console.log(`cerca x ${x} → (${tx}, cara+${tz}): parado en x ${start.x.toFixed(2)} z-cara ${(start.z - FACE).toFixed(2)} ledge ${human.ledge.toFixed(2)}; se movió ${moved.toFixed(2)} m, final (${human.position.x.toFixed(2)}, cara+${(human.position.z - FACE).toFixed(2)}), destino ${human.moveTarget ? 'pendiente' : 'alcanzado'}`);
  process.exit(0);
}
/** volver: instante del clic de vuelta (s; por defecto 9) y adónde (plataforma de salida, o 'cornisa': un punto detrás en ella). */
const backAt = Number(process.argv[3] ?? 9);
const backTo = process.argv[4] ?? 'plataforma';
const world = cliffWorld(-HALF - 1.2, FACE + 1);
const { human } = world;
const far = new Vector3(HALF + 1.2, H, FACE + 1);
const back = backTo === 'cornisa' ? new Vector3(-1.5, H, FACE + 0.2) : new Vector3(-HALF - 1.2, H, FACE + 1);
let t = 0;
const lastKnee: Record<Side, Vector3 | null> = { left: null, right: null };
const lastKneeV: Record<Side, Vector3 | null> = { left: null, right: null };
let lastHips: Vector3 | null = null;
const stats = new Map<string, { n: number; first: number; worst: string }>();
const note = (kind: string, detail: string): void => {
  const s = stats.get(kind) ?? { n: 0, first: t, worst: '' };
  s.n++;
  if (!s.worst) s.worst = detail;
  stats.set(kind, s);
  if (process.env.LEG_TRACE) console.log(`t ${t.toFixed(2)} x ${human.position.x.toFixed(2)} ledge ${human.ledge.toFixed(2)} ${kind}: ${detail}`);
};
let stuck = 0;
const steps: [number, (h: ProceduralHuman) => void][] = [[0, (h) => h.moveTo(far)]];
if (scenario === 'volver') steps.push([backAt, (h) => h.moveTo(back)]);
simulate(world, scenario === "volver" ? backAt + Number(process.env.EXTRA ?? 20) : 32, steps, {
  onFrame: () => {
    t += 1 / 60;
    const hips = human.rig.hips.getWorldPosition(new Vector3());
    for (const side of ['left', 'right'] as const) {
      for (const issue of legIssues(human, side)) note('rodilla torcida', `${side} ${issue}`);
      const knee = human.rig[side].shin.getWorldPosition(new Vector3());
      const prev = lastKnee[side];
      if (prev && lastHips) {
        // Cambio brusco de la velocidad de la rodilla respecto a las caderas (cm/frame por frame).
        const v = knee.clone().sub(prev).sub(hips.clone().sub(lastHips));
        const pv = lastKneeV[side];
        if (pv) {
          const jerk = v.clone().sub(pv).length();
          if (jerk > 0.012) note('tirón de rodilla', `${side} ${(jerk * 100).toFixed(1)} cm/frame²`);
        }
        lastKneeV[side] = v;
      }
      lastKnee[side] = knee;
      const r = (human.locomotion as unknown as { legs: Record<Side, { result: { error: number } | null }> }).legs[side].result;
      if (r && r.error > 0.01) note('IK no llega', `${side} ${(r.error * 100).toFixed(1)} cm`);
    }
    lastHips = hips;
    const F = human.locomotion.body.state.forward;
    const right = new Vector3().crossVectors(F, new Vector3(0, 1, 0));
    const apart = human.rig.right.foot.getWorldPosition(new Vector3()).sub(human.rig.left.foot.getWorldPosition(new Vector3())).dot(right);
    if (apart < 0 && human.ledge > 0) note('pies cruzados', `${(apart * 100).toFixed(1)} cm`);
    if (human.moveTarget && human.speed < 0.02 && human.gaitMode === 'idle') stuck++;
  },
});
console.log(`${scenario}: final x ${human.position.x.toFixed(2)} z ${human.position.z.toFixed(2)}, destino ${human.moveTarget ? 'pendiente' : 'alcanzado'}, frames quieto con destino ${stuck}`);
for (const [kind, s] of stats) console.log(`  ${kind}: ${s.n} frames, desde t ${s.first.toFixed(2)} (${s.worst})`);
