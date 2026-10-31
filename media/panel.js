/* global acquireVsCodeApi */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  /** @type {any} */ let model = null;
  /** order[p] = original index of the parameter shown at position p */
  let order = [];
  let busy = false;
  let previewChecked = false;
  let errorMessage = '';
  let focusPos = -1;
  let flashPos = -1;
  let dragFrom = null;
  let dropMark = null;

  // ── tiny DOM helper ───────────────────────────────────────────────
  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // ── state helpers ─────────────────────────────────────────────────
  const isIdentity = () => order.every((v, i) => v === i);

  function move(from, to) {
    if (from === to || to < 0 || to >= order.length) return;
    const [x] = order.splice(from, 1);
    order.splice(to, 0, x);
    focusPos = to;
    flashPos = to;
    errorMessage = '';
    render();
  }

  function reset() {
    order = model.params.slice(0, model.r).map((_, i) => i);
    errorMessage = '';
    focusPos = -1;
    render();
  }

  /** Parameters in their new order, with the trailing rest parameter (if any) kept last. */
  function newParams() {
    const list = order.map((i) => model.params[i]);
    if (model.hasRest) list.push(model.params[model.r]);
    return list;
  }

  function callExample(list) {
    const args = list.map((p, i) => (p.isRest ? '...' + p.label : p.label));
    const prefix = model.kind === 'constructor' ? model.name : model.name;
    return `${prefix}(${args.join(', ')})`;
  }

  function signature(list) {
    return `${model.name}(${list.map((p) => p.text).join(', ')})`;
  }

  // ── warnings (computed from the chosen order) ─────────────────────
  function warnings() {
    const out = [];
    const list = order.map((i) => model.params[i]);
    let firstOptional = null;
    list.forEach((p, pos) => {
      if (p.optional && !firstOptional) firstOptional = p;
      else if (firstOptional && !p.optional && !p.hasInit) {
        out.push(`“${p.label}” is required but now comes after the optional “${firstOptional.label}” — TypeScript reports an error for that.`);
      }
      for (const ref of p.initRefs) {
        const q = list.findIndex((o) => o !== p && o.bindings.includes(ref));
        if (q > pos) out.push(`The default value of “${p.label}” reads “${ref}”, which would now be declared after it.`);
      }
    });
    if (model.hasRest) {
      // informational: rest param is locked
    }
    return [...new Set(out)];
  }

  // ── rendering ─────────────────────────────────────────────────────
  function render() {
    if (!model) return;
    const warn = warnings();
    const changed = !isIdentity();
    const after = newParams();
    const before = model.params;

    const header = h(
      'header',
      null,
      h('h1', null, model.name, h('small', { text: model.kind })),
      h(
        'p',
        { class: 'summary' },
        'Found ',
        h('b', { text: plural(model.stats.calls, 'call site', 'call sites') }),
        ' and ',
        h('b', { text: plural(model.stats.decls, 'declaration', 'declarations') }),
        ' in ',
        h('b', { text: plural(model.stats.files, 'file', 'files') }),
        '.',
      ),
      model.usages.length
        ? h(
            'details',
            { class: 'usages' },
            h('summary', { text: 'Show files' }),
            h(
              'ul',
              null,
              model.usages.map((u) =>
                h(
                  'li',
                  null,
                  h('button', { class: 'linklike', text: u.label, onclick: () => vscode.postMessage({ type: 'open', uri: u.uri, line: 0, character: 0 }) }),
                  h('span', { class: 'count', text: [u.calls ? plural(u.calls, 'call', 'calls') : '', u.decls ? plural(u.decls, 'declaration', 'declarations') : ''].filter(Boolean).join(', ') }),
                ),
              ),
            ),
          )
        : null,
    );

    // parameter list
    const list = h('ol', { class: 'params', 'aria-label': 'Parameters. Drag to reorder, or focus one and press Alt+Up / Alt+Down.' });
    order.forEach((orig, pos) => {
      const p = model.params[orig];
      const moved = orig !== pos;
      const li = h(
        'li',
        { class: 'param' + (pos === flashPos ? ' flash' : ''), draggable: 'true', tabindex: '0', 'data-pos': pos },
        h('span', { class: 'grip', text: '⋮⋮', 'aria-hidden': 'true' }),
        h('span', { class: 'pos', text: String(pos + 1) }),
        h('span', { class: 'ptext', text: p.text }),
        h(
          'span',
          { class: 'tags' },
          p.optional ? h('span', { class: 'tag', text: 'optional' }) : null,
          p.hasInit ? h('span', { class: 'tag', text: 'default' }) : null,
          moved ? h('span', { class: 'tag moved', text: `was ${orig + 1}` }) : null,
        ),
        h(
          'span',
          { class: 'arrows' },
          h('button', { title: 'Move up', 'aria-label': `Move ${p.label} up`, text: '▲', disabled: pos === 0, onclick: () => move(pos, pos - 1) }),
          h('button', { title: 'Move down', 'aria-label': `Move ${p.label} down`, text: '▼', disabled: pos === order.length - 1, onclick: () => move(pos, pos + 1) }),
        ),
      );

      li.addEventListener('keydown', (e) => {
        if (e.target !== li) return;
        if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); move(pos, pos - 1); }
        else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); move(pos, pos + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); list.children[pos - 1]?.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); list.children[pos + 1]?.focus(); }
      });
      li.addEventListener('dragstart', (e) => {
        dragFrom = pos;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(pos));
        requestAnimationFrame(() => li.classList.add('dragging'));
      });
      li.addEventListener('dragover', (e) => {
        if (dragFrom === null) return;
        e.preventDefault();
        const r = li.getBoundingClientRect();
        const afterHalf = e.clientY > r.top + r.height / 2;
        list.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
        li.classList.add(afterHalf ? 'drop-after' : 'drop-before');
        dropMark = { pos, after: afterHalf };
      });
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragFrom === null || !dropMark) return;
        let to = dropMark.pos + (dropMark.after ? 1 : 0);
        if (dragFrom < to) to--;
        const from = dragFrom;
        dragFrom = null;
        dropMark = null;
        move(from, to);
      });
      li.addEventListener('dragend', () => {
        dragFrom = null;
        dropMark = null;
        list.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((n) => n.classList.remove('dragging', 'drop-before', 'drop-after'));
      });
      list.append(li);
    });

    if (model.hasRest) {
      const rp = model.params[model.r];
      list.append(
        h(
          'li',
          { class: 'rest', title: 'A rest parameter must stay last' },
          h('span', { class: 'grip', text: '🔒', 'aria-hidden': 'true' }),
          h('span', { class: 'pos', text: String(model.r + 1) }),
          h('span', { class: 'ptext', text: rp.text }),
          h('span', { class: 'tags' }, h('span', { class: 'tag', text: 'rest · stays last' })),
          h('span'),
        ),
      );
    }

    const preview = h(
      'div',
      { class: 'preview', 'aria-live': 'polite' },
      h('div', { class: 'row before' }, h('span', { class: 'k', text: 'Before' }), h('code', { text: callExample(before) })),
      h('div', { class: 'row after' }, h('span', { class: 'k', text: 'After' }), h('code', { text: callExample(after) })),
      h('div', { class: 'sep' }),
      h('div', { class: 'row' }, h('span', { class: 'k', text: 'Signature' }), h('code', { text: signature(after) })),
    );

    const issues = model.issues.length
      ? h(
          'details',
          { class: 'issues', open: model.issues.length <= 3 },
          h('summary', { text: `${plural(model.issues.length, 'location needs', 'locations need')} manual attention (left untouched)` }),
          h(
            'ul',
            null,
            model.issues.map((i) =>
              h(
                'li',
                null,
                h('button', { class: 'linklike', text: i.label, onclick: () => vscode.postMessage({ type: 'open', uri: i.uri, line: i.line, character: i.character }) }),
                h('span', { class: 'why', text: i.reason }),
              ),
            ),
          ),
        )
      : null;

    const previewBox = h('input', { type: 'checkbox', id: 'prev', checked: previewChecked || undefined, onchange: (e) => { previewChecked = e.target.checked; } });
    previewBox.checked = previewChecked;

    const footer = h(
      'footer',
      null,
      h(
        'div',
        { class: 'inner' },
        h('label', null, previewBox, 'Preview changes before applying'),
        h('button', { class: 'btn secondary', text: 'Reset', disabled: busy || !changed, onclick: reset }),
        h('button', { class: 'btn secondary', text: 'Cancel', disabled: busy, onclick: () => vscode.postMessage({ type: 'cancel' }) }),
        h('button', {
          class: 'btn primary',
          text: busy ? 'Applying…' : 'Apply refactor',
          disabled: busy || !changed,
          onclick: () => {
            errorMessage = '';
            vscode.postMessage({ type: 'apply', order: order.slice(), preview: previewChecked });
          },
        }),
      ),
    );

    app.replaceChildren(
      header,
      h('h2', { text: 'Parameter order' }),
      h('p', { class: 'hint', text: 'Drag a row, use the arrows, or press Alt+↑ / Alt+↓ on a focused row.' }),
      list,
      h('h2', { text: 'Result' }),
      preview,
      ...warn.map((w) => h('div', { class: 'msg' }, w)),
      errorMessage ? h('div', { class: 'msg err', role: 'alert' }, errorMessage) : null,
      issues,
      footer,
    );

    if (focusPos >= 0) {
      list.children[focusPos]?.focus({ preventScroll: false });
      focusPos = -1;
    }
    flashPos = -1;
  }

  // ── messages from the extension ───────────────────────────────────
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'init') {
      model = m.model;
      previewChecked = !!m.preview;
      order = model.params.slice(0, model.r).map((_, i) => i);
      render();
      app.querySelector('li.param')?.focus();
    } else if (m.type === 'busy') {
      busy = !!m.value;
      render();
    } else if (m.type === 'error') {
      errorMessage = m.message;
      render();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !busy) vscode.postMessage({ type: 'cancel' });
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !busy && model && !isIdentity()) {
      vscode.postMessage({ type: 'apply', order: order.slice(), preview: previewChecked });
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
