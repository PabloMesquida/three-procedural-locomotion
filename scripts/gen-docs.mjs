// Genera la referencia de parámetros a partir del código (comentarios TSDoc de las interfaces
// de configuración, valores por defecto, parámetros de longitud y estilos), en inglés
// (docs/en/parameters.md) y en español (docs/es/parameters.md), y docs/parameters.json: los
// mismos grupos y descripciones en los dos idiomas, para paneles de ajustes
// (se publica en el paquete: `three-procedural-locomotion/parameters.json`).
//
// El TSDoc está en inglés; el español sale de docs/i18n/parameters.es.json, que guarda con cada
// traducción el texto inglés del que se tradujo: si el TSDoc cambia, la traducción queda
// desactualizada y `--check` falla hasta que se revise (y se copie el `en` nuevo).
//
//   node scripts/gen-docs.mjs           escribe los tres archivos
//   node scripts/gen-docs.mjs --check   comprueba que están al día y que no falta, sobra ni está
//                                       desactualizada ninguna traducción (lo usa `npm test`)
//
// Así la referencia no puede desincronizarse del código.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const OUTPUTS = { en: 'docs/en/parameters.md', es: 'docs/es/parameters.md' };
const PANEL_OUTPUT = 'docs/parameters.json';
const TRANSLATIONS = 'docs/i18n/parameters.es.json';
const check = process.argv.includes('--check');

const parse = (file) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

/** Texto de los comentarios TSDoc de un nodo, en una línea. */
const docText = (node) =>
  ts.getJSDocCommentsAndTags(node).map((d) => (typeof d.comment === 'string' ? d.comment : '')).join(' ').replace(/\s+/g, ' ').trim();

/** Miembros (nombre, tipo, comentario) de una interfaz, en orden. */
function interfaceMembers(file, name) {
  const source = parse(file);
  let found = null;
  source.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) found = node;
  });
  if (!found) throw new Error(`No se encontró la interfaz ${name} en ${file}`);
  return found.members.map((member) => ({
    name: member.name.getText(source),
    type: member.type.getText(source),
    doc: docText(member),
  }));
}

/** Propiedades (nombre → texto del valor) de un objeto literal asignado a `name`. */
function objectLiteral(file, name) {
  const source = parse(file);
  const out = {};
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      let init = node.initializer;
      while (init && (ts.isSatisfiesExpression(init) || ts.isAsExpression(init) || ts.isCallExpression(init))) {
        init = ts.isCallExpression(init) ? init.arguments[0] : init.expression;
      }
      for (const prop of init.properties) {
        if (ts.isPropertyAssignment(prop)) out[prop.name.getText(source)] = prop.initializer;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { source, props: out };
}

/** Texto legible de un valor: números tal cual, (35 * Math.PI) / 180 → "35° (en rad)". */
function valueText(node, source) {
  const text = node.getText(source);
  return text.replace(/\s+/g, ' ');
}

/** Nombres de una constante array de strings (LENGTH_PARAMS…). */
function stringArray(file, name) {
  const source = parse(file);
  let names = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      let init = node.initializer;
      while (init && (ts.isSatisfiesExpression(init) || ts.isAsExpression(init))) init = init.expression;
      names = init.elements.map((e) => e.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

// ---------- Datos ----------
const members = [
  ...interfaceMembers('src/locomotion/LocomotionConfig.ts', 'LocomotionConfig'),
  ...interfaceMembers('src/body/PelvisController.ts', 'PelvisConfig'),
  ...interfaceMembers('src/body/TorsoController.ts', 'TorsoConfig'),
  ...interfaceMembers('src/body/ArmController.ts', 'ArmConfig'),
  ...interfaceMembers('src/body/TouchController.ts', 'TouchConfig'),
  ...interfaceMembers('src/navigation/MoveToController.ts', 'MoveToConfig'),
];
// Las interfaces de pelvis/brazos repiten algunos parámetros compartidos (stepLength, walkSpeed): una sola fila.
const unique = [];
for (const m of members) if (!unique.some((u) => u.name === m.name)) unique.push(m);

const defaults = { ...objectLiteral('src/locomotion/LocomotionConfig.ts', 'defaultLocomotionConfig'), };
const navDefaults = objectLiteral('src/navigation/MoveToController.ts', 'defaultMoveToConfig');
const valueOf = (name) => {
  if (defaults.props[name]) return valueText(defaults.props[name], defaults.source);
  if (navDefaults.props[name]) return valueText(navDefaults.props[name], navDefaults.source);
  return '—';
};
const lengths = new Set(stringArray('src/config.ts', 'LENGTH_PARAMS'));
const constructionOnly = new Set(stringArray('src/config.ts', 'CONSTRUCTION_ONLY_PARAMS'));

const presetsFile = objectLiteral('src/presets.ts', 'stylePresets');
const presetNames = Object.keys(presetsFile.props);
const presetValues = {};
const presetDocs = {};
for (const preset of presetNames) {
  presetDocs[preset] = docText(presetsFile.props[preset].parent);
  presetValues[preset] = {};
  for (const prop of presetsFile.props[preset].properties) {
    if (ts.isPropertyAssignment(prop)) presetValues[preset][prop.name.getText(presetsFile.source)] = valueText(prop.initializer, presetsFile.source);
  }
}

// ---------- Traducciones ----------
// Por parámetro y por estilo: { en: texto inglés del que se tradujo, es: traducción }.
const translations = JSON.parse(readFileSync(TRANSLATIONS, 'utf8'));
const problems = [];
const stale = [];
/** Descripción en los dos idiomas; anota las traducciones que faltan o están desactualizadas. */
function bilingual(kind, name, en) {
  const entry = translations[kind]?.[name];
  if (!en) return { en: '', es: '' };
  if (!entry?.es) {
    problems.push(`falta la traducción de ${kind}.${name}`);
    return { en, es: en };
  }
  if (entry.en !== en) stale.push(`${kind}.${name}: el TSDoc cambió desde que se tradujo (actualiza "es" y copia el "en" nuevo)`);
  return { en, es: entry.es };
}
const docs = Object.fromEntries(unique.map((m) => [m.name, bilingual('parameters', m.name, m.doc)]));
const presetTexts = Object.fromEntries(presetNames.map((p) => [p, bilingual('presets', p, presetDocs[p])]));
for (const [kind, names] of [['parameters', unique.map((m) => m.name)], ['presets', presetNames]]) {
  for (const name of Object.keys(translations[kind] ?? {})) {
    if (!names.includes(name)) problems.push(`sobra la traducción de ${kind}.${name} (ya no existe)`);
  }
}

// ---------- Secciones ----------
const sections = [
  [{ en: 'Speed and starting', es: 'Velocidad y arranque' }, (n) => ['walkSpeed', 'runSpeed', 'runStartSpeed', 'runTransition', 'acceleration', 'deceleration', 'speedEasing'].includes(n)],
  [{ en: 'Steps (walking)', es: 'Paso (caminando)' }, (n) => ['stepFrequency', 'minStepFrequency', 'stepLength', 'stepWidth', 'stepHeight', 'dutyFactor', 'liftFraction', 'plantFraction', 'heelLiftAngle', 'heelStrikeAngle', 'standKneeBend', 'stanceKneeBend', 'loadingKneeBend', 'walkLandingLead'].includes(n)],
  [{ en: 'Running', es: 'Correr' }, (n) => n.startsWith('run') && !['runSpeed', 'runStartSpeed', 'runTransition'].includes(n)],
  [{ en: 'Posture', es: 'Postura' }, (n) => n === 'walkLean' || n === 'ankleBack'],
  [{ en: 'Crouching', es: 'Agacharse' }, (n) => n.startsWith('crouch')],
  [{ en: 'Jumping', es: 'Salto' }, (n) => n === 'gravity' || n.startsWith('jump') || n.startsWith('landing') || n === 'maxLandingDip'],
  [{ en: 'Standing still', es: 'Pararse' }, (n) => n.startsWith('idle')],
  [{ en: 'Turning', es: 'Giro' }, (n) => n.startsWith('turn') || n === 'maxTurnPerStep' || n === 'maxLateralAcceleration'],
  [{ en: 'Weight shift', es: 'Reparto del peso' }, (n) => n.startsWith('lateralShift')],
  [{ en: 'Pelvis', es: 'Pelvis' }, (n) => n.startsWith('pelvis')],
  [{ en: 'Torso and head', es: 'Torso y cabeza' }, (n) => ['spineCounterRotation', 'chestCounterRotation', 'chestRollShare', 'leanPerAcceleration', 'maxLean', 'headStabilization', 'headTurnLead', 'maxHeadTurn', 'chestTurnLead', 'maxChestTurn', 'maxTurnLean', 'trunkFrequency', 'trunkDamping', 'trunkInertia'].includes(n)],
  [{ en: 'Arms', es: 'Brazos' }, (n) => ['armAbduction', 'elbowBend', 'idleArmAbduction', 'idleElbowBend', 'armSwing', 'elbowSwingBend', 'armSwingFrequency', 'armSwingDamping', 'armInertia', 'shoulderSwing', 'shoulderDrop', 'shoulderForward', 'forearmFrequency', 'handFrequency', 'fingerCurl', 'fingerFrequency'].includes(n)],
  [{ en: 'Touching surfaces', es: 'Tocar superficies' }, (n) => n.startsWith('touch')],
  [{ en: 'Natural variation', es: 'Variación natural' }, (n) => n === 'variation'],
  [{ en: 'Point and click (moveTo)', es: 'Point and click (moveTo)' }, (n) => ['arriveRadius', 'maxWalkTurnAngle', 'headingLockRadius', 'stopTolerance'].includes(n)],
  [{ en: 'Advanced: clearances and probes', es: 'Avanzado: márgenes y sondas' }, (n) => ['toeClearance', 'maxExtraStepHeight', 'groundProbeHeight', 'groundProbeDepth', 'footProbeHeight', 'footProbeDepth', 'footProbeTolerance', 'kneePoleDistance'].includes(n)],
];

// ---------- Textos de la página ----------
const strings = {
  en: {
    title: 'Parameter reference',
    otherLanguage: '[Español](../es/parameters.md)',
    generated: '<!-- Generated by scripts/gen-docs.mjs from the code. Do not edit by hand: `node scripts/gen-docs.mjs`. -->',
    intro: [
      `${unique.length} parameters. They are passed when creating the character (\`config\`) or at runtime (\`human.setConfig\`); all of them`,
      'are optional and validated (name, finite number and range).',
      '',
      '- **↔** = body length: multiplied by `bodyScale` (the character\'s size relative to the 1.83 m reference).',
      '- **⚑** = only applied when creating the character.',
      '- With `speedScale: \'auto\'` (the default), speeds and durations are also multiplied by √bodyScale and rates divided by √bodyScale (dynamic similarity, see the [guide](guide.md#character-size)); accelerations and angles are not scaled. With `\'off\'`, only lengths.',
    ],
    header: '| Parameter | Default | Description |',
    noDescription: '(no description)',
    presetsTitle: 'Style presets',
    presetsIntro: [
      'They are chosen when creating the character (`preset: \'…\'`) or at runtime (`human.applyPreset(\'…\')`); `config` and the',
      '`overrides` of `applyPreset` take precedence over the preset.',
    ],
    presetsTable: 'Values each preset changes (empty = the default):',
    presetsHeader: '| Parameter | Default |',
  },
  es: {
    title: 'Referencia de parámetros',
    otherLanguage: '[English](../en/parameters.md)',
    generated: '<!-- Generado por scripts/gen-docs.mjs a partir del código. No editar a mano: `node scripts/gen-docs.mjs`. -->',
    intro: [
      `${unique.length} parámetros. Se pasan al crear el personaje (\`config\`) o en ejecución (\`human.setConfig\`); todos son`,
      'opcionales y se validan (nombre, número finito y rango).',
      '',
      '- **↔** = longitud del cuerpo: se multiplica por `bodyScale` (tamaño del personaje respecto al de referencia de 1,83 m).',
      '- **⚑** = solo se aplica al crear el personaje.',
      '- Con `speedScale: \'auto\'` (por defecto), además velocidades y duraciones × √bodyScale y ritmos ÷ √bodyScale (semejanza dinámica, ver la [guía](guide.md#tamaño-del-personaje)); aceleraciones y ángulos no se escalan. Con `\'off\'`, solo las longitudes.',
    ],
    header: '| Parámetro | Por defecto | Descripción |',
    noDescription: '(sin descripción)',
    presetsTitle: 'Estilos (presets)',
    presetsIntro: [
      'Se eligen al crear (`preset: \'…\'`) o en ejecución (`human.applyPreset(\'…\')`); `config` y los `overrides`',
      'de `applyPreset` mandan sobre el estilo.',
    ],
    presetsTable: 'Valores que cambia cada estilo (vacío = el de por defecto):',
    presetsHeader: '| Parámetro | Por defecto |',
  },
};

const escape = (text) => text.replace(/\|/g, '\\|');

// Grupos como en la referencia; por parámetro: name, doc ({ en, es }), length (se escala con
// bodyScale) y constructionOnly (solo cuenta al crear el personaje).
const panelGroups = [];
const used = new Set();
for (const [title, test] of sections) {
  const rows = unique.filter((m) => test(m.name));
  if (rows.length === 0) continue;
  for (const m of rows) used.add(m.name);
  panelGroups.push({
    title,
    params: rows.map((m) => ({ name: m.name, doc: docs[m.name], length: lengths.has(m.name), constructionOnly: constructionOnly.has(m.name) })),
  });
}
const missing = unique.filter((m) => !used.has(m.name)).map((m) => m.name);
if (missing.length > 0) throw new Error(`Parámetros sin sección en gen-docs.mjs: ${missing.join(', ')}`);

function page(lang) {
  const t = strings[lang];
  const lines = [];
  lines.push(`# ${t.title}`);
  lines.push('');
  lines.push(t.otherLanguage);
  lines.push('');
  lines.push(t.generated);
  lines.push('');
  lines.push(...t.intro);
  lines.push('');
  for (const group of panelGroups) {
    lines.push(`## ${group.title[lang]}`);
    lines.push('');
    lines.push(t.header);
    lines.push('|---|---|---|');
    for (const p of group.params) {
      const marks = `${p.length ? ' ↔' : ''}${p.constructionOnly ? ' ⚑' : ''}`;
      lines.push(`| \`${p.name}\`${marks} | ${escape(valueOf(p.name))} | ${escape(p.doc[lang] || t.noDescription)} |`);
    }
    lines.push('');
  }

  lines.push(`## ${t.presetsTitle}`);
  lines.push('');
  lines.push(...t.presetsIntro);
  lines.push('');
  for (const p of presetNames) lines.push(`- \`${p}\`: ${presetTexts[p][lang] || t.noDescription}`);
  lines.push('');
  lines.push(t.presetsTable);
  lines.push('');
  const changed = unique.map((m) => m.name).filter((n) => presetNames.some((p) => n in presetValues[p]));
  lines.push(`${t.presetsHeader} ${presetNames.map((p) => `\`${p}\``).join(' | ')} |`);
  lines.push(`|---|---|${presetNames.map(() => '---').join('|')}|`);
  for (const n of changed) {
    lines.push(`| \`${n}\` | ${escape(valueOf(n))} | ${presetNames.map((p) => presetValues[p][n] ?? '').join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

const panelText = `${JSON.stringify(panelGroups, null, 2)}\n`;

const outputs = [[OUTPUTS.en, page('en')], [OUTPUTS.es, page('es')], [PANEL_OUTPUT, panelText]];
if (problems.length > 0) {
  console.error(`${TRANSLATIONS}:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
if (check) {
  let ok = stale.length === 0;
  if (!ok) console.error(`${TRANSLATIONS}: traducciones desactualizadas:\n  ${stale.join('\n  ')}`);
  for (const [file, content] of outputs) {
    let current = '';
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      // no existe
    }
    if (current.replace(/\r\n/g, '\n') !== content) {
      console.error(`${file} no está al día con el código. Regenéralo: npm run docs`);
      ok = false;
    }
  }
  if (!ok) process.exit(1);
  console.log(`${outputs.map(([file]) => file).join(', ')} y ${TRANSLATIONS} al día.`);
} else {
  for (const [file, content] of outputs) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  console.log(`Escrito ${outputs.map(([file]) => file).join(', ')} (${unique.length} parámetros).`);
  if (stale.length > 0) console.warn(`Aviso, ${TRANSLATIONS}: traducciones desactualizadas:\n  ${stale.join('\n  ')}`);
}
