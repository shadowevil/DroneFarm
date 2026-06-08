// UI — floating script panels.
//
// Each panel is a C#-like code editor: window chrome (inline-renamable
// title via double-click, minimize, optional close), a play/pause/stop
// toolbar under the title bar, a syntax-highlighted textarea, and a status
// strip at the bottom. The focused/clicked panel is always topmost.
//
// main.js assigns UI.handlers = { play, pause, stop, closed } to connect
// panels to the script runner. UI.panels lists all open panels.

const UI = (() => {
  let topZ = 100;
  const panels = [];
  const handlers = {};

  // ---------- in-game tooltips ----------
  // any element with data-tip shows a themed tooltip on hover

  const tip = document.createElement('div');
  tip.className = 'tooltip';
  document.body.appendChild(tip);

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('[data-tip],[data-tiphtml]');
    if (!el) {
      tip.style.display = 'none';
      return;
    }
    if (el.dataset.tiphtml) tip.innerHTML = el.dataset.tiphtml;
    else tip.textContent = el.dataset.tip;
    tip.style.display = 'block';
    const r = el.getBoundingClientRect();
    let tx = Math.min(r.left, innerWidth - tip.offsetWidth - 8);
    let ty = r.bottom + 6;
    if (ty + tip.offsetHeight > innerHeight - 4) ty = r.top - tip.offsetHeight - 6;
    tip.style.left = Math.max(4, tx) + 'px';
    tip.style.top = ty + 'px';
  });

  // ---------- C#-ish syntax highlighting ----------

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // highlights already-HTML-escaped text
  function hlEscaped(esc) {
    return esc.replace(
      /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(\$?"(?:[^"\\]|\\.)*")|\b(if|else|for|while|do|foreach|in|switch|case|default|return|break|continue|var|int|float|double|bool|string|void|true|false|null|new|this|enum|class|struct|static|ref|out)\b|\b(north|south|east|west|harvest|can_harvest|has_resource|do_a_spin|world_size|clear_map|get_ground|get_entity|till|seed|plant)(?=\s*\()|\b(pos_x|pos_y)\b|\b(Math|Random|List|Dictionary|HashSet|Queue|Stack|Ground|Entity)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)(?=\s*\()/g,
      (m, com, str, kw, dir, pos, type, num) => {
        if (com !== undefined) return `<span class="c-com">${m}</span>`;
        if (str !== undefined) {
          // interpolated strings: { holes } get normal code coloring (VS-style)
          return m.startsWith('$') ? hlInterpolated(m) : `<span class="c-str">${m}</span>`;
        }
        if (kw !== undefined) return `<span class="c-kw">${m}</span>`;
        if (dir !== undefined) return `<span class="c-bi">${m}</span>`;
        if (pos !== undefined) return `<span class="c-bi">${m}</span>`;
        if (type !== undefined) return `<span class="c-type">${m}</span>`;
        if (num !== undefined) return `<span class="c-num">${m}</span>`;
        return `<span class="c-fn">${m}</span>`;
      },
    );
  }

  // $"text {expr} text" — string-color the text, code-color the holes
  function hlInterpolated(lit) {
    let out = '';
    let cur = '';
    let i = 0;
    const flush = () => {
      if (cur) out += `<span class="c-str">${cur}</span>`;
      cur = '';
    };
    while (i < lit.length) {
      if (lit[i] === '{' && lit[i + 1] === '{') { cur += '{{'; i += 2; continue; }
      if (lit[i] === '}' && lit[i + 1] === '}') { cur += '}}'; i += 2; continue; }
      if (lit[i] === '{') {
        flush();
        let depth = 1;
        let j = i + 1;
        let inner = '';
        while (j < lit.length && depth > 0) {
          if (lit[j] === '{') depth++;
          else if (lit[j] === '}') { depth--; if (!depth) break; }
          inner += lit[j];
          j++;
        }
        out += '<span class="c-str">{</span>' + hlEscaped(inner);
        if (depth === 0) out += '<span class="c-str">}</span>';
        i = j + 1;
        continue;
      }
      cur += lit[i];
      i++;
    }
    flush();
    return out;
  }

  function highlight(code) {
    return hlEscaped(escapeHtml(code));
  }

  // ---------- in-game context menu (panel text fields): Copy / Cut / Paste ----------

  const ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctxmenu';
  document.body.appendChild(ctxMenu);

  function closeCtxMenu() {
    ctxMenu.style.display = 'none';
  }

  function openCtxMenu(target, x, y) {
    const hasSel = target.selectionStart !== target.selectionEnd;
    const ro = !!target.readOnly;
    ctxMenu.innerHTML = '';
    const mk = (label, enabled, fn) => {
      const item = document.createElement('div');
      item.className = 'ctxmenu__item' + (enabled ? '' : ' is-disabled');
      item.textContent = label;
      if (enabled) {
        item.addEventListener('mousedown', (e) => {
          e.preventDefault(); // keep the textarea's focus + selection
          fn();
          closeCtxMenu();
        });
      }
      ctxMenu.appendChild(item);
    };
    mk('Copy', hasSel, () => {
      navigator.clipboard?.writeText(target.value.slice(target.selectionStart, target.selectionEnd)).catch(() => {});
    });
    mk('Cut', hasSel && !ro, () => {
      const s = target.selectionStart;
      const e = target.selectionEnd;
      navigator.clipboard?.writeText(target.value.slice(s, e)).catch(() => {});
      target.setRangeText('', s, e, 'end');
      target.dispatchEvent(new Event('input'));
    });
    mk('Paste', !ro, async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return;
        target.setRangeText(text, target.selectionStart, target.selectionEnd, 'end');
        target.dispatchEvent(new Event('input'));
      } catch {
        /* clipboard read not permitted */
      }
    });
    ctxMenu.style.display = 'block';
    ctxMenu.style.left = Math.min(x, innerWidth - ctxMenu.offsetWidth - 4) + 'px';
    ctxMenu.style.top = Math.min(y, innerHeight - ctxMenu.offsetHeight - 4) + 'px';
  }

  document.addEventListener('contextmenu', (e) => {
    const t = e.target;
    if ((t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') && t.closest('.panel')) {
      e.preventDefault();
      openCtxMenu(t, e.clientX, e.clientY);
    } else {
      closeCtxMenu();
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (!ctxMenu.contains(e.target)) closeCtxMenu();
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCtxMenu();
  });
  addEventListener('blur', closeCtxMenu);

  // ---------- autocomplete data ----------

  // main.js fills these with game builtins and built-in enums
  const SUGGEST = { globals: [], enums: {} };

  const fnItem = (n) => ({ name: n, kind: 'fn' });
  const propItem = (n) => ({ name: n, kind: 'prop' });

  // members of the built-in types, keyed by inferred receiver kind
  const TYPE_MEMBERS = {
    string: [propItem('Length'), fnItem('Substring'), fnItem('Contains'), fnItem('StartsWith'),
      fnItem('EndsWith'), fnItem('IndexOf'), fnItem('Replace'), fnItem('ToUpper'),
      fnItem('ToLower'), fnItem('Trim'), fnItem('Split'), fnItem('ToString')],
    array: [propItem('Length'), fnItem('ToString')],
    list: [propItem('Count'), fnItem('Add'), fnItem('Insert'), fnItem('Remove'), fnItem('RemoveAt'),
      fnItem('Contains'), fnItem('IndexOf'), fnItem('Clear'), fnItem('ToString')],
    dict: [propItem('Count'), propItem('Keys'), propItem('Values'), fnItem('Add'), fnItem('ContainsKey'),
      fnItem('ContainsValue'), fnItem('TryGetValue'), fnItem('Remove'), fnItem('Clear')],
    set: [propItem('Count'), fnItem('Add'), fnItem('Contains'), fnItem('Remove'), fnItem('Clear')],
    queue: [propItem('Count'), fnItem('Enqueue'), fnItem('Dequeue'), fnItem('Peek'), fnItem('Contains'), fnItem('Clear')],
    stack: [propItem('Count'), fnItem('Push'), fnItem('Pop'), fnItem('Peek'), fnItem('Contains'), fnItem('Clear')],
    random: [fnItem('Next'), fnItem('NextDouble')],
    number: [fnItem('ToString')],
    math: [fnItem('Abs'), fnItem('Min'), fnItem('Max'), fnItem('Floor'), fnItem('Ceiling'), fnItem('Sqrt'), fnItem('Pow')],
  };

  const GENERIC_KIND = { List: 'list', Dictionary: 'dict', HashSet: 'set', Queue: 'queue', Stack: 'stack', Random: 'random' };

  const SUGGEST_KEYWORDS = [
    'if', 'else', 'for', 'while', 'do', 'foreach', 'in', 'switch', 'case', 'default',
    'return', 'break', 'continue', 'var', 'int', 'float', 'double', 'bool', 'string',
    'void', 'true', 'false', 'null', 'new', 'this', 'enum', 'class', 'struct',
    'static', 'ref', 'out',
  ];

  // keyword -> progression feature that must be unlocked for it to suggest
  const KEYWORD_FEATURE = {
    var: 'variables', int: 'variables', float: 'variables', double: 'variables',
    bool: 'variables', string: 'variables', null: 'variables',
    true: 'booleans', false: 'booleans',
    if: 'if', else: 'if',
    switch: 'switch', case: 'switch', default: 'switch',
    for: 'for', while: 'while', do: 'do_while', foreach: 'foreach', in: 'foreach',
    enum: 'enum',
    class: 'classes', struct: 'classes', static: 'classes', this: 'classes',
    ref: 'ref_out', out: 'ref_out',
  };

  // find a user class/struct body across all script panels (brace-matched)
  function classBodyOf(name) {
    for (const p of panels) {
      if (!p.isScript) continue;
      const text = p.body.value;
      const m = text.match(new RegExp(`\\b(?:class|struct)\\s+${name}\\b[^{]*\\{`));
      if (!m) continue;
      let i = m.index + m[0].length;
      let depth = 1;
      const start = i;
      while (i < text.length && depth > 0) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        i++;
      }
      return text.slice(start, i - 1);
    }
    return null;
  }

  function classMembers(cbody, clsName) {
    const out = new Map();
    for (const m of cbody.matchAll(/(?:static\s+)?[A-Za-z_][\w<>\[\]?]*\s+([A-Za-z_]\w*)\s*\(/g)) {
      if (m[1] !== clsName) out.set(m[1], fnItem(m[1]));
    }
    for (const m of cbody.matchAll(/(?:static\s+)?[A-Za-z_][\w<>\[\]?]*\s+([A-Za-z_]\w*)\s*[=;]/g)) {
      if (!out.has(m[1])) out.set(m[1], propItem(m[1]));
    }
    return [...out.values()];
  }

  // what can follow `recv.` — constrained by the receiver's inferred type
  function membersFor(recv) {
    if (SUGGEST.isLocked?.(recv)) return null; // locked globals offer nothing
    if (recv === 'Math') return TYPE_MEMBERS.math;
    if (SUGGEST.enums[recv]) return SUGGEST.enums[recv].map((n) => ({ name: n, kind: 'enum' }));
    // user enum?
    for (const p of panels) {
      if (!p.isScript) continue;
      const m = p.body.value.match(new RegExp(`\\benum\\s+${recv}\\s*\\{([^}]*)\\}`));
      if (m) return [...m[1].matchAll(/[A-Za-z_]\w*/g)].map((x) => ({ name: x[0], kind: 'enum' }));
    }
    // user class (static access)?
    const cbody = classBodyOf(recv);
    if (cbody != null) return classMembers(cbody, recv);
    // a declared variable — find its declaration to learn the type
    for (const p of panels) {
      if (!p.isScript) continue;
      const text = p.body.value;
      let m;
      if ((m = text.match(new RegExp(`\\b(List|Dictionary|HashSet|Queue|Stack)\\s*<[^>]*>\\s*\\??\\s+${recv}\\b`)))) {
        return TYPE_MEMBERS[GENERIC_KIND[m[1]]];
      }
      if ((m = text.match(new RegExp(`\\b(int|float|double|bool|string|Random)(\\[\\])?\\s*\\??\\s+${recv}\\b`)))) {
        if (m[2]) return TYPE_MEMBERS.array;
        if (m[1] === 'string') return TYPE_MEMBERS.string;
        if (m[1] === 'Random') return TYPE_MEMBERS.random;
        return TYPE_MEMBERS.number;
      }
      if ((m = text.match(new RegExp(`\\bvar\\s+${recv}\\s*=\\s*new\\s+(List|Dictionary|HashSet|Queue|Stack|Random)\\b`)))) {
        return TYPE_MEMBERS[GENERIC_KIND[m[1]]];
      }
      if (text.match(new RegExp(`\\bvar\\s+${recv}\\s*=\\s*\\$?"`))) return TYPE_MEMBERS.string;
      if ((m = text.match(new RegExp(`\\b([A-Z]\\w*)(?:\\[\\])?\\s*\\??\\s+${recv}\\s*[=;]`)))) {
        const cb = classBodyOf(m[1]);
        if (cb != null) return classMembers(cb, m[1]);
      }
    }
    return null;
  }

  // ---------- panel factory ----------

  // closable: false makes a permanent panel (no close button);
  // renamable: false locks the title (used by the always-present "main" panel);
  // script: false makes a plain text panel (no toolbar/status, not compiled);
  // readonly: true locks the body text;
  // help: { CATEGORY: text, ... } builds a tabbed help layout instead of an
  //   editor — category tabs on the left, highlighted content on the right
  function createPanel({
    title = 'PANEL', x = 24, y = 110, width = 340, height = 200, text = '',
    closable = true, renamable = true, script = true, readonly = false,
    help = null,
  } = {}) {
    const isScriptPanel = script && !help;
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.style.width = width + 'px';
    panel.style.zIndex = ++topZ;

    // --- title bar ---
    const bar = document.createElement('div');
    bar.className = 'panel__bar';

    const titleEl = document.createElement('span');
    titleEl.className = 'panel__title';
    titleEl.textContent = title;
    titleEl.spellcheck = false;

    const minBtn = document.createElement('button');
    minBtn.className = 'panel__min';
    minBtn.type = 'button';
    minBtn.textContent = '–';
    minBtn.dataset.tip = 'Minimize to the title bar';

    bar.append(titleEl, minBtn);

    // --- toolbar: play / pause / stop (script panels only) ---
    const tools = document.createElement('div');
    tools.className = 'panel__tools';
    const mkTool = (label, tipText) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.dataset.tip = tipText;
      tools.appendChild(b);
      return b;
    };
    const playBtn = mkTool('▶', "Run this panel's script\n(queues if another is running)");
    const pauseBtn = mkTool('❚❚', 'Pause / resume the running script');
    const stopBtn = mkTool('■', 'Stop the running script');

    // --- editor: highlighted pre under a transparent-text textarea ---
    const editor = document.createElement('div');
    editor.className = 'panel__editor';
    editor.style.height = height + 'px';

    const lineHL = document.createElement('div');
    lineHL.className = 'panel__activeline';

    const hl = document.createElement('pre');
    hl.className = 'panel__hl';
    const codeEl = document.createElement('code');
    hl.appendChild(codeEl);

    const body = document.createElement('textarea');
    body.className = 'panel__body';
    body.value = text;
    body.spellcheck = false;
    body.wrap = 'off';
    body.readOnly = readonly;

    editor.append(lineHL, hl, body);

    // line-number gutter (code panels only)
    let gutterNums = null;
    if (isScriptPanel) {
      editor.classList.add('panel__editor--code');
      const gutter = document.createElement('div');
      gutter.className = 'panel__gutter';
      gutterNums = document.createElement('div');
      gutter.appendChild(gutterNums);
      editor.appendChild(gutter);
    }
    let gutterCount = -1;
    const refreshGutter = () => {
      if (!gutterNums) return;
      const n = body.value.split('\n').length;
      if (n !== gutterCount) {
        gutterCount = n;
        gutterNums.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
      }
    };

    // --- status strip ---
    const statusEl = document.createElement('div');
    statusEl.className = 'panel__statusbar';
    statusEl.textContent = 'READY';

    let helpNav = null; // set by the help builder, exposed as api.openHelpAt
    let helpPathGet = null; // current help selection, exposed as api.getHelpPath

    if (help) {
      // tabbed help: collapsible category tree left, content pane right.
      // A string value is a leaf; an object value is an expandable group
      // whose '' key (optional) is the group's own overview text.
      const wrap = document.createElement('div');
      wrap.className = 'panel__help';
      wrap.style.height = height + 'px';
      const tabs = document.createElement('div');
      tabs.className = 'panel__helptabs';
      const view = document.createElement('pre');
      view.className = 'panel__helpview';

      // prose renders plain (wrapping to the pane width); ``` fences become
      // highlighted code boxes; consecutive |-rows become a table whose
      // first row is the header (an empty first row means no header)
      const renderTables = (esc) =>
        esc.replace(/(?:^\|.*\|[ \t]*$\n?)+/gm, (block) => {
          const rows = block
            .trimEnd()
            .split('\n')
            .map((l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()));
          const head = rows[0].some((c) => c !== '') ? rows[0] : null; // "| | |" = headerless
          const body = rows.slice(1);
          let html = '<table class="helptable">';
          if (head) {
            html += '<thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead>';
          }
          html += '<tbody>' + body.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
          return html;
        });

      const renderHelp = (content) => {
        const parts = content.split('```');
        let html = '';
        for (let i = 0; i < parts.length; i++) {
          if (i % 2 === 0) html += renderTables(escapeHtml(parts[i]));
          else html += `<div class="panel__codebox">${highlight(parts[i].replace(/^\n+|\n+$/g, ''))}</div>`;
        }
        return html;
      };

      let activeBtn = null;
      const select = (content, btn) => {
        activeBtn?.classList.remove('is-active');
        activeBtn = btn;
        btn.classList.add('is-active');
        view.innerHTML = renderHelp(content) + '\n';
        view.scrollTop = 0;
      };

      // index of buttons by path ("GROUP/entry" or "ENTRY") for openHelpAt
      const helpButtons = new Map();
      const helpGroups = new Map();

      let currentHelpPath = null; // last selected entry, for save/restore

      const leafBtn = (name, content, container, child, path) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = name;
        if (child) b.classList.add('is-child');
        b.addEventListener('click', () => {
          currentHelpPath = path;
          select(content, b);
        });
        container.appendChild(b);
        return b;
      };

      let first = null;
      for (const [name, value] of Object.entries(help)) {
        if (typeof value === 'string') {
          const b = leafBtn(name, value, tabs, false, name);
          helpButtons.set(name, b);
          first = first || b;
        } else {
          const group = document.createElement('div');
          group.className = 'panel__helpgroup';
          const head = document.createElement('button');
          head.type = 'button';
          head.innerHTML = `<i>▸</i>${name}`;
          const kids = document.createElement('div');
          kids.className = 'panel__helpkids';
          head.addEventListener('click', () => {
            const open = group.classList.toggle('is-open');
            head.querySelector('i').textContent = open ? '▾' : '▸';
            currentHelpPath = name;
            if (value['']) select(value[''], head);
          });
          group.append(head, kids);
          tabs.appendChild(group);
          helpGroups.set(name, { group, head });
          for (const [kidName, kidText] of Object.entries(value)) {
            if (kidName === '') continue;
            const kb = leafBtn(kidName, kidText, kids, true, `${name}/${kidName}`);
            helpButtons.set(`${name}/${kidName}`, kb);
          }
          first = first || head;
        }
      }
      first?.click();

      helpPathGet = () => currentHelpPath;

      // navigate to "GROUP/entry" (expands the group) or a top-level entry
      helpNav = (path) => {
        const slash = path.indexOf('/');
        if (slash > 0) {
          const g = helpGroups.get(path.slice(0, slash));
          if (g && !g.group.classList.contains('is-open')) g.head.click();
        }
        const target = helpButtons.get(path) || helpGroups.get(path)?.head;
        if (!target) return false;
        target.click();
        api.raise();
        return true;
      };

      wrap.append(tabs, view);
      panel.append(bar, wrap);
    } else if (isScriptPanel) {
      panel.append(bar, tools, editor, statusEl);
    } else {
      panel.append(bar, editor); // plain text panel
    }
    document.body.appendChild(panel);

    // --- highlighting sync + current-instruction marker ---
    const PAD_TOP = 8;   // must match .panel__body padding
    const LINE_H = 18;   // 12px font * 1.5 line-height
    let activeLine = null;

    const placeActiveLine = () => {
      if (activeLine == null) {
        lineHL.style.display = 'none';
        return;
      }
      lineHL.style.display = 'block';
      lineHL.style.top = PAD_TOP + (activeLine - 1) * LINE_H - body.scrollTop + 'px';
    };

    const refresh = () => {
      codeEl.innerHTML = highlight(body.value) + '\n';
      refreshGutter();
    };

    // --- autocomplete: suggestion overlay at the caret ---
    const PAD_LEFT = isScriptPanel ? 48 : 10; // must match .panel__body padding
    const sug = {
      el: null, items: [], active: 0, open: false, navigated: false,
      tokenStart: 0, charW: 7.2, suppress: false,
    };
    if (isScriptPanel) {
      sug.el = document.createElement('div');
      sug.el.className = 'panel__suggest';
      editor.appendChild(sug.el);
      requestAnimationFrame(() => {
        const meas = document.createElement('canvas').getContext('2d');
        meas.font = getComputedStyle(body).font;
        sug.charW = meas.measureText('M').width || 7.2;
      });
    }

    const closeSuggest = () => {
      sug.open = false;
      sug.navigated = false;
      if (sug.el) sug.el.style.display = 'none';
    };

    function acceptSuggest() {
      const item = sug.items[sug.active];
      if (!item) return closeSuggest();
      const end = body.selectionStart;
      const addParens = item.kind === 'fn' && !body.value.slice(end).trimStart().startsWith('(');
      const text = item.name + (addParens ? '()' : '');
      sug.suppress = true;
      body.setRangeText(text, sug.tokenStart, end, 'end');
      if (addParens) {
        body.selectionStart = body.selectionEnd = sug.tokenStart + text.length - 1; // caret inside ()
      }
      body.dispatchEvent(new Event('input'));
      closeSuggest();
    }

    function renderSuggest() {
      sug.el.innerHTML = '';
      sug.items.forEach((item, ix) => {
        const row = document.createElement('div');
        row.className = 'panel__suggest-item' + (ix === sug.active ? ' is-active' : '');
        row.innerHTML = `<span>${item.name}</span><i>${item.kind}</i>`;
        row.addEventListener('mousedown', (e) => {
          e.preventDefault(); // keep focus in the editor
          sug.active = ix;
          acceptSuggest();
        });
        sug.el.appendChild(row);
      });
      // place at the caret (monospace math), flipping above if cramped
      const upto = body.value.slice(0, sug.tokenStart);
      const line = (upto.match(/\n/g) || []).length;
      // tab-aware column: tabs advance to the next 4-column stop
      let col = 0;
      for (const ch of upto.slice(upto.lastIndexOf('\n') + 1)) {
        col = ch === '\t' ? col + 4 - (col % 4) : col + 1;
      }
      let x = PAD_LEFT + col * sug.charW - body.scrollLeft;
      let y = PAD_TOP + (line + 1) * LINE_H - body.scrollTop;
      sug.el.style.display = 'block';
      const w = sug.el.offsetWidth;
      const h = sug.el.offsetHeight;
      if (y + h > editor.clientHeight) y = Math.max(0, y - h - LINE_H);
      x = Math.max(0, Math.min(x, Math.max(0, editor.clientWidth - w - 4)));
      sug.el.style.left = x + 'px';
      sug.el.style.top = y + 'px';
      sug.el.children[sug.active]?.scrollIntoView({ block: 'nearest' });
    }

    function globalPool() {
      const out = new Map();
      const add = (item) => {
        if (!out.has(item.name)) out.set(item.name, item);
      };
      for (const g of SUGGEST.globals) add(g);
      for (const name of Object.keys(SUGGEST.enums)) add({ name, kind: 'enum' });
      for (const name of ['Math', 'Random', 'List', 'Dictionary', 'HashSet', 'Queue', 'Stack']) {
        if (!SUGGEST.isLocked?.(name)) add({ name, kind: 'type' });
      }
      for (const kw of SUGGEST_KEYWORDS) {
        const feat = KEYWORD_FEATURE[kw];
        if (feat && SUGGEST.isLocked?.(feat)) continue;
        add({ name: kw, kind: 'kw' });
      }
      for (const p of panels) {
        if (!p.isScript) continue;
        const text = p.body.value;
        for (const m of text.matchAll(/\b(?:void|int|float|double|bool|string|var)\s+([A-Za-z_]\w*)\s*\(/g)) add(fnItem(m[1]));
        for (const m of text.matchAll(/\b(?:class|struct|enum)\s+([A-Za-z_]\w*)/g)) add({ name: m[1], kind: 'type' });
      }
      // variables declared in this panel
      for (const m of body.value.matchAll(/\b(?:int|float|double|bool|string|var|Random|List\s*<[^>]*>|Dictionary\s*<[^>]*>|HashSet\s*<[^>]*>|Queue\s*<[^>]*>|Stack\s*<[^>]*>|[A-Z]\w*)\??(?:\[\])?\s+([a-z_]\w*)\s*(?:=|;|\bin\b)/g)) {
        add({ name: m[1], kind: 'var' });
      }
      return [...out.values()];
    }

    function refreshSuggest() {
      if (!isScriptPanel) return;
      if (sug.suppress) {
        sug.suppress = false;
        return closeSuggest();
      }
      const pos = body.selectionStart;
      const before = body.value.slice(0, pos);
      const tm = before.match(/([A-Za-z_]\w*)$/);
      const tok = tm ? tm[1] : '';
      const start = pos - tok.length;
      const head = body.value.slice(0, start);
      const afterDot = /\.\s*$/.test(head);
      let pool = null;
      if (afterDot) {
        const rm = head.match(/([A-Za-z_]\w*)\s*\.\s*$/);
        pool = rm ? membersFor(rm[1]) : null;
      } else if (tok.length >= 1) {
        pool = globalPool();
      }
      if (!pool || !pool.length) return closeSuggest();
      const lower = tok.toLowerCase();
      const starts = [];
      const within = [];
      for (const item of pool) {
        const ln = item.name.toLowerCase();
        if (ln.startsWith(lower)) starts.push(item);
        else if (lower && ln.includes(lower)) within.push(item);
      }
      const items = [...starts, ...within].slice(0, 30);
      if (!items.length || (items.length === 1 && items[0].name === tok && items[0].kind !== 'fn')) {
        return closeSuggest();
      }
      sug.items = items;
      sug.active = 0;
      sug.navigated = false;
      sug.tokenStart = start;
      sug.open = true;
      renderSuggest();
    }

    body.addEventListener('input', () => {
      refresh();
      handlers.edited?.(api); // editing stops a running script
      refreshSuggest();
    });
    body.addEventListener('blur', closeSuggest);
    body.addEventListener('scroll', () => {
      hl.scrollTop = body.scrollTop;
      hl.scrollLeft = body.scrollLeft;
      if (gutterNums) gutterNums.style.transform = `translateY(${-body.scrollTop}px)`;
      placeActiveLine();
      closeSuggest();
    });
    body.addEventListener('keydown', (e) => {
      if (sug.open) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          sug.navigated = true;
          sug.active = (sug.active + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length;
          renderSuggest();
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && sug.navigated)) {
          e.preventDefault();
          acceptSuggest();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeSuggest();
          return;
        }
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = body.selectionStart;
        const en = body.selectionEnd;
        if (body.value.slice(s, en).includes('\n')) {
          // block indent / dedent across the selected lines
          const ls = body.value.lastIndexOf('\n', s - 1) + 1;
          const block = body.value.slice(ls, en);
          const out = e.shiftKey
            ? block.replace(/^(\t| {1,4})/gm, '')
            : block.replace(/^/gm, '\t');
          body.setRangeText(out, ls, en, 'select');
        } else if (e.shiftKey) {
          // dedent the current line one level
          const ls = body.value.lastIndexOf('\n', s - 1) + 1;
          const m = body.value.slice(ls).match(/^(\t| {1,4})/);
          if (m) body.setRangeText('', ls, ls + m[1].length, 'preserve');
        } else {
          body.setRangeText('\t', s, en, 'end');
        }
        body.dispatchEvent(new Event('input'));
        return;
      }
      if (e.key === 'Enter') {
        // auto-indent: keep the current line's indentation, one deeper
        // after '{'; with '}' right after the caret, split the braces
        e.preventDefault();
        const s = body.selectionStart;
        const ls = body.value.lastIndexOf('\n', s - 1) + 1;
        const indent = body.value.slice(ls, s).match(/^[\t ]*/)[0];
        const open = body.value.slice(0, s).trimEnd().endsWith('{');
        let after = body.selectionEnd;
        while (body.value[after] === ' ' || body.value[after] === '\t') after++;
        if (open && body.value[after] === '}') {
          body.setRangeText(`\n${indent}\t\n${indent}`, s, body.selectionEnd);
          body.selectionStart = body.selectionEnd = s + 1 + indent.length + 1;
        } else {
          body.setRangeText('\n' + indent + (open ? '\t' : ''), s, body.selectionEnd, 'end');
        }
        body.dispatchEvent(new Event('input'));
        return;
      }
      if (e.key === '}') {
        // closing a block on a blank line steps the indent back one level
        const s = body.selectionStart;
        const ls = body.value.lastIndexOf('\n', s - 1) + 1;
        const lineBefore = body.value.slice(ls, s);
        if (s === body.selectionEnd && /^[\t ]+$/.test(lineBefore)) {
          const m = lineBefore.match(/(\t| {1,4})$/);
          if (m) body.setRangeText('', s - m[1].length, s, 'end');
        }
      }
    });
    refresh();

    // --- panel api (handed to runner callbacks) ---
    const api = {
      el: panel,
      body,
      isScript: isScriptPanel,
      buttons: { play: playBtn, pause: pauseBtn, stop: stopBtn },
      raise() {
        panel.style.zIndex = ++topZ;
      },
      // help panels: navigate to "GROUP/entry" or a top-level entry
      openHelpAt(path) {
        return helpNav ? helpNav(path) : false;
      },
      getHelpPath() {
        return helpPathGet ? helpPathGet() : null;
      },
      setStatus(textValue, kind = '') {
        statusEl.textContent = textValue;
        statusEl.className = 'panel__statusbar' + (kind ? ' is-' + kind : '');
      },
      // remove the panel programmatically (same path as the close button)
      close() {
        panels.splice(panels.indexOf(api), 1);
        handlers.closed?.(api);
        panel.remove();
      },
      // highlight the line currently executing (null clears); keeps it in view
      setActiveLine(line) {
        activeLine = line;
        if (line != null) {
          const top = PAD_TOP + (line - 1) * LINE_H;
          if (top < body.scrollTop || top > body.scrollTop + body.clientHeight - LINE_H * 2) {
            body.scrollTop = Math.max(0, top - body.clientHeight / 2);
            hl.scrollTop = body.scrollTop;
          }
        }
        placeActiveLine();
      },
      get title() {
        return titleEl.textContent;
      },
      set title(t) {
        titleEl.textContent = t;
      },
    };
    panels.push(api);

    playBtn.addEventListener('click', () => handlers.play?.(api));
    pauseBtn.addEventListener('click', () => handlers.pause?.(api));
    stopBtn.addEventListener('click', () => handlers.stop?.(api));

    // optional close button
    if (closable) {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'panel__close';
      closeBtn.type = 'button';
      closeBtn.textContent = '×';
      closeBtn.dataset.tip = 'Close panel';
      closeBtn.addEventListener('click', () => api.close());
      bar.appendChild(closeBtn);
    }

    // dynamic layering: the focused/clicked panel is always topmost
    panel.addEventListener('pointerdown', () => {
      panel.style.zIndex = ++topZ;
    });
    panel.addEventListener('focusin', () => {
      panel.style.zIndex = ++topZ;
    });

    // minimize: collapse to the title bar
    const setMinimized = (on) => {
      panel.classList.toggle('panel--min', on);
      minBtn.textContent = on ? '+' : '–';
    };
    api.minimize = setMinimized;
    minBtn.addEventListener('click', () => {
      setMinimized(!panel.classList.contains('panel--min'));
    });

    // inline title editing (double-click), unless locked
    let before = title;
    if (renamable) {
      titleEl.dataset.tip = 'Double-click to rename';
      titleEl.addEventListener('dblclick', () => {
        before = titleEl.textContent;
        titleEl.contentEditable = 'true';
        titleEl.focus();
        getSelection().selectAllChildren(titleEl);
      });
    }
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        titleEl.blur();
      } else if (e.key === 'Escape') {
        titleEl.textContent = before;
        titleEl.blur();
      }
    });
    titleEl.addEventListener('blur', () => {
      titleEl.contentEditable = 'false';
      if (!titleEl.textContent.trim()) titleEl.textContent = before; // no empty titles
    });

    // drag by the title bar — the drag (and pointer capture) only starts
    // after a few px of movement, so double-clicks reach the title
    let drag = null;
    let pending = null;
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON' || titleEl.isContentEditable) return;
      pending = {
        id: e.pointerId,
        sx: e.clientX,
        sy: e.clientY,
        dx: e.clientX - panel.offsetLeft,
        dy: e.clientY - panel.offsetTop,
      };
    });
    bar.addEventListener('pointermove', (e) => {
      if (pending && !drag &&
          Math.abs(e.clientX - pending.sx) + Math.abs(e.clientY - pending.sy) > 4) {
        drag = pending;
        bar.setPointerCapture(pending.id);
      }
      if (!drag) return;
      panel.style.left = Math.max(0, e.clientX - drag.dx) + 'px';
      panel.style.top = Math.max(0, e.clientY - drag.dy) + 'px';
    });
    const endDrag = () => {
      drag = null;
      pending = null;
      clampIntoView(panel); // a drop can't strand the panel offscreen
    };
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);

    clampIntoView(panel); // small windows: even the default spot must be visible

    return api;
  }

  // panels must always stay reachable: keep at least a grabbable slice of
  // the title bar inside the viewport
  function clampIntoView(el) {
    const MIN_X = 60; // px of panel width that must remain on-screen
    const BAR_H = 34; // enough of the title bar to grab
    const x = Math.max(MIN_X - el.offsetWidth, Math.min(el.offsetLeft, innerWidth - MIN_X));
    const y = Math.max(0, Math.min(el.offsetTop, innerHeight - BAR_H));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }

  // window resizes can orphan panels — pull every panel back into view
  addEventListener('resize', () => {
    for (const p of panels) clampIntoView(p.el);
  });

  const clampPanels = () => {
    for (const p of panels) clampIntoView(p.el);
  };

  return { createPanel, panels, handlers, suggest: SUGGEST, highlight, clampPanels };
})();
