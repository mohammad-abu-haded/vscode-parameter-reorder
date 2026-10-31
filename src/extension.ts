import * as vscode from 'vscode';
import * as path from 'path';
import * as core from './core';
import { ReorderPanel, ViewModel, IssueView } from './panel';

const LANGS = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'];
let log: vscode.OutputChannel;

export function activate(ctx: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('Parameter Reorder');
  ctx.subscriptions.push(
    log,
    vscode.commands.registerCommand('paramReorder.reorder', () => run(ctx)),
    vscode.languages.registerCodeActionsProvider(
      LANGS.map((language) => ({ language })),
      new ReorderCodeActions(),
      { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] },
    ),
  );
}

export function deactivate(): void {}

// ───────────────────────── code action (lightbulb) ─────────────────────────

class ReorderCodeActions implements vscode.CodeActionProvider {
  private cache = new Map<string, { version: number; sf: ReturnType<typeof core.parseSource> }>();

  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const key = doc.uri.toString();
    let entry = this.cache.get(key);
    if (!entry || entry.version !== doc.version) {
      entry = { version: doc.version, sf: core.parseSource(key, doc.getText()) };
      this.cache.set(key, entry);
    }
    const fn = core.findFunctionAtHeader(entry.sf, doc.offsetAt(range.start));
    if (!fn || core.shapeOf(fn).r < 2 || !core.anchorNode(fn, entry.sf)) return [];
    const action = new vscode.CodeAction('Reorder parameters…', vscode.CodeActionKind.RefactorRewrite);
    action.command = { command: 'paramReorder.reorder', title: 'Reorder parameters…' };
    return [action];
  }
}

// ───────────────────────── helpers ─────────────────────────

const docCache = new Map<string, vscode.TextDocument>();

async function openDoc(uri: vscode.Uri): Promise<vscode.TextDocument> {
  const key = uri.toString();
  const hit = docCache.get(key);
  if (hit && !hit.isClosed) return hit;
  const d = await vscode.workspace.openTextDocument(uri);
  docCache.set(key, d);
  return d;
}

function isExternal(uri: vscode.Uri): string | undefined {
  const p = uri.path.replace(/\\/g, '/');
  if (p.includes('/node_modules/')) return 'Inside node_modules — cannot be edited';
  if (!core.SUPPORTED_FILE.test(p)) return 'Unsupported file type (only .ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs)';
  return undefined;
}

function relPath(uri: vscode.Uri): string {
  const f = vscode.workspace.getWorkspaceFolder(uri);
  return f ? path.relative(f.uri.fsPath, uri.fsPath).replace(/\\/g, '/') : path.basename(uri.fsPath);
}

function fail(message: string): void {
  void vscode.window.showErrorMessage(`Parameter Reorder: ${message}`);
}

async function ensureTsServer(): Promise<void> {
  const ext = vscode.extensions.getExtension('vscode.typescript-language-features');
  if (ext && !ext.isActive) await ext.activate();
}

// ───────────────────────── resolving the target ─────────────────────────

interface Target {
  uri: vscode.Uri;
  doc: vscode.TextDocument;
  fnStart: number;
  anchor: number;
}

async function resolveTarget(editor: vscode.TextEditor): Promise<Target | string> {
  const doc = editor.document;
  const pos = editor.selection.active;
  const offset = doc.offsetAt(pos);
  const sf = core.parseSource(doc.uri.toString(), doc.getText());

  let fnDoc = doc;
  let fnSf = sf;
  let fn = core.findFunctionAtHeader(sf, offset);

  // Cursor on a call / reference → follow it to the declaration.
  if (!fn) {
    const tok = core.tokenAt(sf, offset);
    if (tok && core.isNameLike(tok)) {
      type Def = vscode.Location | vscode.LocationLink;
      const defs = (await vscode.commands.executeCommand<Def[]>('vscode.executeDefinitionProvider', doc.uri, pos)) ?? [];
      for (const d of defs) {
        const uri = 'targetUri' in d ? d.targetUri : d.uri;
        const range = 'targetUri' in d ? (d.targetSelectionRange ?? d.targetRange) : d.range;
        if (isExternal(uri)) continue;
        const dd = await openDoc(uri);
        const ds = core.parseSource(uri.toString(), dd.getText());
        const f = core.findFunctionAtHeader(ds, dd.offsetAt(range.start));
        if (f) {
          fn = f;
          fnDoc = dd;
          fnSf = ds;
          break;
        }
      }
    }
  }

  // Cursor inside a function body → that function.
  if (!fn) {
    fn = core.findEnclosingWithAnchor(sf, offset);
    fnDoc = doc;
    fnSf = sf;
  }

  if (!fn) return 'Place the cursor on a function name, its parameter list, or a call to it.';
  const ext = isExternal(fnDoc.uri);
  if (ext) return `The function is declared in a file that cannot be edited (${ext}).`;
  const anchor = core.anchorNode(fn, fnSf);
  if (!anchor) {
    return "This function has no name that references can be traced from (anonymous callback). Assign it to a variable first.";
  }
  if (core.shapeOf(fn).r < 2) return 'The function needs at least two reorderable parameters (a trailing ...rest parameter always stays last).';

  return { uri: fnDoc.uri, doc: fnDoc, fnStart: fn.getStart(fnSf), anchor: anchor.getStart(fnSf) };
}

// ───────────────────────── gathering references ─────────────────────────

interface Gathered {
  inputs: core.RefInput[];
  docs: Map<string, vscode.TextDocument>;
  external: IssueView[];
}

async function gather(t: Target): Promise<Gathered> {
  await ensureTsServer();
  const anchorPos = t.doc.positionAt(t.anchor);
  const locs =
    (await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', t.uri, anchorPos)) ?? [];

  const docs = new Map<string, vscode.TextDocument>();
  const offsets = new Map<string, Set<number>>();
  const external: IssueView[] = [];
  const seen = new Set<string>();

  for (const loc of locs) {
    const key = `${loc.uri.toString()}#${loc.range.start.line}:${loc.range.start.character}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const why = isExternal(loc.uri);
    if (why) {
      external.push({
        label: `${relPath(loc.uri)}:${loc.range.start.line + 1}`,
        uri: loc.uri.toString(),
        line: loc.range.start.line,
        character: loc.range.start.character,
        reason: why,
      });
      continue;
    }
    const d = await openDoc(loc.uri);
    docs.set(loc.uri.toString(), d);
    if (!offsets.has(loc.uri.toString())) offsets.set(loc.uri.toString(), new Set());
    offsets.get(loc.uri.toString())!.add(d.offsetAt(loc.range.start));
  }

  // the primary file must always be present (even if the server returned nothing)
  docs.set(t.uri.toString(), t.doc);
  if (!offsets.has(t.uri.toString())) offsets.set(t.uri.toString(), new Set());

  if (locs.length === 0) {
    throw new Error('The TypeScript language server returned no references. Wait for it to finish loading the project and try again.');
  }

  const inputs: core.RefInput[] = [];
  for (const [key, set] of offsets) {
    inputs.push({ fileName: key, text: docs.get(key)!.getText(), offsets: [...set] });
  }
  return { inputs, docs, external };
}

function toIssue(g: Gathered, b: core.Blocked): IssueView {
  const d = g.docs.get(b.fileName)!;
  const p = d.positionAt(b.pos);
  return { label: `${relPath(d.uri)}:${p.line + 1}`, uri: d.uri.toString(), line: p.line, character: p.character, reason: b.reason };
}

// ───────────────────────── main flow ─────────────────────────

async function run(ctx: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !LANGS.includes(editor.document.languageId)) {
    fail('Open a TypeScript or JavaScript file first.');
    return;
  }

  try {
    const prepared = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Parameter Reorder: finding all references…' },
      async () => {
        const t = await resolveTarget(editor);
        if (typeof t === 'string') {
          fail(t);
          return undefined;
        }
        const g = await gather(t);
        const an = core.analyze(g.inputs, { fileName: t.uri.toString(), fnStart: t.fnStart });
        const ident = Array.from({ length: an.shape.r }, (_, i) => i);
        const res = core.computeEdits(an, ident);
        const pf = an.files.get(t.uri.toString())!;
        const { name, kind } = core.displayName(an.primary, pf.sf);

        const usages = [...res.perFile].map(([file, c]) => {
          const d = g.docs.get(file)!;
          return { label: relPath(d.uri), uri: d.uri.toString(), calls: c.calls, decls: c.decls };
        });
        const model: ViewModel = {
          name,
          kind,
          params: core.describeParams(an.primary, pf.sf),
          r: an.shape.r,
          hasRest: an.shape.hasRest,
          stats: { calls: res.calls, decls: res.decls, files: usages.length },
          usages,
          issues: [...g.external, ...res.blocked.map((b) => toIssue(g, b))],
        };
        return { t, model, key: core.signatureKey(an.primary, pf.sf) };
      },
    );
    if (!prepared) return;

    const { t, model, key } = prepared;
    const preview = vscode.workspace.getConfiguration('paramReorder').get<boolean>('previewByDefault', false);
    ReorderPanel.show(ctx, model, preview, (order, wantPreview) => apply(t, key, order, wantPreview));
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

async function apply(
  t: Target,
  expectedKey: string,
  order: number[],
  preview: boolean,
): Promise<{ ok: boolean; message?: string }> {
  try {
    // Everything is recomputed from the current state of the workspace.
    const doc = await openDoc(t.uri);
    const g = await gather({ ...t, doc });
    const an = core.analyze(g.inputs, { fileName: t.uri.toString(), fnStart: t.fnStart });
    const pf = an.files.get(t.uri.toString())!;

    if (core.signatureKey(an.primary, pf.sf) !== expectedKey) {
      return { ok: false, message: 'The function signature changed while this window was open. Close it and run the command again.' };
    }
    if (!core.isPermutation(order, an.shape.r)) return { ok: false, message: 'Invalid parameter order.' };

    const res = core.computeEdits(an, order);
    if (res.edits.size === 0) return { ok: false, message: 'Nothing to change — the order is the same as before.' };

    // Anything we could not prove safe → ask first.
    const problems = [...g.external, ...res.blocked.map((b) => toIssue(g, b))];
    if (problems.length) {
      log.appendLine('— Locations that need manual attention —');
      problems.forEach((p) => log.appendLine(`${p.label}  ${p.reason}`));
      const choice = await vscode.window.showWarningMessage(
        `${problems.length} location(s) cannot be updated automatically and will be left untouched. Apply the refactor to the rest?`,
        { modal: true, detail: problems.slice(0, 12).map((p) => `• ${p.label} — ${p.reason}`).join('\n') + (problems.length > 12 ? '\n…' : '') },
        'Apply to the rest',
      );
      if (choice !== 'Apply to the rest') return { ok: false, message: 'Cancelled.' };
    }

    // Safety net: refuse to write if any file would get a new syntax error.
    for (const [file, edits] of res.edits) {
      const before = g.docs.get(file)!.getText();
      const after = core.applyEditsToText(before, edits);
      if (core.syntaxErrorCount(file, after) > core.syntaxErrorCount(file, before)) {
        return { ok: false, message: `Aborted: the rewrite would introduce a syntax error in ${relPath(g.docs.get(file)!.uri)}. Nothing was changed.` };
      }
    }

    const we = new vscode.WorkspaceEdit();
    const meta: vscode.WorkspaceEditEntryMetadata = { label: 'Reorder parameters', needsConfirmation: preview };
    for (const [file, edits] of res.edits) {
      const d = g.docs.get(file)!;
      for (const e of edits) {
        we.replace(d.uri, new vscode.Range(d.positionAt(e.start), d.positionAt(e.end)), e.newText, meta);
      }
    }
    const applied = await vscode.workspace.applyEdit(we);
    if (!applied) return { ok: false, message: 'VS Code rejected the edit (cancelled or a file is read-only). Nothing was changed.' };

    if (vscode.workspace.getConfiguration('paramReorder').get<boolean>('saveAfterApply', false)) {
      for (const file of res.edits.keys()) await g.docs.get(file)!.save();
    }

    log.appendLine(`Reordered parameters → ${res.calls} call site(s), ${res.decls} declaration(s), ${res.edits.size} file(s).`);
    if (res.notes.length) {
      log.appendLine('— Notes —');
      for (const n of res.notes) {
        const d = g.docs.get(n.fileName)!;
        log.appendLine(`${relPath(d.uri)}:${d.positionAt(n.pos).line + 1}  ${n.text}`);
      }
    }
    const summary = `Parameters reordered: ${res.calls} call site(s) and ${res.decls} declaration(s) updated in ${res.edits.size} file(s).`;
    const extra = res.notes.length ? ` ${res.notes.length} call(s) have arguments with side effects whose evaluation order changed.` : '';
    void vscode.window.showInformationMessage(summary + extra, 'Show details').then((c) => {
      if (c) log.show(true);
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
