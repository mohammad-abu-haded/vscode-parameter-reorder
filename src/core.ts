/**
 * Pure logic of the extension. It does NOT import "vscode" so it can be tested
 * in plain Node. Everything works on TypeScript ASTs + character offsets.
 *
 * Strategy (why it is precise):
 *  - Parameters / arguments are never re-printed. We only SWAP the original
 *    source text of each item, so types, defaults, comments between items,
 *    formatting and decorators are preserved byte-for-byte.
 *  - Nested calls (f(f(1,2),3)) are handled by a recursive renderer, so edits
 *    never overlap.
 *  - Anything we can't prove is safe (spread args, callbacks, different
 *    overloads...) is reported instead of being silently changed.
 */
import * as ts from 'typescript';

// ───────────────────────── types ─────────────────────────

export type FnLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.MethodSignature
  | ts.ConstructorDeclaration
  | ts.FunctionTypeNode
  | ts.ConstructSignatureDeclaration
  | ts.CallSignatureDeclaration
  | ts.ConstructorTypeNode;

export type CallLike = ts.CallExpression | ts.NewExpression;

export interface ParamInfo {
  /** Original text (whitespace collapsed) e.g. "name: string" */
  text: string;
  /** Short label usable inside an example call, e.g. "name" or "arg2" */
  label: string;
  optional: boolean;
  hasInit: boolean;
  isRest: boolean;
  /** Identifiers this parameter introduces (handles destructuring) */
  bindings: string[];
  /** Identifiers read by its default value */
  initRefs: string[];
}

export interface FnShape {
  /** parameters excluding a TS `this` parameter */
  n: number;
  /** parameters that can be reordered (everything except a trailing rest) */
  r: number;
  hasRest: boolean;
}

export type RefClass =
  | { kind: 'decl'; fns: FnLike[] }
  | { kind: 'call'; call: CallLike }
  | { kind: 'ignore' }
  | { kind: 'unresolved'; reason: string };

export type Render = (start: number, end: number) => string;
export interface Op {
  start: number;
  end: number;
  build: (render: Render) => string;
}
export type Built = { ok: true; op?: Op; note?: string } | { ok: false; reason: string; pos: number };

export interface RefInput {
  fileName: string;
  text: string;
  offsets: number[];
}
export interface Blocked {
  fileName: string;
  pos: number;
  reason: string;
}
export interface Note {
  fileName: string;
  pos: number;
  text: string;
}
export interface FileAnalysis {
  fileName: string;
  text: string;
  sf: ts.SourceFile;
  decls: Set<FnLike>;
  calls: Set<CallLike>;
  blocked: Blocked[];
}
export interface Analysis {
  files: Map<string, FileAnalysis>;
  shape: FnShape;
  primary: FnLike;
}
export interface Edit {
  start: number;
  end: number;
  newText: string;
}
export interface EditResult {
  edits: Map<string, Edit[]>;
  blocked: Blocked[];
  notes: Note[];
  decls: number;
  calls: number;
  perFile: Map<string, { decls: number; calls: number }>;
}

// ───────────────────────── basics ─────────────────────────

export const SUPPORTED_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

export function parseSource(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
}

export function isFnLike(n: ts.Node): n is FnLike {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isMethodSignature(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isFunctionTypeNode(n) ||
    ts.isConstructSignatureDeclaration(n) ||
    ts.isCallSignatureDeclaration(n) ||
    ts.isConstructorTypeNode(n)
  );
}

export function isNameLike(n: ts.Node): n is ts.Identifier | ts.PrivateIdentifier | ts.StringLiteral {
  return ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || ts.isStringLiteral(n);
}

function unwrapExpr(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** Deepest node that contains `pos`. */
export function tokenAt(sf: ts.SourceFile, pos: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, (child) => {
      if (child.getStart(sf) <= pos && pos < child.end) {
        found = child;
        visit(child);
        return true;
      }
      return undefined;
    });
  };
  visit(sf);
  return found;
}

export function paramsOf(fn: FnLike): ts.ParameterDeclaration[] {
  return fn.parameters.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'));
}

export function shapeOf(fn: FnLike): FnShape {
  const ps = paramsOf(fn);
  const hasRest = ps.length > 0 && !!ps[ps.length - 1].dotDotDotToken;
  return { n: ps.length, r: ps.length - (hasRest ? 1 : 0), hasRest };
}

function collectBindings(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) collectBindings(el.name, out);
  }
}

export function describeParams(fn: FnLike, sf: ts.SourceFile): ParamInfo[] {
  return paramsOf(fn).map((p, i) => {
    const bindings: string[] = [];
    collectBindings(p.name, bindings);
    const initRefs: string[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
        initRefs.push(n.text);
      }
      ts.forEachChild(n, walk);
    };
    if (p.initializer) walk(p.initializer);
    return {
      text: p.getText(sf).replace(/\s+/g, ' '),
      label: ts.isIdentifier(p.name) ? p.name.text : `arg${i + 1}`,
      optional: !!p.questionToken,
      hasInit: !!p.initializer,
      isRest: !!p.dotDotDotToken,
      bindings,
      initRefs,
    };
  });
}

/** A stable fingerprint used to detect that the signature changed while the dialog was open. */
export function signatureKey(fn: FnLike, sf: ts.SourceFile): string {
  return paramsOf(fn)
    .map((p) => p.getText(sf))
    .join('\u0001');
}

// ───────────────────── finding the target function ─────────────────────

/** `const f = (a,b)=>{}`, `{ f(a,b){} }`, `f: (a,b)=>void` ... name → function-like(s). */
export function fnsDeclaredBy(name: ts.Node): FnLike[] | undefined {
  const p = name.parent;
  if (!p) return undefined;
  if (
    (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p)) &&
    p.name === name
  ) {
    return [p];
  }
  if (
    (ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) &&
    p.name === name
  ) {
    const res: FnLike[] = [];
    const init = (p as { initializer?: ts.Expression }).initializer;
    if (init) {
      const u = unwrapExpr(init);
      if (ts.isArrowFunction(u) || ts.isFunctionExpression(u)) res.push(u);
    }
    const t = (p as { type?: ts.TypeNode }).type;
    if (t && ts.isFunctionTypeNode(t)) res.push(t);
    return res.length ? res : undefined;
  }
  return undefined;
}

function headerEnd(fn: FnLike, sf: ts.SourceFile): number {
  const body = (fn as { body?: ts.Node }).body;
  return body ? body.getStart(sf) : fn.end;
}

/** Function whose *signature* (name / parameter list / return type) contains `pos`. */
export function findFunctionAtHeader(sf: ts.SourceFile, pos: number): FnLike | undefined {
  const tok = tokenAt(sf, pos);
  if (!tok) return undefined;
  if (isNameLike(tok)) {
    const d = fnsDeclaredBy(tok);
    if (d) return d[0];
    // class name → its constructor
    const par = tok.parent;
    if (par && ts.isClassDeclaration(par) && par.name === tok) {
      const ctor = par.members.find(ts.isConstructorDeclaration);
      if (ctor) return ctor;
    }
  }
  for (let n: ts.Node | undefined = tok; n && n !== sf; n = n.parent) {
    if (isFnLike(n) && pos < headerEnd(n, sf)) return n;
  }
  return undefined;
}

/** Nearest enclosing function we are able to track references for. */
export function findEnclosingWithAnchor(sf: ts.SourceFile, pos: number): FnLike | undefined {
  const tok = tokenAt(sf, pos);
  for (let n: ts.Node | undefined = tok; n && n !== sf; n = n.parent) {
    if (isFnLike(n) && anchorNode(n, sf)) return n;
  }
  return undefined;
}

/**
 * The token we ask the language server to "Find All References" on:
 * the function's name, the variable it is assigned to, or `constructor`.
 */
export function anchorNode(fn: FnLike, sf: ts.SourceFile): ts.Node | undefined {
  if (ts.isConstructorDeclaration(fn)) {
    return fn.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.ConstructorKeyword);
  }
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    let cur: ts.Node = fn;
    while (
      cur.parent &&
      (ts.isParenthesizedExpression(cur.parent) ||
        ts.isAsExpression(cur.parent) ||
        ts.isNonNullExpression(cur.parent) ||
        ts.isTypeAssertionExpression(cur.parent) ||
        ts.isSatisfiesExpression(cur.parent))
    ) {
      cur = cur.parent;
    }
    const p = cur.parent;
    if (
      p &&
      (ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p)) &&
      p.initializer === cur &&
      isNameLike(p.name)
    ) {
      return p.name;
    }
    if (ts.isFunctionExpression(fn) && fn.name) return fn.name;
    return undefined;
  }
  if (ts.isFunctionTypeNode(fn)) {
    const p = fn.parent;
    if (
      p &&
      (ts.isPropertySignature(p) || ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p)) &&
      p.type === fn &&
      isNameLike(p.name)
    ) {
      return p.name;
    }
    return undefined;
  }
  if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isMethodSignature(fn)) {
    return fn.name && (isNameLike(fn.name) || ts.isComputedPropertyName(fn.name)) ? fn.name : undefined;
  }
  return undefined;
}

export function displayName(fn: FnLike, sf: ts.SourceFile): { name: string; kind: string } {
  if (ts.isConstructorDeclaration(fn)) {
    const c = fn.parent;
    const cn = c && ts.isClassLike(c) && c.name ? c.name.text : 'class';
    return { name: `new ${cn}`, kind: 'constructor' };
  }
  const a = anchorNode(fn, sf);
  const name = a ? a.getText(sf).replace(/^["']|["']$/g, '') : '(anonymous)';
  const kind = ts.isMethodDeclaration(fn) || ts.isMethodSignature(fn) ? 'method' : 'function';
  return { name, kind };
}

export function findFnAtStart(sf: ts.SourceFile, start: number): FnLike | undefined {
  let found: FnLike | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (isFnLike(n) && n.getStart(sf) === start) {
      found = n;
      return;
    }
    if (n.getStart(sf) <= start && start < n.end) ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

// ───────────────────── classifying a reference ─────────────────────

export function classifyReference(sf: ts.SourceFile, pos: number): RefClass {
  const tok = tokenAt(sf, pos);
  if (!tok) return { kind: 'ignore' }; // comment / whitespace
  if (tok.flags & ts.NodeFlags.JSDoc) return { kind: 'ignore' };

  if (ts.isConstructorDeclaration(tok)) return { kind: 'decl', fns: [tok] };

  if (tok.kind === ts.SyntaxKind.SuperKeyword) {
    const par = tok.parent;
    if (par && ts.isCallExpression(par) && par.expression === tok) return { kind: 'call', call: par };
    return { kind: 'unresolved', reason: '`super` is used in a way that cannot be rewritten automatically' };
  }

  if (!isNameLike(tok)) {
    return { kind: 'unresolved', reason: `Unsupported syntax at reference (${ts.SyntaxKind[tok.kind]})` };
  }

  const declared = fnsDeclaredBy(tok);
  if (declared) return { kind: 'decl', fns: declared };

  const p = tok.parent;
  if (!p) return { kind: 'ignore' };

  // ── references that are not usages of the call signature ──
  if (
    ts.isImportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    ts.isExportSpecifier(p) ||
    ts.isImportEqualsDeclaration(p) ||
    ts.isExportAssignment(p) ||
    ts.isNamespaceExport(p) ||
    ts.isTypeReferenceNode(p) ||
    ts.isTypeQueryNode(p) ||
    ts.isQualifiedName(p) ||
    ts.isExpressionWithTypeArguments(p) ||
    ts.isImportTypeNode(p) ||
    ((ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name === tok) ||
    (ts.isStringLiteral(tok) && (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p)))
  ) {
    return { kind: 'ignore' };
  }

  // ── calls ──
  let e: ts.Node = tok;
  if (ts.isPropertyAccessExpression(p) && p.name === tok) e = p;
  else if (ts.isElementAccessExpression(p) && p.argumentExpression === tok) e = p;
  while (e.parent && (ts.isParenthesizedExpression(e.parent) || ts.isNonNullExpression(e.parent))) e = e.parent;
  const par = e.parent;
  if (par && (ts.isCallExpression(par) || ts.isNewExpression(par)) && par.expression === e) {
    return { kind: 'call', call: par };
  }

  if (
    (ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) &&
    p.name === tok
  ) {
    return { kind: 'unresolved', reason: 'Declaration whose parameter list is not written inline (type defined elsewhere)' };
  }
  return {
    kind: 'unresolved',
    reason: 'Used as a value (callback, alias, assignment, `.call/.apply`, JSX…) — cannot be updated automatically',
  };
}

// ───────────────────── building edit operations ─────────────────────

function hasSideEffects(n: ts.Node): boolean {
  if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return false;
  if (
    ts.isCallExpression(n) ||
    ts.isNewExpression(n) ||
    ts.isAwaitExpression(n) ||
    ts.isYieldExpression(n) ||
    ts.isTaggedTemplateExpression(n) ||
    ts.isDeleteExpression(n) ||
    ts.isPostfixUnaryExpression(n)
  ) {
    return true;
  }
  if (
    ts.isPrefixUnaryExpression(n) &&
    (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  if (
    ts.isBinaryExpression(n) &&
    n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return true;
  }
  return ts.forEachChild(n, (c) => (hasSideEffects(c) ? true : undefined)) === true;
}

export function buildDeclOp(sf: ts.SourceFile, fn: FnLike, order: number[], shape: FnShape): Built {
  const s = shapeOf(fn);
  if (s.n !== shape.n || s.hasRest !== shape.hasRest) {
    return {
      ok: false,
      pos: fn.getStart(sf),
      reason: `Declaration has ${s.n} parameter(s) but the target has ${shape.n} (overload / override with a different signature)`,
    };
  }
  if (shape.r < 2) return { ok: true };
  const ps = paramsOf(fn).slice(0, shape.r);
  const op: Op = {
    start: ps[0].getStart(sf),
    end: ps[ps.length - 1].end,
    build: (render) => {
      const texts = ps.map((p) => render(p.getStart(sf), p.end));
      let out = '';
      for (let i = 0; i < ps.length; i++) {
        out += texts[order[i]];
        if (i < ps.length - 1) out += render(ps[i].end, ps[i + 1].getStart(sf));
      }
      return out;
    },
  };
  return { ok: true, op };
}

export function buildCallOp(sf: ts.SourceFile, call: CallLike, order: number[], shape: FnShape): Built {
  const args = call.arguments ? Array.from(call.arguments) : [];
  const k = Math.min(args.length, shape.r);
  if (k === 0 || shape.r < 2) return { ok: true };

  for (let i = 0; i < k; i++) {
    if (ts.isSpreadElement(args[i])) {
      return {
        ok: false,
        pos: args[i].getStart(sf),
        reason: 'Call uses a spread argument (...x), so argument positions are unknown',
      };
    }
  }

  // Number of argument slots needed in the new order (missing args in the middle become `undefined`).
  let L = 0;
  for (let p = 0; p < order.length; p++) if (order[p] < k) L = p + 1;

  // Warn when argument expressions with side effects change evaluation order.
  const moved: number[] = [];
  for (let p = 0; p < L; p++) {
    const src = order[p];
    if (src < k && hasSideEffects(args[src])) moved.push(src);
  }
  let note: string | undefined;
  for (let i = 1; i < moved.length; i++) {
    if (moved[i] < moved[i - 1]) {
      note = 'Arguments with side effects (calls, await, ++ …) now evaluate in a different order';
      break;
    }
  }

  const op: Op = {
    start: args[0].getStart(sf),
    end: args[k - 1].end,
    build: (render) => {
      const texts = args.slice(0, k).map((a) => render(a.getStart(sf), a.end));
      const seps: string[] = [];
      for (let i = 0; i < k - 1; i++) seps.push(render(args[i].end, args[i + 1].getStart(sf)));
      let out = '';
      for (let p = 0; p < L; p++) {
        const src = order[p];
        out += src < k ? texts[src] : 'undefined';
        if (p < L - 1) out += p < k - 1 ? seps[p] : ', ';
      }
      return out;
    },
  };
  return { ok: true, op, note };
}

// ───────────────────── renderer (handles nesting) ─────────────────────

function lowerBound(ops: Op[], start: number): number {
  let lo = 0;
  let hi = ops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ops[mid].start < start) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function makeRender(text: string, ops: Op[]): { render: Render; buildTop: (op: Op) => string } {
  // Ops currently being built. An op whose range equals one of its own children
  // (e.g. a call with a single argument) must not re-enter itself.
  const active = new Set<Op>();
  const render: Render = (a, b) => {
    let cur = a;
    let out = '';
    for (let i = lowerBound(ops, a); i < ops.length && ops[i].start < b; i++) {
      const op = ops[i];
      if (op.start < cur || op.end > b || active.has(op)) continue; // nested in an op already emitted
      active.add(op);
      try {
        out += text.slice(cur, op.start) + op.build(render);
      } finally {
        active.delete(op);
      }
      cur = op.end;
    }
    return out + text.slice(cur, b);
  };
  /** Build a top-level op (guarded exactly like nested ones). */
  const buildTop = (op: Op): string => {
    active.add(op);
    try {
      return op.build(render);
    } finally {
      active.delete(op);
    }
  };
  return { render, buildTop };
}

// ───────────────────── analysis + edit computation ─────────────────────

export function analyze(inputs: RefInput[], primary: { fileName: string; fnStart: number }): Analysis {
  const merged = new Map<string, { text: string; offsets: Set<number> }>();
  for (const inp of inputs) {
    let m = merged.get(inp.fileName);
    if (!m) merged.set(inp.fileName, (m = { text: inp.text, offsets: new Set() }));
    inp.offsets.forEach((o) => m!.offsets.add(o));
  }
  if (!merged.has(primary.fileName)) throw new Error('Primary file text was not provided');

  const files = new Map<string, FileAnalysis>();
  for (const [fileName, m] of merged) {
    files.set(fileName, {
      fileName,
      text: m.text,
      sf: parseSource(fileName, m.text),
      decls: new Set(),
      calls: new Set(),
      blocked: [],
    });
  }

  const pf = files.get(primary.fileName)!;
  const primaryFn = findFnAtStart(pf.sf, primary.fnStart);
  if (!primaryFn) throw new Error('Could not locate the function any more — the file changed. Please run the command again.');
  pf.decls.add(primaryFn);

  for (const [fileName, m] of merged) {
    const fa = files.get(fileName)!;
    for (const off of m.offsets) {
      const c = classifyReference(fa.sf, off);
      if (c.kind === 'decl') c.fns.forEach((f) => fa.decls.add(f));
      else if (c.kind === 'call') fa.calls.add(c.call);
      else if (c.kind === 'unresolved') fa.blocked.push({ fileName, pos: off, reason: c.reason });
    }
  }
  return { files, shape: shapeOf(primaryFn), primary: primaryFn };
}

export function computeEdits(an: Analysis, order: number[]): EditResult {
  const res: EditResult = { edits: new Map(), blocked: [], notes: [], decls: 0, calls: 0, perFile: new Map() };

  for (const fa of an.files.values()) {
    res.blocked.push(...fa.blocked);
    const ops: Op[] = [];
    let d = 0;
    let c = 0;

    for (const fn of fa.decls) {
      const b = buildDeclOp(fa.sf, fn, order, an.shape);
      if (!b.ok) res.blocked.push({ fileName: fa.fileName, pos: b.pos, reason: b.reason });
      else {
        d++;
        if (b.op) ops.push(b.op);
      }
    }
    for (const call of fa.calls) {
      const b = buildCallOp(fa.sf, call, order, an.shape);
      if (!b.ok) res.blocked.push({ fileName: fa.fileName, pos: b.pos, reason: b.reason });
      else {
        c++;
        if (b.op) ops.push(b.op);
        if (b.note) res.notes.push({ fileName: fa.fileName, pos: call.getStart(fa.sf), text: b.note });
      }
    }

    if (d + c > 0) res.perFile.set(fa.fileName, { decls: d, calls: c });
    res.decls += d;
    res.calls += c;

    // outer first when starting at the same offset
    ops.sort((x, y) => x.start - y.start || y.end - x.end);
    const uniq = ops.filter((o, i) => i === 0 || o.start !== ops[i - 1].start || o.end !== ops[i - 1].end);
    const { buildTop } = makeRender(fa.text, uniq);

    const edits: Edit[] = [];
    let cur = -1;
    for (const op of uniq) {
      if (op.start < cur) continue; // nested → produced by its parent's build()
      const newText = buildTop(op);
      if (newText !== fa.text.slice(op.start, op.end)) edits.push({ start: op.start, end: op.end, newText });
      cur = op.end;
    }
    if (edits.length) res.edits.set(fa.fileName, edits);
  }
  return res;
}

// ───────────────────── safety helpers ─────────────────────

export function applyEditsToText(text: string, edits: Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  }
  return out;
}

export function syntaxErrorCount(fileName: string, text: string): number {
  const sf = parseSource(fileName, text) as ts.SourceFile & { parseDiagnostics?: unknown[] };
  return sf.parseDiagnostics?.length ?? 0;
}

export function isPermutation(order: unknown, r: number): order is number[] {
  if (!Array.isArray(order) || order.length !== r) return false;
  const seen = new Set<number>();
  for (const v of order) {
    if (!Number.isInteger(v) || v < 0 || v >= r || seen.has(v)) return false;
    seen.add(v);
  }
  return true;
}
