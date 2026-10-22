// Ejecuta los tests automáticos: compila tests + librería a .test-build/ y los
// lanza con el test runner de Node (sin dependencias extra).
//
//   npm test                         todos los tests
//   npm test -- walk                 solo los archivos cuyo nombre contiene "walk"
//   UPDATE_GOLDEN=1 npm test         regenera las referencias exactas (tests/golden/)
//
// (En Windows/PowerShell: $env:UPDATE_GOLDEN=1; npm test)
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

rmSync('.test-build', { recursive: true, force: true });
try {
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.test.json'], { stdio: 'inherit' });
} catch {
  console.error('\nLos tests no compilan (errores de TypeScript arriba).');
  process.exit(1);
}

const filter = process.argv[2] ?? '';
const dir = join('.test-build', 'tests');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.js') && f.includes(filter))
  .sort()
  .map((f) => join(dir, f));
if (files.length === 0) {
  console.error(`No hay tests que coincidan con "${filter}".`);
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
