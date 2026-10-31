# Parameter Reorder

Reorder a function's parameters in one dialog — every call site in the project is rewritten to match.

## Use

1. Put the cursor on a function (its name, its parameter list, or anywhere in its body) **or on a call to it**.
2. Press **Ctrl+Alt+R** (⌘⌥R on macOS) — or right-click → *Reorder Parameters…*, or use the 💡 lightbulb → *Reorder parameters…*.
3. Drag the parameters (or use the arrows / Alt+↑ Alt+↓), check the live *Before / After*, press **Apply refactor**.

Optionally tick *Preview changes before applying* to review every edit in VS Code's Refactor Preview.

## How it stays accurate

* References come from the TypeScript language server (the same engine as *Find All References*, Shift+Alt+F12), so aliases, re-exports, `import { f as g }`, class hierarchies, interface implementations and overloads are followed.
* Each parameter/argument is **moved as original text** — types, defaults, decorators, comments, line breaks stay intact. Nothing is re-printed.
* Supports any number of parameters, optional/default parameters, destructured parameters, a TS `this` parameter, generics, `new`, `super(...)`, `obj?.method()`, `fn!()`, nested calls like `f(f(1,2),3)`, methods, constructors, object-literal methods and function-typed properties.
* A trailing `...rest` parameter always stays last.
* Calls that omit trailing/optional arguments are handled (`undefined` is inserted only where a gap is unavoidable).
* Before writing, the result of each file is re-parsed; if any file would gain a syntax error, **nothing is changed**.
* Everything is one undoable edit per file (Ctrl+Z).

## What it will not touch (it tells you instead)

Spread calls `f(...args)`, functions passed as values (`arr.map(f)`, `const g = f`, `f.call(...)`), JSX usage, overloads/overrides whose parameter count differs, files in `node_modules`. These are listed in the dialog (click to jump) and you are asked before continuing.

## Notes

* Evaluation order: if reordered arguments contain calls / `await` / `++` the extension reports it (their evaluation order changes).
* JSDoc `@param` lines are not reordered.

## Settings

* `paramReorder.saveAfterApply` – save modified files automatically.
* `paramReorder.previewByDefault` – tick the preview checkbox by default.

## Build

```
npm install
npm test          # logic tests
npm run package   # produces param-reorder-1.0.0.vsix
```
