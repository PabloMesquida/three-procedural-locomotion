// Benchmark de rendimiento: compila librería + bench a .test-build/ (como los tests) y lo ejecuta.
//
//   npm run bench                     todos los escenarios
//   npm run bench -- --quick          rápido (1 y 10 personajes, caminando)
//   npm run bench -- --save-baseline  guarda los resultados como línea base
//
// Detalles en bench/bench.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

rmSync('.test-build', { recursive: true, force: true });
try {
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.test.json'], { stdio: 'inherit' });
} catch {
  console.error('\nEl benchmark no compila (errores de TypeScript arriba).');
  process.exit(1);
}
const result = spawnSync(process.execPath, [join('.test-build', 'bench', 'bench.js'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
