# three-procedural-locomotion

Procedural human locomotion for Three.js (TypeScript, ESM, no runtime dependencies besides `three`). The website and
the lab (demo) live in a separate private repository, cloned in the sibling folder `../human`; they use this repo's
source and docs directly.

## Conventions

- Reply to the maintainer in Spanish. Commit messages in English, ending with the `Co-Authored-By` line.
- Ask before committing or pushing.
- Documentation exists in English and Spanish: `README.md` / `README.es.md` and `docs/en/*` / `docs/es/*` (same file
  names). Change both.
- TSDoc, error and warning messages are in English; internal `//` comments may be in Spanish.
- Never commit `recursos/` (local mocap data; SFU data is research-only) or third-party models.
- Line endings are mixed (CRLF/LF): preserve them. Git Bash `sed -i` turns CRLF into LF; edit with the Edit tool or Node.

## Commands

- `npm test` (≈1 min; `npm test -- walk` filters by file name). Rigify rig:
  `PH_MODEL=modelos/human.glb PH_MAPPING=rigify npm test`. The SFU test is skipped without `recursos/mocap-sfu`.
- `npm run typecheck`, `npm run build`, `npm pack --dry-run`. CI (`.github/workflows/ci.yml`) runs all of them on
  Node 20, 22 and 24.
- `npm run docs`: regenerates the parameter reference from the TSDoc. A new or changed parameter comment needs its
  Spanish translation in `docs/i18n/parameters.es.json` (with the new `en`); `npm test` checks it.
- `npm run mocap` (compare with CMU motion capture), `npm run bench`.

## Where things are

- Architecture, structure, tests and how to add a parameter: `docs/en/development.md`.
- Public API: `src/index.ts`; visual helpers: `src/debug/` (`three-procedural-locomotion/debug`).
- Exact-reference tests: `tests/golden/` (`UPDATE_GOLDEN=1 npm test` when a motion change is intended).
