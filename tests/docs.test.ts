import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

describe('documentación', () => {
  it('la referencia de parámetros (en, es, JSON) y sus traducciones están al día con el código (si falla: npm run docs)', () => {
    const result = spawnSync(process.execPath, ['scripts/gen-docs.mjs', '--check'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});
