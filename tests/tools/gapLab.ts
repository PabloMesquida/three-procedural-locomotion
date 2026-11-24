import { BoxGeometry, Mesh, MeshBasicMaterial, type Object3D, Vector3 } from 'three';

import type { Side } from '../../src/index.ts';
import { createWorld, simulate } from '../helpers/sim.ts';

// Huecos que cruza de un paso (maxGapStep): dos plataformas a 1 m separadas por un hueco de `ancho` m, cruzando
// hacia −Z a `v` m/s (o en diagonal, `angulo` grados). Mide si cruza, si algún pie apoya en el hueco, el paso más largo,
// la IK y las caderas.
//   node gapLab.js ancho v [angulo]      TRACE=1: cada aterrizaje
// ALTO: altura de las plataformas (3: sin fondo a la vista); OTRA: cuánto más alta la otra orilla.
const H = Number(process.env.ALTO ?? 1);
const FAR = Number(process.env.OTRA ?? 0);
function box(parent: Object3D, w: number, h: number, d: number, x: number, y: number, z: number): void {
  const mesh = new Mesh(new BoxGeometry(w, h, d), new MeshBasicMaterial());
  mesh.position.set(x, y + h / 2, z);
  parent.add(mesh);
}
export function gapWorld(width: number, start = 1.6, x = 0): ReturnType<typeof createWorld> {
  const world = createWorld({
    buildTerrain: (g) => {
      box(g, 6, H, 12, 0, 0, 6);
      box(g, 6, H + FAR, 6, 0, 0, -width - 3);
    },
  });
  world.model.position.set(x, H, start);
  world.model.updateMatrixWorld(true);
  world.human.reset();
  return world;
}

const [width, v, angle] = [Number(process.argv[2] ?? 0.4), Number(process.argv[3] ?? 1.4), Number(process.argv[4] ?? 0)];
if (process.argv[1]?.endsWith('gapLab.js')) {
  const world = gapWorld(width, Number(process.env.START ?? 1.6));
  const { human } = world;
  const was: Record<Side, boolean> = { left: false, right: false };
  let t = 0;
  let inGap = 0;
  let longest = 0;
  let ik = 0;
  let lowHips = Infinity;
  let farHips = Infinity;
  let minY = Infinity;
  const p = (o: Object3D): Vector3 => o.getWorldPosition(new Vector3());
    // MOVETO=x,z: con moveTo a ese punto (en la otra plataforma: z < −ancho), en vez de caminar recto; RUN=1 corriendo.
  const goal = process.env.MOVETO?.split(',').map(Number);
  let arrived = false;
  human.on('arrive', () => { arrived = true; });
  const order = goal ? (h: typeof human): void => { h.moveTo(new Vector3(goal[0], H + FAR, goal[1]), { run: !!process.env.RUN }); } : (h: typeof human): void => { h.targetHeading = (angle * Math.PI) / 180; h.targetSpeed = v; };
  simulate(world, Number(process.env.TIME ?? 8), [[0, order]], {
    onFrame: () => {
      t += 1 / 60;
      if (goal && t < 0.02) console.log(`ruta ${human.movePath?.map((q) => `(${q.x.toFixed(2)},${q.z.toFixed(2)})`).join(" ")}`);
      const s = human.locomotion.body.state;
      const [from, to] = (process.env.FRAMES ?? '-1,-1').split(',').map(Number);
      if (t >= from && t <= to) {
        const st = (human.locomotion as unknown as { stairs: { active: boolean; blend: number; profile: { count: number; treads: { start: number; end: number; startHeight: number; gap: boolean; cross: boolean }[] }; walls: { point: Vector3; gap: number }[] } }).stairs;
        const treads = st.profile.treads.slice(0, st.profile.count).map((tr) => `[${tr.start.toFixed(2)},${tr.end.toFixed(2)} h${tr.startHeight.toFixed(1)}${tr.cross ? ' X' : tr.gap ? ' g' : ''}]`).join('');
        const walls = st.walls.filter((w) => !Number.isNaN(w.point.x)).map((w) => `(z ${w.point.z.toFixed(2)} gap ${w.gap.toFixed(2)})`).join('');
        const f = (side: Side): string => `${side[0]} ${human.footPhase(side).padEnd(7)} z ${p(human.rig[side].foot).z.toFixed(2)}`;
        console.log(`  ${t.toFixed(2)} z ${s.position.z.toFixed(2)} y ${s.position.y.toFixed(2)} v ${s.speed.toFixed(2)} lim ${human.locomotion.body.speedLimit.toFixed(2)} perfil ${st.active ? 'sí' : 'no'} ${st.blend.toFixed(2)} ${treads} paredes ${walls} | ${f('left')} | ${f('right')}`);
      }
      minY = Math.min(minY, s.position.y);
      // Cerca del hueco (no al frenar al final de la plataforma).
      if (s.position.z < 1.5 && s.position.z > -width - 1.5) lowHips = Math.min(lowHips, (p(human.rig.hips).y - H) / human.legLength);
      else farHips = Math.min(farHips, (p(human.rig.hips).y - H) / human.legLength);
      for (const side of ['left', 'right'] as const) {
        const r = (human.locomotion as unknown as { legs: Record<Side, { result: { error: number } | null }> }).legs[side].result;
        if (r) ik = Math.max(ik, r.error);
        const air = human.footPhase(side) === 'SWING';
        if (was[side] && !air) {
          const a = p(human.rig[side].foot);
          const other = p(human.rig[side === 'left' ? 'right' : 'left'].foot);
          const sep = a.distanceTo(other);
          longest = Math.max(longest, sep);
          if (a.y < H - 0.05) inGap++;
          if (process.env.TRACE) console.log(`  t ${t.toFixed(2)} ${side.padEnd(5)} z ${a.z.toFixed(2)} y ${a.y.toFixed(2)} sep ${sep.toFixed(2)} v ${s.speed.toFixed(2)} cuerpo z ${s.position.z.toFixed(2)}`);
        }
        was[side] = air;
      }
    },
  });
  const crossed = human.position.z < -width - 0.3 && human.position.y > H + FAR - 0.05;
  if (goal) console.log(`moveTo (${goal}): ${arrived ? 'llegó' : 'NO llegó'}, ruta ${human.movePath?.map((q) => `(${q.x.toFixed(2)},${q.z.toFixed(2)})`).join(' ') ?? '-'}`);
  console.log(`hueco ${width} m a ${v} m/s${angle ? `, ${angle}°` : ''}: ${crossed ? 'cruzó' : 'NO cruzó'} (z ${human.position.z.toFixed(2)}, y ${human.position.y.toFixed(2)}, y mín ${minY.toFixed(2)}); pies en el hueco ${inGap}; paso más largo ${longest.toFixed(2)} m; IK ${(ik * 100).toFixed(1)} cm; caderas mín ${lowHips.toFixed(2)} piernas (lejos del hueco ${farHips.toFixed(2)})`);
}
