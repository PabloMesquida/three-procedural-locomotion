// Compila la librería (src/ → dist/): JavaScript ESM + tipos .d.ts.
// Uso: npm run build   (también se ejecuta antes de `npm pack`)
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.lib.json'], { stdio: 'inherit' });
console.log('Librería compilada en dist/');
