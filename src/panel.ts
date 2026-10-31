import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { ParamInfo } from './core';

export interface IssueView {
  label: string;
  uri: string;
  line: number;
  character: number;
  reason: string;
}

export interface ViewModel {
  name: string;
  kind: string;
  params: ParamInfo[];
  r: number;
  hasRest: boolean;
  stats: { calls: number; decls: number; files: number };
  usages: { label: string; uri: string; calls: number; decls: number }[];
  issues: IssueView[];
}

type ApplyHandler = (order: number[], preview: boolean) => Promise<{ ok: boolean; message?: string }>;

export class ReorderPanel {
  private static current: ReorderPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(ctx: vscode.ExtensionContext, model: ViewModel, preview: boolean, onApply: ApplyHandler): void {
    ReorderPanel.current?.panel.dispose();
    ReorderPanel.current = new ReorderPanel(ctx, model, preview, onApply);
  }

  private constructor(ctx: vscode.ExtensionContext, model: ViewModel, preview: boolean, onApply: ApplyHandler) {
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(
      'paramReorder',
      `Reorder: ${model.name}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true },
    );

    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    w.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${w.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'))}">
<title>Reorder parameters</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${w.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'))}"></script>
</body>
</html>`;

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      w.onDidReceiveMessage(async (m) => {
        switch (m?.type) {
          case 'ready':
            void w.postMessage({ type: 'init', model, preview });
            break;
          case 'cancel':
            this.panel.dispose();
            break;
          case 'open': {
            const uri = vscode.Uri.parse(String(m.uri));
            const pos = new vscode.Position(Number(m.line) || 0, Number(m.character) || 0);
            await vscode.window.showTextDocument(uri, {
              viewColumn: vscode.ViewColumn.One,
              selection: new vscode.Range(pos, pos),
              preserveFocus: true,
            });
            break;
          }
          case 'apply': {
            void w.postMessage({ type: 'busy', value: true });
            const res = await onApply(m.order, !!m.preview);
            if (res.ok) {
              this.panel.dispose();
            } else {
              void w.postMessage({ type: 'busy', value: false });
              if (res.message) void w.postMessage({ type: 'error', message: res.message });
            }
            break;
          }
        }
      }),
    );
  }

  private dispose(): void {
    if (ReorderPanel.current === this) ReorderPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
