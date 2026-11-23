// main.ts — the driver the harness runs: reads every case from /input/cases.json,
// answers each with run() from solve.js, writes /output/answers.json.
// (MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in for /input and /output outside a container.)

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking --no-opt');

const { run } = await import(new URL('./solve.js', import.meta.url).href);

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const answers = [];
for (const c of cases) {
  // Rebuild each answer as a fresh object with its long strings flattened:
  // run() builds pages by concatenation (ropes) and adds keys dynamically
  // (dictionary mode); both make JSON.stringify ~3x slower. Rebuilding costs
  // ~7ms and cuts stringify from ~140ms to ~40ms. The JSON is identical.
  const obj = run(c.input);
  const flat = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v.length < 2048) {
      flat[k] = v;
      continue;
    }
    const parts = [];
    for (let i = 0; i < v.length; i += 4096) parts.push(v.slice(i, i + 4096));
    flat[k] = parts.join('');
  }
  answers.push(flat);
}
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
