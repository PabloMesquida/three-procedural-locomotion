import { Vector3 } from 'three';

import { loadMocap } from '../helpers/mocap.ts';

// Forma del vuelo del pie en el mocap (npm run mocap -- swing): de despegue a apoyo, normalizado a 0–1.
// Es la que sigue evaluateSwing al caminar (src/locomotion/FootTarget.ts).
const trials = ['35_01', '35_02', '35_03', '16_15'];
const N = 11;
const acc = { s: new Array(N).fill(0), h: new Array(N).fill(0), pitch: new Array(N).fill(0), n: 0 };
const UP = new Vector3(0, 1, 0);
for (const id of trials) {
  const sub = id.split('_')[0];
  const series = loadMocap(`recursos/mocap-cmu/${sub}.asf`, `recursos/mocap-cmu/${id}.amc`);
  const f = series.frames;
  const L = series.legLength;
  const fwdAll = f[f.length - 1].pelvis.clone().sub(f[0].pelvis).setY(0).normalize();
  for (const side of ['left', 'right'] as const) {
    const heel = f.map((x) => x.ankle[side].clone().sub(x.pelvis).dot(fwdAll));
    const toe = f.map((x) => x.toe[side].clone().sub(x.pelvis).dot(fwdAll));
    const peaks = (v: number[], r: number) => v.map((_, i) => i).filter((i) => i >= r && i < v.length - r && v.slice(i - r, i + r + 1).every((y) => y <= v[i]));
    const hs = peaks(heel, 24);
    const to = peaks(toe.map((v) => -v), 24);
    const restPitch = (() => { const d = series.rest.toe[side].clone().sub(series.rest.ankle[side]); return Math.atan2(d.y, Math.hypot(d.x, d.z)); })();
    const minY = Math.min(...f.map((x) => x.ankle[side].y));
    for (const a of to) {
      const b = hs.find((h) => h > a);
      if (b === undefined) continue;
      const x0 = f[a].ankle[side].dot(fwdAll), x1 = f[b].ankle[side].dot(fwdAll);
      for (let k = 0; k < N; k++) {
        const i = Math.round(a + ((b - a) * k) / (N - 1));
        const x = f[i].ankle[side];
        acc.s[k] += (x.dot(fwdAll) - x0) / (x1 - x0);
        acc.h[k] += (x.y - minY) / L;
        const d = f[i].toe[side].clone().sub(x);
        acc.pitch[k] += (Math.atan2(d.dot(UP), Math.hypot(d.x, d.z)) - restPitch) * 180 / Math.PI;
      }
      acc.n++;
      if (side === 'left' && id === '35_01') console.log('swing frames', b - a, 'dur', ((b - a) / 120).toFixed(3));
    }
  }
}
const fmt = (v: number[], d: number) => v.map((x) => (x / acc.n).toFixed(d)).join(' ');
console.log('swings', acc.n);
console.log('t      ', Array.from({ length: N }, (_, k) => (k / (N - 1)).toFixed(1)).join('   '));
console.log('avance ', fmt(acc.s, 3));
console.log('altura ', fmt(acc.h, 3));
console.log('pitch  ', fmt(acc.pitch, 1));
