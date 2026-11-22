# Faster drop-in for makefun-site 1.0.0

`run(input)` in `solve.js` returns exactly the output tree that makefun-site
1.0.0's `build` returns for the same site — every page, index and tag page,
`build-report.txt` and static file, byte for byte — with far less CPU.

## How it is faster

- One pass over each source instead of lex-then-render: blocks render straight
  into the output, with a single-scan line classifier.
- Inline Markdown scanned with native `indexOf` jumps to the next special
  character, and HTML escaping that first tests (natively) whether the run
  holds anything to escape.
- Slugs take an ASCII fast path and never touch `normalize()` for ASCII text;
  tag and title slugs are cached within one `run(input)` call.
- Every template is compiled once per case into a plain string-building
  function, so rendering a page is straight-line code instead of a tree walk
  with scope-chain lookups.
- No dependencies, no network, no clock, no cross-case state: each `run(input)`
  call is fully isolated and deterministic.

## Run it

Requires Node 22 or later. `main.ts` reads the cases and writes the answers:

```sh
node main.ts
```

It reads `/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`) and writes
`/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR/answers.json`).

## Check it locally

Compare against the house baseline on the practice set in the kit
(`practice/input/cases.json` vs `practice/reference/expected.json`): run the
driver with the practice input and diff the answers against the reference.
Every case must match exactly before speed counts — a single differing byte
fails the gate.

## Layout

- `solve.js` — the engine: front matter, Markdown, templates, permalinks,
  collections, tags, layouts and the build report, all in one module.
- `main.ts` — the driver the harness runs.
- `LICENSE` — MIT.

## License

MIT. See `LICENSE`.
