import * as ts from 'typescript';
import * as core from '../src/core';

type Files = Record<string, string>;

function makeService(files: Files) {
  const names = Object.keys(files);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => names,
    getScriptVersion: () => '1',
    getScriptSnapshot: (f) => (files[f] !== undefined ? ts.ScriptSnapshot.fromString(files[f]) : undefined),
    getCurrentDirectory: () => '/',
    getCompilationSettings: () => ({ target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true, jsx: ts.JsxEmit.Preserve }),
    getDefaultLibFileName: () => '/lib.d.ts',
    fileExists: (f) => files[f] !== undefined,
    readFile: (f) => files[f],
  };
  return ts.createLanguageService(host);
}

/** Simulates: put cursor on the function in `file` at `marker`, press the shortcut, apply `order`. */
function run(files: Files, file: string, marker: string, order: number[]) {
  const text = files[file];
  const cursor = text.indexOf(marker);
  if (cursor < 0) throw new Error('marker not found: ' + marker);
  const sf = core.parseSource(file, text);
  const fn = core.findFunctionAtHeader(sf, cursor) ?? core.findEnclosingWithAnchor(sf, cursor);
  if (!fn) throw new Error('no function at marker');
  const anchor = core.anchorNode(fn, sf);
  if (!anchor) throw new Error('no anchor');

  const svc = makeService(files);
  const refs = svc.getReferencesAtPosition(file, anchor.getStart(sf)) ?? [];
  const byFile = new Map<string, Set<number>>();
  for (const r of refs) {
    if (!files[r.fileName]) continue;
    if (!byFile.has(r.fileName)) byFile.set(r.fileName, new Set());
    byFile.get(r.fileName)!.add(r.textSpan.start);
  }
  const inputs: core.RefInput[] = Object.keys(files).map((f) => ({
    fileName: f,
    text: files[f],
    offsets: [...(byFile.get(f) ?? [])],
  }));
  const an = core.analyze(inputs, { fileName: file, fnStart: fn.getStart(sf) });
  if (!core.isPermutation(order, an.shape.r)) throw new Error('bad order');
  const res = core.computeEdits(an, order);
  const out: Files = { ...files };
  for (const [f, edits] of res.edits) {
    out[f] = core.applyEditsToText(files[f], edits);
    if (core.syntaxErrorCount(f, out[f]) > core.syntaxErrorCount(f, files[f])) throw new Error('syntax regression in ' + f);
  }
  return { out, res };
}

let failed = 0;
function check(name: string, actual: string, expected: string) {
  if (actual.trim() === expected.trim()) console.log('  ✓', name);
  else {
    failed++;
    console.log('  ✗', name, '\n--- expected\n' + expected + '\n--- actual\n' + actual);
  }
}

// 1 ── the example from the request ──────────────────────────────────────────
{
  const files: Files = {
    '/a.ts': `export const func1 = (name: string, age: number) => {\n    console.log(name, " age: ", age);\n    \n}\n`,
    '/b.ts': `import { func1 } from "./a";\n\nfunc1("Mohammad", 20);\n`,
  };
  const { out } = run(files, '/a.ts', 'func1', [1, 0]);
  console.log('1. basic arrow function');
  check('declaration', out['/a.ts'], `export const func1 = (age: number, name: string) => {\n    console.log(name, " age: ", age);\n    \n}`);
  check('call site', out['/b.ts'], `import { func1 } from "./a";\n\nfunc1(20, "Mohammad");`);
}

// 2 ── n parameters, multi-line calls, comments, types, defaults ─────────────
{
  const files: Files = {
    '/a.ts': `export function build(a: string, b?: number, c = 3, d: boolean = true, ...rest: string[]) {\n  return [a, b, c, d, rest];\n}\n`,
    '/b.ts': `import { build } from './a';\nbuild(\n  "x", // first\n  2,\n  4,\n  false,\n  "r1", "r2"\n);\nbuild("only");\nbuild("x", 1);\n`,
  };
  const { out } = run(files, '/a.ts', 'build', [3, 0, 2, 1]);
  console.log('2. n params, rest, optional, comments');
  check('declaration', out['/a.ts'].split('\n')[0], `export function build(d: boolean = true, a: string, c = 3, b?: number, ...rest: string[]) {`);
  check('calls', out['/b.ts'], `import { build } from './a';
build(
  false, // first
  "x",
  4,
  2,
  "r1", "r2"
);
build(undefined, "only");
build(undefined, "x", undefined, 1);`);
}

// 3 ── nested calls (overlapping edits) ──────────────────────────────────────
{
  const files: Files = {
    '/a.ts': `export function f(a: number, b: number, c: number) { return a + b + c; }\n`,
    '/b.ts': `import { f } from './a';\nconst r = f(f(1, 2, 3), f(4, 5, 6), f(f(7, 8, 9), 0, 0));\n`,
  };
  const { out } = run(files, '/a.ts', 'f(', [2, 0, 1]);
  console.log('3. nested calls');
  check('calls', out['/b.ts'], `import { f } from './a';\nconst r = f(f(0, f(9, 7, 8), 0), f(3, 1, 2), f(6, 4, 5));`);
}

// 4 ── class methods, interface, implements, super, new ──────────────────────
{
  const files: Files = {
    '/a.ts': `export interface Greeter { greet(name: string, loud: boolean): string }
export class Impl implements Greeter {
  greet(name: string, loud: boolean) { return loud ? name.toUpperCase() : name; }
}
export class Base { constructor(public x: number, protected y: string) {} }
export class Derived extends Base { constructor() { super(1, "y"); } }
`,
    '/b.ts': `import { Impl, Base, Greeter } from './a';
const g: Greeter = new Impl();
g.greet("a", true);
new Impl().greet("b", false);
const maybe: Greeter | undefined = g;
maybe?.greet("c", true);
const b = new Base(5, "z");
`,
  };
  console.log('4a. method via interface');
  const r1 = run(files, '/a.ts', 'greet(name', [1, 0]);
  check('interface+impl', r1.out['/a.ts'].split('\n').slice(0, 3).join('\n'), `export interface Greeter { greet(loud: boolean, name: string): string }\nexport class Impl implements Greeter {\n  greet(loud: boolean, name: string) { return loud ? name.toUpperCase() : name; }`);
  check('calls', r1.out['/b.ts'].split('\n').slice(2, 6).join('\n'), `g.greet(true, "a");\nnew Impl().greet(false, "b");\nconst maybe: Greeter | undefined = g;\nmaybe?.greet(true, "c");`);

  console.log('4b. constructor + super');
  const r2 = run(files, '/a.ts', 'constructor(public', [1, 0]);
  check('ctor decl', r2.out['/a.ts'].split('\n')[4], `export class Base { constructor(protected y: string, public x: number) {} }`);
  check('super()', r2.out['/a.ts'].split('\n')[5], `export class Derived extends Base { constructor() { super("y", 1); } }`);
  check('new', r2.out['/b.ts'].split('\n')[6], `const b = new Base("z", 5);`);
}

// 5 ── unsafe usages are reported, never silently broken ─────────────────────
{
  const files: Files = {
    '/a.ts': `export function f(a: number, b: string) { return a + b; }\n`,
    '/b.ts': `import { f } from './a';\nconst args: [number, string] = [1, "x"];\nf(...args);\n[1].map(f);\nconst alias = f;\nf(1, "ok");\n`,
  };
  const { out, res } = run(files, '/a.ts', 'f(', [1, 0]);
  console.log('5. blocked / unresolved reporting');
  check('only safe call changed', out['/b.ts'].split('\n')[5], `f("ok", 1);`);
  check('blocked count', String(res.blocked.length), '3');
}

// 6 ── `this` param, destructuring, generics, optional call, new ─────────────
{
  const files: Files = {
    '/a.ts': `export function h<T>(this: Window, { id, tag }: { id: number; tag: string }, items: T[], cb?: (x: T) => void) {}\n`,
    '/b.ts': `import { h } from './a';\nh.call(window, { id: 1, tag: "a" }, [1]);\nh<number>({ id: 1, tag: "a" }, [1, 2], (x) => x);\n(h as any)?.({ id: 2, tag: "b" }, []);\n`,
  };
  const { out } = run(files, '/a.ts', 'function h', [2, 0, 1]);
  console.log('6. this param / destructuring / generics');
  check('decl', out['/a.ts'], `export function h<T>(this: Window, cb?: (x: T) => void, { id, tag }: { id: number; tag: string }, items: T[]) {}`);
  check('generic call', out['/b.ts'].split('\n')[2], `h<number>((x) => x, { id: 1, tag: "a" }, [1, 2]);`);
}

// 7 ── cursor on a CALL site resolves through definitions (simulated) ────────
{
  const files: Files = {
    '/a.ts': `export const compute = (x: number, y: number, z: number) => x * y * z;\n`,
    '/b.ts': `import { compute } from './a';\nexport const v = compute(1, 2, 3);\n`,
  };
  console.log('7. side-effect order note');
  const files2: Files = {
    '/a.ts': `export function p(a: number, b: number) {}\n`,
    '/b.ts': `import { p } from './a';\nlet i = 0;\np(i++, i++);\np(1, 2);\n`,
  };
  const { res } = run(files2, '/a.ts', 'p(', [1, 0]);
  check('note emitted once', String(res.notes.length), '1');
  void files;
}

// 8 ── object literal methods & property signatures ─────────────────────────
{
  const files: Files = {
    '/a.ts': `export type Api = { send: (to: string, body: string) => void };
export const api: Api = { send(to, body) { console.log(to, body); } };
`,
    '/b.ts': `import { api } from './a';\napi.send("me", "hello");\n`,
  };
  const { out } = run(files, '/a.ts', 'send:', [1, 0]);
  console.log('8. property signature + object method');
  check('decls', out['/a.ts'], `export type Api = { send: (body: string, to: string) => void };\nexport const api: Api = { send(body, to) { console.log(to, body); } };`);
  check('call', out['/b.ts'].split('\n')[1], `api.send("hello", "me");`);
}

console.log(failed ? `\n${failed} FAILED` : '\nAll tests passed');
process.exit(failed ? 1 : 0);
