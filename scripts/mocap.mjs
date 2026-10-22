// Compara la marcha de la librería con capturas de movimiento de CMU (ver docs/en/naturalness.md).
// Compila tests + librería a .test-build/ (como npm test) y lanza la herramienta.
//
//   npm run mocap                   caminar normal: mocap frente a librería, curva a curva
//   npm run mocap -- 35_17          una toma (o un tipo: walk, run, style); CURVES=1 añade las curvas
//   npm run mocap -- referencia     regenera tests/reference/cmu-caminar.json
//   npm run mocap -- swing          forma del pie en el aire en el mocap
//
//   npm run mocap -- sfu            caminar normal en las tomas de SFU (o una toma: 0018, sfu-walk, sfu-style)
//
// Necesita las tomas (.asf/.amc) en recursos/mocap-cmu/ y, para SFU, los .bvh en recursos/mocap-sfu/;
// no se versionan.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

const arg = process.argv[2];
const isSfu = /^(sfu|00\d\d)/.test(arg ?? '');
if (isSfu ? !existsSync('recursos/mocap-sfu/0005_Walking001.bvh') : !existsSync('recursos/mocap-cmu/35.asf')) {
  console.error(`Faltan las capturas en recursos/mocap-${isSfu ? 'sfu' : 'cmu'}/ (ver docs/en/naturalness.md para descargarlas).`);
  process.exit(1);
}
try {
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.test.json'], { stdio: 'inherit' });
} catch {
  console.error('\nNo compila (errores de TypeScript arriba).');
  process.exit(1);
}
const tool = arg === 'swing' ? 'mocapSwing.js' : 'mocapReport.js';
const result = spawnSync(process.execPath, [join('.test-build', 'tests', 'tools', tool), ...(arg && arg !== 'swing' ? [arg] : [])], { stdio: 'inherit' });
process.exit(result.status ?? 1);
