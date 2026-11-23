// Round 3 driver for site-generator-speed-01-run-20261122.
//
// The harness runs `node /bot/main.ts`. It reads every case from
// cases.json under the input directory (a JSON array of { id, input }),
// answers each case alone with run() from ./solve.js, and writes the
// answers to answers.json under the output directory: a JSON array, one
// answer per case, in the cases' order. Outside a container the
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR environment variables stand in
// for /input and /output.
//
// V8's incremental marking is switched off before solve.js is imported, so
// all of the engine's work runs under it, as the house baseline does.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const answers = cases.map((c) => run(c.input));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
