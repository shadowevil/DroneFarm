// CSharp — a C#-like scripting language for drone programs.
//
// Top-level statements run directly (no Main needed). The interpreter is
// fully async: builtins like north() return promises, so scripts animate
// step by step; a control object supports pause/stop between statements.
//
// Supported: variables (int/float/double/bool/string/var, nullable T?,
// null, ??), all loops (for/while/do-while/foreach), if/else,
// switch/case/default, break/continue/return, user functions with ref/out
// parameters, enums, classes & structs (fields, methods, constructors,
// static members), collections (arrays, List, Dictionary, HashSet, Queue,
// Stack), strings (methods + $"interpolation"), Math.*, Random.

const CSharp = (() => {
  const KEYWORDS = new Set([
    'var', 'int', 'float', 'double', 'bool', 'string', 'void',
    'if', 'else', 'for', 'while', 'do', 'foreach', 'in',
    'switch', 'case', 'default',
    'return', 'break', 'continue',
    'true', 'false', 'null', 'new', 'this',
    'enum', 'class', 'struct', 'static', 'ref', 'out',
  ]);
  const PRIM_TYPES = ['var', 'int', 'float', 'double', 'bool', 'string'];
  const TWO_CHAR_OPS = ['==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '??'];

  class Stop extends Error {
    constructor() {
      super('stopped');
    }
  }

  function fail(msg, line) {
    return new Error(`line ${line}: ${msg}`);
  }

  // ---------- lexer ----------

  const ESCAPES = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '{': '{', '}': '}', '0': '\0' };

  function lex(src) {
    const toks = [];
    let i = 0;
    let line = 1;
    const push = (type, value) => toks.push({ type, value, line });

    while (i < src.length) {
      const c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (/\s/.test(c)) { i++; continue; }
      if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
          if (src[i] === '\n') line++;
          i++;
        }
        i += 2;
        continue;
      }
      if (/[0-9]/.test(c)) {
        let j = i;
        let isFloat = false;
        while (j < src.length) {
          if (/[0-9_]/.test(src[j])) { j++; continue; }
          if (src[j] === '.' && /[0-9]/.test(src[j + 1] || '')) { isFloat = true; j++; continue; }
          break;
        }
        const raw = src.slice(i, j).replace(/_/g, '');
        push('num', isFloat ? parseFloat(raw) : parseInt(raw, 10));
        if (j < src.length && /[fdFD]/.test(src[j])) j++; // 1.5f suffix
        i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i;
        while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
        const w = src.slice(i, j);
        push(KEYWORDS.has(w) ? w : 'ident', w);
        i = j;
        continue;
      }
      // interpolated string $"... {expr} ..."
      if (c === '$' && src[i + 1] === '"') {
        i += 2;
        const parts = [];
        let cur = '';
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\') { cur += ESCAPES[src[i + 1]] ?? src[i + 1]; i += 2; continue; }
          if (src[i] === '{' && src[i + 1] === '{') { cur += '{'; i += 2; continue; }
          if (src[i] === '}' && src[i + 1] === '}') { cur += '}'; i += 2; continue; }
          if (src[i] === '{') {
            parts.push({ t: 's', v: cur });
            cur = '';
            let depth = 1;
            let j = i + 1;
            let expr = '';
            while (j < src.length && depth > 0) {
              if (src[j] === '{') depth++;
              else if (src[j] === '}') { depth--; if (!depth) break; }
              expr += src[j];
              j++;
            }
            if (depth) throw fail('unterminated { } in interpolated string', line);
            parts.push({ t: 'e', src: expr, line });
            i = j + 1;
            continue;
          }
          if (src[i] === '\n') line++;
          cur += src[i];
          i++;
        }
        if (i >= src.length) throw fail('unterminated string', line);
        parts.push({ t: 's', v: cur });
        push('istr', parts);
        i++;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        let s = '';
        while (j < src.length && src[j] !== '"') {
          if (src[j] === '\\') { s += ESCAPES[src[j + 1]] ?? src[j + 1]; j += 2; }
          else { if (src[j] === '\n') line++; s += src[j]; j++; }
        }
        if (j >= src.length) throw fail('unterminated string', line);
        push('str', s);
        i = j + 1;
        continue;
      }
      const two = src.substr(i, 2);
      if (TWO_CHAR_OPS.includes(two)) { push(two, two); i += 2; continue; }
      if ('+-*/%<>=!(){};,.[]:?'.includes(c)) { push(c, c); i++; continue; }
      throw fail(`unexpected character '${c}'`, line);
    }
    push('eof', null);
    return toks;
  }

  // ---------- parser ----------

  function makeParser(toks) {
    let p = 0;
    const peek = (k = 0) => toks[p + k];
    const next = () => toks[p++];
    const at = (t) => toks[p].type === t;
    const expect = (t) => {
      if (!at(t)) throw fail(`expected '${t}' but found '${toks[p].value ?? toks[p].type}'`, toks[p].line);
      return next();
    };

    // try to parse a type at the cursor; restores and returns null on failure
    function tryType(allowVoid = false) {
      const start = p;
      const t = peek();
      let base = null;
      if (PRIM_TYPES.includes(t.type) || (allowVoid && t.type === 'void')) base = next().type;
      else if (t.type === 'ident') base = next().value;
      else return null;
      if (at('<')) {
        // consume balanced generic args conservatively
        let depth = 0;
        do {
          const tk = next();
          if (tk.type === '<') depth++;
          else if (tk.type === '>') depth--;
          else if (!['ident', 'int', 'float', 'double', 'bool', 'string', 'var', ',', '[', ']', '?'].includes(tk.type)) {
            p = start;
            return null;
          }
        } while (depth > 0 && !at('eof'));
        if (depth !== 0) { p = start; return null; }
      }
      let nullable = false;
      if (at('?')) { next(); nullable = true; }
      let isArray = false;
      if (at('[') && peek(1).type === ']') { next(); next(); isArray = true; }
      return { base, nullable, isArray };
    }

    // type followed by an identifier = a declaration; otherwise restore
    function tryDecl() {
      const start = p;
      const ty = tryType(false);
      if (!ty || !at('ident')) { p = start; return null; }
      return ty;
    }

    function parseParams() {
      expect('(');
      const params = [];
      while (!at(')')) {
        let mode = null;
        if (at('ref') || at('out')) mode = next().type;
        const save = p;
        const ty = tryType(false);
        if (ty && !at('ident')) p = save; // it was the param name, not a type
        params.push({ name: expect('ident').value, mode, type: ty || null });
        if (at(',')) next();
      }
      expect(')');
      return params;
    }

    function arrayInit() {
      const line = expect('{').line;
      const items = [];
      while (!at('}')) {
        items.push(expression());
        if (at(',')) next();
      }
      expect('}');
      return { kind: 'arrayinit', items, line };
    }

    function block() {
      expect('{');
      const stmts = [];
      while (!at('}')) stmts.push(statement());
      expect('}');
      return { kind: 'block', stmts };
    }

    function statement() {
      const t = peek();
      switch (t.type) {
        case '{':
          return block();
        case 'if': {
          next();
          expect('(');
          const cond = expression();
          expect(')');
          const then = statement();
          let alt = null;
          if (at('else')) { next(); alt = statement(); }
          return { kind: 'if', cond, then, alt, line: t.line };
        }
        case 'while': {
          next();
          expect('(');
          const cond = expression();
          expect(')');
          return { kind: 'while', cond, body: statement(), line: t.line };
        }
        case 'do': {
          next();
          const body = statement();
          expect('while');
          expect('(');
          const cond = expression();
          expect(')');
          expect(';');
          return { kind: 'dowhile', cond, body, line: t.line };
        }
        case 'for': {
          next();
          expect('(');
          let init = null, cond = null, step = null;
          if (!at(';')) {
            const ty = tryDecl();
            init = ty
              ? varDeclRest(ty, t.line)
              : { kind: 'expr', expr: expression(), line: t.line };
          }
          expect(';');
          if (!at(';')) cond = expression();
          expect(';');
          if (!at(')')) step = { kind: 'expr', expr: expression(), line: t.line };
          expect(')');
          return { kind: 'for', init, cond, step, body: statement(), line: t.line };
        }
        case 'foreach': {
          next();
          expect('(');
          tryType(false); // loop variable type (ignored at runtime)
          const name = expect('ident').value;
          expect('in');
          const coll = expression();
          expect(')');
          return { kind: 'foreach', name, coll, body: statement(), line: t.line };
        }
        case 'switch': {
          next();
          expect('(');
          const disc = expression();
          expect(')');
          expect('{');
          const sections = [];
          while (!at('}')) {
            const tests = [];
            let isDefault = false;
            while (at('case') || at('default')) {
              if (at('case')) {
                next();
                tests.push(expression());
                expect(':');
              } else {
                next();
                expect(':');
                isDefault = true;
              }
            }
            if (!tests.length && !isDefault) throw fail("expected 'case' or 'default'", peek().line);
            const stmts = [];
            while (!at('case') && !at('default') && !at('}')) stmts.push(statement());
            sections.push({ tests, isDefault, stmts });
          }
          expect('}');
          return { kind: 'switch', disc, sections, line: t.line };
        }
        case 'return': {
          next();
          const val = at(';') ? null : expression();
          expect(';');
          return { kind: 'return', val, line: t.line };
        }
        case 'break':
          next();
          expect(';');
          return { kind: 'break', line: t.line };
        case 'continue':
          next();
          expect(';');
          return { kind: 'continue', line: t.line };
        default: {
          const ty = tryDecl();
          if (ty) {
            const d = varDeclRest(ty, t.line);
            expect(';');
            return d;
          }
          const e = expression();
          expect(';');
          return { kind: 'expr', expr: e, line: t.line };
        }
      }
    }

    function varDeclRest(type, line) {
      const name = expect('ident').value;
      let init = null;
      if (at('=')) {
        next();
        init = at('{') ? arrayInit() : expression();
      }
      return { kind: 'var', name, init, type, line };
    }

    // ----- expressions -----

    function expression() {
      return assignment();
    }

    function assignment() {
      const left = coalesce();
      const t = peek();
      if (['=', '+=', '-=', '*=', '/=', '%='].includes(t.type)) {
        next();
        if (!['ident', 'member', 'index'].includes(left.kind)) {
          throw fail('invalid assignment target', t.line);
        }
        return { kind: 'assign', op: t.type, target: left, value: assignment(), line: t.line };
      }
      return left;
    }

    function coalesce() {
      let l = logicalOr();
      while (at('??')) {
        const line = next().line;
        l = { kind: 'bin', op: '??', left: l, right: logicalOr(), line };
      }
      return l;
    }
    function logicalOr() {
      let l = logicalAnd();
      while (at('||')) { const line = next().line; l = { kind: 'bin', op: '||', left: l, right: logicalAnd(), line }; }
      return l;
    }
    function logicalAnd() {
      let l = equality();
      while (at('&&')) { const line = next().line; l = { kind: 'bin', op: '&&', left: l, right: equality(), line }; }
      return l;
    }
    function equality() {
      let l = relational();
      while (at('==') || at('!=')) { const t = next(); l = { kind: 'bin', op: t.type, left: l, right: relational(), line: t.line }; }
      return l;
    }
    function relational() {
      let l = additive();
      while (at('<') || at('>') || at('<=') || at('>=')) { const t = next(); l = { kind: 'bin', op: t.type, left: l, right: additive(), line: t.line }; }
      return l;
    }
    function additive() {
      let l = multiplicative();
      while (at('+') || at('-')) { const t = next(); l = { kind: 'bin', op: t.type, left: l, right: multiplicative(), line: t.line }; }
      return l;
    }
    function multiplicative() {
      let l = unary();
      while (at('*') || at('/') || at('%')) { const t = next(); l = { kind: 'bin', op: t.type, left: l, right: unary(), line: t.line }; }
      return l;
    }
    function unary() {
      const t = peek();
      if (t.type === '!') { next(); return { kind: 'unary', op: '!', value: unary(), line: t.line }; }
      if (t.type === '-') { next(); return { kind: 'unary', op: '-', value: unary(), line: t.line }; }
      if (t.type === '++' || t.type === '--') {
        next();
        return { kind: 'incdec', op: t.type, target: unary(), prefix: true, line: t.line };
      }
      return postfix();
    }

    function callArgs() {
      expect('(');
      const args = [];
      while (!at(')')) {
        if (at('ref') || at('out')) {
          const mode = next().type;
          const save = p;
          let declType = null;
          if (mode === 'out') {
            declType = tryType(false);
            if (declType && !at('ident')) { p = save; declType = null; }
          }
          args.push({ mode, name: expect('ident').value, declType });
        } else {
          args.push({ mode: null, node: expression() });
        }
        if (at(',')) next();
      }
      expect(')');
      return args;
    }

    function postfix() {
      let e = primary();
      for (;;) {
        if (at('(')) {
          const line = peek().line;
          const args = callArgs();
          if (e.kind === 'ident') e = { kind: 'call', name: e.name, args, line };
          else if (e.kind === 'member') e = { kind: 'mcall', obj: e.obj, name: e.name, args, line };
          else throw fail('cannot call this expression', line);
        } else if (at('.')) {
          const line = next().line;
          const name = expect('ident').value;
          e = { kind: 'member', obj: e, name, line };
        } else if (at('[')) {
          const line = next().line;
          const idx = expression();
          expect(']');
          e = { kind: 'index', obj: e, idx, line };
        } else if (at('++') || at('--')) {
          const t = next();
          e = { kind: 'incdec', op: t.type, target: e, prefix: false, line: t.line };
        } else {
          break;
        }
      }
      return e;
    }

    function primary() {
      const t = next();
      switch (t.type) {
        case 'num': return { kind: 'lit', value: t.value, line: t.line };
        case 'str': return { kind: 'lit', value: t.value, line: t.line };
        case 'true': return { kind: 'lit', value: true, line: t.line };
        case 'false': return { kind: 'lit', value: false, line: t.line };
        case 'null': return { kind: 'lit', value: null, line: t.line };
        case 'this': return { kind: 'this', line: t.line };
        case 'istr': {
          const parts = t.value.map((part) => {
            if (part.t === 's') return part;
            const sub = makeParser(lex(part.src));
            return { t: 'e', node: sub.expressionAll(part.line) };
          });
          return { kind: 'istr', parts, line: t.line };
        }
        case 'new': {
          const ty = tryType(false);
          if (!ty) throw fail("expected a type after 'new'", t.line);
          if (ty.isArray) {
            // new int[] { 1, 2, 3 }
            const init = arrayInit();
            return { kind: 'newarray', sizeExpr: null, init, elem: ty.base, line: t.line };
          }
          if (at('[')) {
            next();
            const sizeExpr = expression();
            expect(']');
            const init = at('{') ? arrayInit() : null;
            return { kind: 'newarray', sizeExpr, init, elem: ty.base, line: t.line };
          }
          let args = [];
          if (at('(')) args = callArgs();
          // collection / object initializer: new List<int> { 1, 2 },
          // new Dictionary<K,V> { {k, v} }, new Foo { Field = v }
          let cinit = null;
          if (at('{')) {
            next();
            cinit = [];
            while (!at('}')) {
              if (at('{')) {
                next();
                const k = expression();
                expect(',');
                const v = expression();
                expect('}');
                cinit.push({ pair: [k, v] });
              } else {
                cinit.push({ item: expression() });
              }
              if (at(',')) next();
            }
            expect('}');
          }
          return { kind: 'new', base: ty.base, args, cinit, line: t.line };
        }
        case 'ident': return { kind: 'ident', name: t.value, line: t.line };
        case '(': {
          const e = expression();
          expect(')');
          return e;
        }
        default:
          throw fail(`unexpected '${t.value ?? t.type}'`, t.line);
      }
    }

    // ----- declarations -----

    function funcDecl() {
      const line = peek().line;
      tryType(true); // return type
      const name = expect('ident').value;
      const params = parseParams();
      return { name, params, body: block(), line };
    }

    function isFuncDecl() {
      const start = p;
      const ty = tryType(true);
      const ok = !!ty && at('ident') && peek(1).type === '(';
      p = start;
      return ok;
    }

    function enumDecl() {
      const line = expect('enum').line;
      const name = expect('ident').value;
      expect('{');
      const members = new Map();
      let nextVal = 0;
      while (!at('}')) {
        const mn = expect('ident').value;
        if (at('=')) {
          next();
          let neg = false;
          if (at('-')) { next(); neg = true; }
          const v = expect('num').value;
          nextVal = neg ? -v : v;
        }
        members.set(mn, nextVal++);
        if (at(',')) next();
      }
      expect('}');
      if (at(';')) next();
      return { name, members, line };
    }

    function classDecl(isStaticClass) {
      const kw = next(); // class | struct
      const line = kw.line;
      const name = expect('ident').value;
      expect('{');
      const cls = {
        name,
        isStatic: isStaticClass,
        isStruct: kw.type === 'struct',
        fields: [],
        staticFields: [],
        methods: {},
        staticMethods: {},
        ctors: [],
        line,
      };
      while (!at('}')) {
        let memberStatic = isStaticClass;
        if (at('static')) { next(); memberStatic = true; }
        // constructor: same name as the class, followed by (
        if (at('ident') && peek().value === name && peek(1).type === '(') {
          next();
          const params = parseParams();
          cls.ctors.push({ params, body: block() });
          continue;
        }
        const ty = tryType(true);
        if (!ty) throw fail('expected a class member', peek().line);
        const mname = expect('ident').value;
        if (at('(')) {
          const params = parseParams();
          const m = { name: mname, params, body: block(), line };
          (memberStatic ? cls.staticMethods : cls.methods)[mname] = m;
        } else {
          let init = null;
          if (at('=')) {
            next();
            init = at('{') ? arrayInit() : expression();
          }
          expect(';');
          (memberStatic ? cls.staticFields : cls.fields).push({ name: mname, init, type: ty });
        }
      }
      expect('}');
      return cls;
    }

    function program() {
      const prog = { funcs: {}, classes: {}, enums: {}, body: [] };
      while (!at('eof')) {
        if (at('enum')) {
          const e = enumDecl();
          if (prog.enums[e.name]) throw fail(`enum '${e.name}' is already defined`, e.line);
          prog.enums[e.name] = e;
        } else if (at('static') && (peek(1).type === 'class' || peek(1).type === 'struct')) {
          next();
          const c = classDecl(true);
          if (prog.classes[c.name]) throw fail(`class '${c.name}' is already defined`, c.line);
          prog.classes[c.name] = c;
        } else if (at('class') || at('struct')) {
          const c = classDecl(false);
          if (prog.classes[c.name]) throw fail(`class '${c.name}' is already defined`, c.line);
          prog.classes[c.name] = c;
        } else if (isFuncDecl()) {
          const f = funcDecl();
          if (prog.funcs[f.name]) throw fail(`function '${f.name}' is already defined`, f.line);
          prog.funcs[f.name] = f;
        } else {
          prog.body.push(statement());
        }
      }
      return prog;
    }

    function expressionAll(line = 1) {
      const e = expression();
      if (!at('eof')) throw fail('unexpected text after expression', line);
      return e;
    }

    return { program, expressionAll };
  }

  function parse(src) {
    return makeParser(lex(src)).program();
  }

  // ---------- runtime values ----------

  const mkArray = (items) => ({ cs: 'array', items });
  const mkList = (items = []) => ({ cs: 'list', items });
  const mkDict = () => ({ cs: 'dict', map: new Map() });
  const mkSet = () => ({ cs: 'set', set: new Set() });
  const mkQueue = () => ({ cs: 'queue', items: [] });
  const mkStack = () => ({ cs: 'stack', items: [] });

  function mulberry32(seed) {
    let s = seed | 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function mkRandom(seed) {
    if (seed === undefined) {
      seed = (typeof crypto !== 'undefined' && crypto.getRandomValues)
        ? crypto.getRandomValues(new Uint32Array(1))[0]
        : (Math.random() * 4294967296) | 0;
    }
    return { cs: 'random', rng: mulberry32(seed) };
  }

  class RefCell {
    constructor(env, name) {
      this.env = env;
      this.name = name;
    }
    get() {
      const v = this.env.vars.get(this.name);
      return v instanceof RefCell ? v.get() : v;
    }
    set(v) {
      const cur = this.env.vars.get(this.name);
      if (cur instanceof RefCell) cur.set(v);
      else this.env.vars.set(this.name, v);
    }
  }

  function display(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number' || typeof v === 'string') return String(v);
    switch (v.cs) {
      case 'array': case 'list': return '[' + v.items.map(display).join(', ') + ']';
      case 'dict': return '{' + [...v.map].map(([k, val]) => `${display(k)}: ${display(val)}`).join(', ') + '}';
      case 'set': return '{' + [...v.set].map(display).join(', ') + '}';
      case 'queue': case 'stack': return '[' + v.items.map(display).join(', ') + ']';
      case 'object': return v.cls.name;
      case 'random': return 'Random';
      default: return String(v);
    }
  }

  function defaultFor(type) {
    if (!type || type.nullable || type.isArray) return null;
    switch (type.base) {
      case 'int': case 'float': case 'double': return 0;
      case 'bool': return false;
      case 'string': return '';
      default: return null;
    }
  }

  const isNullish = (v) => v === null || v === undefined;

  // structs are value types: copy on assignment, argument passing and return
  function structCopy(v) {
    if (v && v.cs === 'object' && v.cls.isStruct) {
      const fields = new Map();
      for (const [k, val] of v.fields) fields.set(k, structCopy(val));
      return { cs: 'object', cls: v.cls, fields };
    }
    return v;
  }

  // ---------- interpreter ----------

  const BREAK = Symbol('break');
  const CONTINUE = Symbol('continue');
  class ReturnSig {
    constructor(v) {
      this.v = v;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // C# semantics: conditions and logical operands must be bool — ints do
  // NOT implicitly convert (this is C#, not C++)
  const truthy = (v, line) => {
    if (typeof v !== 'boolean') {
      const t = v === null ? 'null'
        : typeof v === 'number' ? 'int'
        : typeof v === 'string' ? 'string'
        : v && v.cs ? v.cs : typeof v;
      throw fail(`cannot implicitly convert type '${t}' to 'bool' — use a comparison like != 0 or != null`, line);
    }
    return v;
  };

  function applyBin(op, a, b, line) {
    switch (op) {
      case '+':
        if (typeof a === 'string' || typeof b === 'string') return display(a) + display(b);
        return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/':
        if (b === 0) throw fail('division by zero', line);
        return Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) : a / b;
      case '%':
        if (b === 0) throw fail('division by zero', line);
        return a % b;
      case '==': return a === b;
      case '!=': return a !== b;
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      default: throw fail(`unsupported operator '${op}'`, line);
    }
  }

  function iterate(v, line) {
    if (typeof v === 'string') return [...v];
    if (v && v.cs) {
      switch (v.cs) {
        case 'array': case 'list': case 'queue': case 'stack': return [...v.items];
        case 'set': return [...v.set];
        case 'dict': return [...v.map.keys()]; // foreach over a Dictionary yields its keys
      }
    }
    throw fail('value is not iterable', line);
  }

  // locked: (name) => message|null — host hook for progression gating of
  // global names (builtins are gated by the host wrapping them instead).
  // stepDelay: () => ms — minimum dwell per statement, so execution is
  // visibly step-by-step (the active-line highlight lands on every step)
  async function run(program, { builtins = {}, vars = {}, enums = {}, control = {}, onStep, src = null, locked = () => null, stepDelay = () => 0 }) {
    let ops = 0;
    let curSrc = src;

    // built-in enums injected by the host (e.g. Ground, Entity)
    const extEnums = {};
    for (const [n, members] of Object.entries(enums)) {
      extEnums[n] = { name: n, members: members instanceof Map ? members : new Map(Object.entries(members)) };
    }

    async function tick() {
      if (control.stopped) throw new Stop();
      while (control.paused) {
        await sleep(80);
        if (control.stopped) throw new Stop();
      }
      if (++ops % 256 === 0) await sleep(0); // keep the page alive in hot loops
    }

    const globalEnv = { vars: new Map(), parent: null };
    const classStatics = new Map(); // class -> { vars: Map } static frame

    function lookup(env, name) {
      for (let e = env; e; e = e.parent) if (e.vars.has(name)) return e;
      return null;
    }
    function getVar(env, name) {
      const v = env.vars.get(name);
      return v instanceof RefCell ? v.get() : v;
    }
    function setVar(env, name, v) {
      const cur = env.vars.get(name);
      if (cur instanceof RefCell) cur.set(v);
      else env.vars.set(name, v);
    }

    function staticFrameOf(cls) {
      let frame = classStatics.get(cls);
      if (!frame) {
        frame = { vars: new Map(), parent: globalEnv, initialized: false };
        classStatics.set(cls, frame);
      }
      return frame;
    }
    async function ensureStatics(cls) {
      const frame = staticFrameOf(cls);
      if (frame.initialized) return frame;
      frame.initialized = true;
      for (const f of cls.staticFields) {
        frame.vars.set(f.name, f.init ? await evalExpr(f.init, frame) : defaultFor(f.type));
      }
      return frame;
    }

    // ----- lvalues (ident / member / index) -----

    async function readTarget(node, env) {
      switch (node.kind) {
        case 'ident': return identGet(node, env);
        case 'member': return getMember(await evalExpr(node.obj, env), node.name, node.line);
        case 'index': return indexGet(await evalExpr(node.obj, env), await evalExpr(node.idx, env), node.line);
        default: throw fail('invalid target', node.line);
      }
    }

    async function writeTarget(node, v, env) {
      switch (node.kind) {
        case 'ident': {
          const e = lookup(env, node.name);
          if (!e) {
            if (node.name in vars) throw fail(`'${node.name}' is read-only`, node.line);
            throw fail(`unknown variable '${node.name}' (declare it first: var ${node.name} = ...)`, node.line);
          }
          setVar(e, node.name, v);
          return;
        }
        case 'member': {
          const obj = await evalExpr(node.obj, env);
          if (obj && obj.cs === 'object') {
            if (!obj.fields.has(node.name)) throw fail(`'${obj.cls.name}' has no field '${node.name}'`, node.line);
            obj.fields.set(node.name, v);
            return;
          }
          if (obj && obj.cs === 'classref') {
            const frame = await ensureStatics(obj.cls);
            if (!frame.vars.has(node.name)) throw fail(`'${obj.cls.name}' has no static field '${node.name}'`, node.line);
            frame.vars.set(node.name, v);
            return;
          }
          throw fail(`cannot assign to '.${node.name}' here`, node.line);
        }
        case 'index': {
          const obj = await evalExpr(node.obj, env);
          const idx = await evalExpr(node.idx, env);
          indexSet(obj, idx, v, node.line);
          return;
        }
        default: throw fail('invalid assignment target', node.line);
      }
    }

    function identGet(node, env) {
      const e = lookup(env, node.name);
      if (e) return getVar(e, node.name);
      const lk = locked(node.name);
      if (lk) throw fail(lk, node.line);
      if (program.enums[node.name]) return { cs: 'enumref', def: program.enums[node.name] };
      if (extEnums[node.name]) return { cs: 'enumref', def: extEnums[node.name] };
      if (program.classes[node.name]) return { cs: 'classref', cls: program.classes[node.name] };
      if (node.name === 'Math') return { cs: 'mathref' };
      if (node.name in vars) return vars[node.name]();
      throw fail(`unknown variable '${node.name}'`, node.line);
    }

    // ----- members / indexing -----

    function getMember(obj, name, line) {
      if (isNullish(obj)) throw fail(`cannot read '.${name}' of null`, line);
      if (typeof obj === 'string') {
        const lk = locked('strings');
        if (lk) throw fail(lk, line);
        if (name === 'Length') return obj.length;
        throw fail(`string has no property '${name}'`, line);
      }
      switch (obj.cs) {
        case 'enumref': {
          if (obj.def.members.has(name)) return obj.def.members.get(name);
          throw fail(`enum '${obj.def.name}' has no member '${name}'`, line);
        }
        case 'classref': {
          const frame = classStatics.get(obj.cls);
          if (frame && frame.vars.has(name)) return frame.vars.get(name);
          // statics may not be initialized yet — initialize lazily via promise
          // (member reads are sync; force init through an error-free path)
          if (obj.cls.staticFields.some((f) => f.name === name)) {
            throw fail(`static field '${name}' is not initialized yet`, line);
          }
          throw fail(`'${obj.cls.name}' has no static field '${name}'`, line);
        }
        case 'array': {
          if (name === 'Length') return obj.items.length;
          throw fail(`array has no property '${name}'`, line);
        }
        case 'list':
          if (name === 'Count') return obj.items.length;
          throw fail(`List has no property '${name}'`, line);
        case 'dict':
          if (name === 'Count') return obj.map.size;
          if (name === 'Keys') return mkList([...obj.map.keys()]);
          if (name === 'Values') return mkList([...obj.map.values()]);
          throw fail(`Dictionary has no property '${name}'`, line);
        case 'set':
          if (name === 'Count') return obj.set.size;
          throw fail(`HashSet has no property '${name}'`, line);
        case 'queue': case 'stack':
          if (name === 'Count') return obj.items.length;
          throw fail(`${obj.cs === 'queue' ? 'Queue' : 'Stack'} has no property '${name}'`, line);
        case 'object': {
          if (obj.fields.has(name)) return obj.fields.get(name);
          throw fail(`'${obj.cls.name}' has no field '${name}'`, line);
        }
        default:
          throw fail(`value has no property '${name}'`, line);
      }
    }

    function indexGet(obj, idx, line) {
      if (isNullish(obj)) throw fail('cannot index null', line);
      if (typeof obj === 'string') {
        if (idx < 0 || idx >= obj.length) throw fail(`string index ${idx} out of range`, line);
        return obj[idx];
      }
      switch (obj.cs) {
        case 'array': case 'list':
          if (!Number.isInteger(idx) || idx < 0 || idx >= obj.items.length) {
            throw fail(`index ${display(idx)} out of range (length ${obj.items.length})`, line);
          }
          return obj.items[idx];
        case 'dict':
          if (!obj.map.has(idx)) throw fail(`key ${display(idx)} not found in Dictionary`, line);
          return obj.map.get(idx);
        default:
          throw fail('value cannot be indexed', line);
      }
    }

    function indexSet(obj, idx, v, line) {
      if (isNullish(obj)) throw fail('cannot index null', line);
      switch (obj && obj.cs) {
        case 'array': case 'list':
          if (!Number.isInteger(idx) || idx < 0 || idx >= obj.items.length) {
            throw fail(`index ${display(idx)} out of range (length ${obj.items.length})`, line);
          }
          obj.items[idx] = v;
          return;
        case 'dict':
          obj.map.set(idx, v);
          return;
        default:
          throw fail('value cannot be index-assigned', line);
      }
    }

    // ----- method calls -----

    const MATH_FNS = {
      Abs: (x) => Math.abs(x),
      Min: (a, b) => Math.min(a, b),
      Max: (a, b) => Math.max(a, b),
      Floor: (x) => Math.floor(x),
      Ceiling: (x) => Math.ceil(x),
      Sqrt: (x) => Math.sqrt(x),
      Pow: (a, b) => Math.pow(a, b),
    };

    function methodCall(obj, name, args, line) {
      if (isNullish(obj)) throw fail(`cannot call '.${name}()' on null`, line);

      if (obj.cs === 'mathref') {
        const fn = MATH_FNS[name];
        if (!fn) throw fail(`Math has no method '${name}'`, line);
        return fn(...args);
      }
      if (obj.cs === 'random') {
        switch (name) {
          case 'Next':
            if (args.length === 0) return Math.floor(obj.rng() * 2147483647);
            if (args.length === 1) return Math.floor(obj.rng() * args[0]);
            return args[0] + Math.floor(obj.rng() * (args[1] - args[0]));
          case 'NextDouble': return obj.rng();
          default: throw fail(`Random has no method '${name}'`, line);
        }
      }
      if (typeof obj === 'number' || typeof obj === 'boolean') {
        if (name === 'ToString') return display(obj);
        throw fail(`value has no method '${name}'`, line);
      }
      if (typeof obj === 'string') {
        const lk = locked('strings');
        if (lk) throw fail(lk, line);
        switch (name) {
          case 'Substring': return args.length > 1 ? obj.substr(args[0], args[1]) : obj.substring(args[0]);
          case 'Contains': return obj.includes(args[0]);
          case 'StartsWith': return obj.startsWith(args[0]);
          case 'EndsWith': return obj.endsWith(args[0]);
          case 'IndexOf': return obj.indexOf(args[0]);
          case 'Replace': return obj.split(args[0]).join(args[1]);
          case 'ToUpper': return obj.toUpperCase();
          case 'ToLower': return obj.toLowerCase();
          case 'Trim': return obj.trim();
          case 'Split': return mkArray(obj.split(args[0]));
          case 'ToString': return obj;
          default: throw fail(`string has no method '${name}'`, line);
        }
      }
      switch (obj.cs) {
        case 'array':
          if (name === 'ToString') return display(obj);
          throw fail(`array has no method '${name}'`, line);
        case 'list':
          switch (name) {
            case 'Add': obj.items.push(args[0]); return null;
            case 'Insert': obj.items.splice(args[0], 0, args[1]); return null;
            case 'Remove': {
              const i = obj.items.indexOf(args[0]);
              if (i >= 0) { obj.items.splice(i, 1); return true; }
              return false;
            }
            case 'RemoveAt':
              if (args[0] < 0 || args[0] >= obj.items.length) throw fail(`index ${args[0]} out of range`, line);
              obj.items.splice(args[0], 1);
              return null;
            case 'Contains': return obj.items.includes(args[0]);
            case 'IndexOf': return obj.items.indexOf(args[0]);
            case 'Clear': obj.items.length = 0; return null;
            case 'ToString': return display(obj);
            default: throw fail(`List has no method '${name}'`, line);
          }
        case 'dict':
          switch (name) {
            case 'Add':
              if (obj.map.has(args[0])) throw fail(`key ${display(args[0])} already exists`, line);
              obj.map.set(args[0], args[1]);
              return null;
            case 'ContainsKey': return obj.map.has(args[0]);
            case 'ContainsValue': return [...obj.map.values()].includes(args[0]);
            case 'Remove': return obj.map.delete(args[0]);
            case 'Clear': obj.map.clear(); return null;
            case 'ToString': return display(obj);
            default: throw fail(`Dictionary has no method '${name}'`, line);
          }
        case 'set':
          switch (name) {
            case 'Add': {
              if (obj.set.has(args[0])) return false;
              obj.set.add(args[0]);
              return true;
            }
            case 'Contains': return obj.set.has(args[0]);
            case 'Remove': return obj.set.delete(args[0]);
            case 'Clear': obj.set.clear(); return null;
            case 'ToString': return display(obj);
            default: throw fail(`HashSet has no method '${name}'`, line);
          }
        case 'queue':
          switch (name) {
            case 'Enqueue': obj.items.push(args[0]); return null;
            case 'Dequeue':
              if (!obj.items.length) throw fail('Queue is empty', line);
              return obj.items.shift();
            case 'Peek':
              if (!obj.items.length) throw fail('Queue is empty', line);
              return obj.items[0];
            case 'Contains': return obj.items.includes(args[0]);
            case 'Clear': obj.items.length = 0; return null;
            case 'ToString': return display(obj);
            default: throw fail(`Queue has no method '${name}'`, line);
          }
        case 'stack':
          switch (name) {
            case 'Push': obj.items.push(args[0]); return null;
            case 'Pop':
              if (!obj.items.length) throw fail('Stack is empty', line);
              return obj.items.pop();
            case 'Peek':
              if (!obj.items.length) throw fail('Stack is empty', line);
              return obj.items[obj.items.length - 1];
            case 'Contains': return obj.items.includes(args[0]);
            case 'Clear': obj.items.length = 0; return null;
            case 'ToString': return display(obj);
            default: throw fail(`Stack has no method '${name}'`, line);
          }
      }
      return undefined; // signals: not a simple method — handled by caller
    }

    // bind arguments (including ref/out) into a function environment
    async function bindArgs(params, argNodes, fenv, callerEnv, line, fname) {
      if (argNodes.length !== params.length) {
        throw fail(`${fname}() expects ${params.length} argument(s), got ${argNodes.length}`, line);
      }
      for (let ix = 0; ix < params.length; ix++) {
        const param = params[ix];
        const an = argNodes[ix];
        if (param.mode) {
          const lk = locked('ref_out');
          if (lk) throw fail(lk, line);
          if (!an.mode) throw fail(`argument ${ix + 1} of ${fname}() must be passed with '${param.mode}'`, line);
          if (an.mode !== param.mode) throw fail(`argument ${ix + 1}: expected '${param.mode}', got '${an.mode}'`, line);
          if (an.declType) callerEnv.vars.set(an.name, defaultFor(an.declType)); // out int x
          let e = lookup(callerEnv, an.name);
          if (!e) {
            if (an.mode === 'out') {
              callerEnv.vars.set(an.name, null);
              e = callerEnv;
            } else {
              throw fail(`unknown variable '${an.name}'`, line);
            }
          }
          fenv.vars.set(param.name, new RefCell(e, an.name));
        } else {
          if (an.mode) throw fail(`argument ${ix + 1} of ${fname}() does not take '${an.mode}'`, line);
          fenv.vars.set(param.name, structCopy(await evalExpr(an.node, callerEnv)));
        }
      }
    }

    async function callFunction(f, argNodes, callerEnv, line, parentEnv, srcTag) {
      const fenv = { vars: new Map(), parent: parentEnv };
      await bindArgs(f.params, argNodes, fenv, callerEnv, line, f.name || 'function');
      const prevSrc = curSrc;
      if (srcTag !== undefined) curSrc = srcTag;
      try {
        for (const s of f.body.stmts) await evalStmt(s, fenv);
      } catch (sig) {
        if (sig instanceof ReturnSig) return sig.v;
        throw sig;
      } finally {
        curSrc = prevSrc;
      }
      return null;
    }

    async function construct(cls, argNodes, callerEnv, line) {
      const staticFrame = await ensureStatics(cls);
      const inst = { cs: 'object', cls, fields: new Map() };
      for (const f of cls.fields) {
        inst.fields.set(f.name, f.init ? await evalExpr(f.init, staticFrame) : defaultFor(f.type));
      }
      if (cls.ctors.length) {
        const ctor = cls.ctors.find((c) => c.params.length === argNodes.length);
        if (!ctor) throw fail(`no ${cls.name} constructor takes ${argNodes.length} argument(s)`, line);
        const fieldsEnv = { vars: inst.fields, parent: staticFrame };
        const cenv = { vars: new Map([['this', inst]]), parent: fieldsEnv };
        await bindArgs(ctor.params, argNodes, cenv, callerEnv, line, cls.name);
        try {
          for (const s of ctor.body.stmts) await evalStmt(s, cenv);
        } catch (sig) {
          if (!(sig instanceof ReturnSig)) throw sig;
        }
      } else if (argNodes.length) {
        throw fail(`${cls.name} has no constructor taking arguments`, line);
      }
      return inst;
    }

    async function callMethod(inst, m, argNodes, callerEnv, line) {
      const staticFrame = await ensureStatics(inst.cls);
      const fieldsEnv = { vars: inst.fields, parent: staticFrame };
      const menv = { vars: new Map([['this', inst]]), parent: fieldsEnv };
      await bindArgs(m.params, argNodes, menv, callerEnv, line, m.name);
      const prevSrc = curSrc;
      if (inst.cls.src !== undefined) curSrc = inst.cls.src;
      try {
        for (const s of m.body.stmts) await evalStmt(s, menv);
      } catch (sig) {
        if (sig instanceof ReturnSig) return sig.v;
        throw sig;
      } finally {
        curSrc = prevSrc;
      }
      return null;
    }

    async function callStaticMethod(cls, m, argNodes, callerEnv, line) {
      const staticFrame = await ensureStatics(cls);
      const menv = { vars: new Map(), parent: staticFrame };
      await bindArgs(m.params, argNodes, menv, callerEnv, line, m.name);
      const prevSrc = curSrc;
      if (cls.src !== undefined) curSrc = cls.src;
      try {
        for (const s of m.body.stmts) await evalStmt(s, menv);
      } catch (sig) {
        if (sig instanceof ReturnSig) return sig.v;
        throw sig;
      } finally {
        curSrc = prevSrc;
      }
      return null;
    }

    // ----- statements -----

    async function evalStmt(node, env) {
      await tick();
      if (node.kind !== 'block') {
        if (onStep) onStep(node.line, curSrc);
        const d = stepDelay();
        if (d > 0) await sleep(d); // every statement gets its visible moment
      }
      switch (node.kind) {
        case 'block': {
          const e = { vars: new Map(), parent: env };
          for (const s of node.stmts) await evalStmt(s, e);
          return;
        }
        case 'var': {
          const lkVar = locked('variables');
          if (lkVar) throw fail(lkVar, node.line);
          let v;
          if (!node.init) v = defaultFor(node.type);
          else if (node.init.kind === 'arrayinit') v = mkArray(await Promise.all([]));
          if (node.init && node.init.kind === 'arrayinit') {
            const items = [];
            for (const it of node.init.items) items.push(await evalExpr(it, env));
            v = mkArray(items);
          } else if (node.init) {
            v = structCopy(await evalExpr(node.init, env));
          }
          env.vars.set(node.name, v);
          return;
        }
        case 'expr':
          await evalExpr(node.expr, env);
          return;
        case 'if': {
          const lk = locked('if');
          if (lk) throw fail(lk, node.line);
          if (truthy(await evalExpr(node.cond, env), node.cond.line ?? node.line)) await evalStmt(node.then, env);
          else if (node.alt) await evalStmt(node.alt, env);
          return;
        }
        case 'while':
          if (locked('while')) throw fail(locked('while'), node.line);
          while (truthy(await evalExpr(node.cond, env), node.cond.line ?? node.line)) {
            try {
              await evalStmt(node.body, env);
            } catch (sig) {
              if (sig === BREAK) break;
              if (sig !== CONTINUE) throw sig;
            }
            await tick();
          }
          return;
        case 'dowhile':
          if (locked('do_while')) throw fail(locked('do_while'), node.line);
          do {
            try {
              await evalStmt(node.body, env);
            } catch (sig) {
              if (sig === BREAK) break;
              if (sig !== CONTINUE) throw sig;
            }
            await tick();
          } while (truthy(await evalExpr(node.cond, env), node.cond.line ?? node.line));
          return;
        case 'for': {
          if (locked('for')) throw fail(locked('for'), node.line);
          const e = { vars: new Map(), parent: env };
          if (node.init) await evalStmt(node.init, e);
          while (node.cond ? truthy(await evalExpr(node.cond, e), node.cond.line ?? node.line) : true) {
            try {
              await evalStmt(node.body, e);
            } catch (sig) {
              if (sig === BREAK) break;
              if (sig !== CONTINUE) throw sig;
            }
            if (node.step) await evalStmt(node.step, e);
            await tick();
          }
          return;
        }
        case 'foreach': {
          if (locked('foreach')) throw fail(locked('foreach'), node.line);
          const coll = await evalExpr(node.coll, env);
          for (const item of iterate(coll, node.line)) {
            const e = { vars: new Map([[node.name, item]]), parent: env };
            try {
              await evalStmt(node.body, e);
            } catch (sig) {
              if (sig === BREAK) break;
              if (sig !== CONTINUE) throw sig;
            }
            await tick();
          }
          return;
        }
        case 'switch': {
          if (locked('switch')) throw fail(locked('switch'), node.line);
          const disc = await evalExpr(node.disc, env);
          let chosen = null;
          for (const sec of node.sections) {
            for (const test of sec.tests) {
              if ((await evalExpr(test, env)) === disc) {
                chosen = sec;
                break;
              }
            }
            if (chosen) break;
          }
          if (!chosen) chosen = node.sections.find((s) => s.isDefault) || null;
          if (chosen) {
            const e = { vars: new Map(), parent: env };
            try {
              for (const s of chosen.stmts) await evalStmt(s, e);
            } catch (sig) {
              if (sig !== BREAK) throw sig;
            }
          }
          return;
        }
        case 'return':
          throw new ReturnSig(node.val ? structCopy(await evalExpr(node.val, env)) : null);
        case 'break':
          throw BREAK;
        case 'continue':
          throw CONTINUE;
        default:
          throw fail(`unknown statement '${node.kind}'`, node.line);
      }
    }

    // ----- expressions -----

    async function evalExpr(node, env) {
      switch (node.kind) {
        case 'lit':
          if (typeof node.value === 'boolean') {
            const lk = locked('booleans');
            if (lk) throw fail(lk, node.line);
          }
          return node.value;
        case 'this': {
          const e = lookup(env, 'this');
          if (!e) throw fail("'this' is only valid inside a class method", node.line);
          return getVar(e, 'this');
        }
        case 'istr': {
          const lk = locked('strings');
          if (lk) throw fail(lk, node.line);
          let out = '';
          for (const part of node.parts) {
            out += part.t === 's' ? part.v : display(await evalExpr(part.node, env));
          }
          return out;
        }
        case 'arrayinit': {
          const items = [];
          for (const it of node.items) items.push(await evalExpr(it, env));
          return mkArray(items);
        }
        case 'ident':
          return identGet(node, env);
        case 'member':
          return getMember(await evalExpr(node.obj, env), node.name, node.line);
        case 'index':
          return indexGet(await evalExpr(node.obj, env), await evalExpr(node.idx, env), node.line);
        case 'assign': {
          let v = await evalExpr(node.value, env);
          if (node.op !== '=') {
            const cur = await readTarget(node.target, env);
            v = applyBin(node.op[0], cur, v, node.line);
          }
          v = structCopy(v); // structs are value types
          await writeTarget(node.target, v, env);
          return v;
        }
        case 'bin': {
          if (node.op === '&&') {
            return truthy(await evalExpr(node.left, env), node.line) ? truthy(await evalExpr(node.right, env), node.line) : false;
          }
          if (node.op === '||') {
            return truthy(await evalExpr(node.left, env), node.line) ? true : truthy(await evalExpr(node.right, env), node.line);
          }
          if (node.op === '??') {
            const l = await evalExpr(node.left, env);
            return isNullish(l) ? await evalExpr(node.right, env) : l;
          }
          return applyBin(node.op, await evalExpr(node.left, env), await evalExpr(node.right, env), node.line);
        }
        case 'unary': {
          const v = await evalExpr(node.value, env);
          return node.op === '!' ? !truthy(v, node.line) : -v;
        }
        case 'incdec': {
          const cur = await readTarget(node.target, env);
          if (typeof cur !== 'number') throw fail('++/-- needs a numeric variable', node.line);
          const nv = node.op === '++' ? cur + 1 : cur - 1;
          await writeTarget(node.target, nv, env);
          return node.prefix ? nv : cur;
        }
        case 'newarray': {
          if (node.init) {
            const items = [];
            for (const it of node.init.items) items.push(await evalExpr(it, env));
            return mkArray(items);
          }
          const size = await evalExpr(node.sizeExpr, env);
          if (!Number.isInteger(size) || size < 0) throw fail('array size must be a non-negative int', node.line);
          return mkArray(new Array(size).fill(defaultFor({ base: node.elem })));
        }
        case 'new': {
          const lkNew = locked(node.base);
          if (lkNew) throw fail(lkNew, node.line);
          let made;
          switch (node.base) {
            case 'List': made = mkList(); break;
            case 'Dictionary': made = mkDict(); break;
            case 'HashSet': made = mkSet(); break;
            case 'Queue': made = mkQueue(); break;
            case 'Stack': made = mkStack(); break;
            case 'Random': {
              if (node.args.length) {
                const seed = await evalExpr(node.args[0].node, env);
                return mkRandom(seed);
              }
              return mkRandom();
            }
            default: {
              const cls = program.classes[node.base];
              if (!cls) throw fail(`unknown type '${node.base}'`, node.line);
              if (cls.isStatic) throw fail(`'${node.base}' is a static class and cannot be instantiated`, node.line);
              made = await construct(cls, node.args, env, node.line);
            }
          }
          // apply collection / object initializers
          if (node.cinit) {
            for (const entry of node.cinit) {
              if (entry.pair) {
                if (made.cs !== 'dict') throw fail('{ key, value } initializers are for Dictionary', node.line);
                made.map.set(await evalExpr(entry.pair[0], env), structCopy(await evalExpr(entry.pair[1], env)));
              } else if (made.cs === 'object' && entry.item.kind === 'assign' && entry.item.target.kind === 'ident') {
                // object initializer: new Foo { Field = value }
                const fname = entry.item.target.name;
                if (!made.fields.has(fname)) throw fail(`'${made.cls.name}' has no field '${fname}'`, node.line);
                made.fields.set(fname, structCopy(await evalExpr(entry.item.value, env)));
              } else {
                const v = structCopy(await evalExpr(entry.item, env));
                if (made.cs === 'list') made.items.push(v);
                else if (made.cs === 'set') made.set.add(v);
                else throw fail('this type does not support { } initializers', node.line);
              }
            }
          }
          return made;
        }
        case 'call': {
          const f = program.funcs[node.name];
          if (f) return callFunction(f, node.args, env, node.line, globalEnv, f.src);
          if (builtins[node.name]) {
            const args = [];
            for (const a of node.args) {
              if (a.mode) throw fail(`${node.name}() does not take '${a.mode}' arguments`, node.line);
              args.push(await evalExpr(a.node, env));
            }
            try {
              return await builtins[node.name](...args);
            } catch (e) {
              if (e instanceof Stop) throw e;
              throw fail(e.message, node.line); // builtin errors get line numbers
            }
          }
          throw fail(`unknown function '${node.name}'`, node.line);
        }
        case 'mcall': {
          const obj = await evalExpr(node.obj, env);
          // Dictionary.TryGetValue(key, out value) — needs the raw out arg
          if (obj && obj.cs === 'dict' && node.name === 'TryGetValue') {
            if (node.args.length !== 2 || node.args[1].mode !== 'out') {
              throw fail('usage: TryGetValue(key, out value)', node.line);
            }
            const key = await evalExpr(node.args[0].node, env);
            const an = node.args[1];
            if (an.declType) env.vars.set(an.name, defaultFor(an.declType));
            let e = lookup(env, an.name);
            if (!e) {
              env.vars.set(an.name, null);
              e = env;
            }
            const has = obj.map.has(key);
            setVar(e, an.name, has ? obj.map.get(key) : null);
            return has;
          }
          // user-defined class instances and static classes first
          if (obj && obj.cs === 'object') {
            const m = obj.cls.methods[node.name] || obj.cls.staticMethods[node.name];
            if (!m) throw fail(`'${obj.cls.name}' has no method '${node.name}'`, node.line);
            return obj.cls.methods[node.name]
              ? callMethod(obj, m, node.args, env, node.line)
              : callStaticMethod(obj.cls, m, node.args, env, node.line);
          }
          if (obj && obj.cs === 'classref') {
            const m = obj.cls.staticMethods[node.name];
            if (!m) throw fail(`'${obj.cls.name}' has no static method '${node.name}'`, node.line);
            return callStaticMethod(obj.cls, m, node.args, env, node.line);
          }
          // built-in values: evaluate plain args and dispatch
          const args = [];
          for (const a of node.args) {
            if (a.mode) throw fail(`'.${node.name}()' does not take '${a.mode}' arguments`, node.line);
            args.push(structCopy(await evalExpr(a.node, env)));
          }
          const r = methodCall(obj, node.name, args, node.line);
          if (r === undefined) throw fail(`value has no method '${node.name}'`, node.line);
          return r;
        }
        default:
          throw fail(`unknown expression '${node.kind}'`, node.line);
      }
    }

    // declared-but-locked constructs error up front with their line
    for (const en of Object.values(program.enums)) {
      const lk = locked('enum');
      if (lk) throw fail(lk, en.line);
    }
    for (const cls of Object.values(program.classes)) {
      const lk = locked('classes');
      if (lk) throw fail(lk, cls.line);
    }

    try {
      for (const s of program.body) await evalStmt(s, globalEnv);
    } catch (sig) {
      if (sig instanceof ReturnSig) return; // top-level return ends the script
      throw sig;
    }
  }

  return { parse, run, Stop };
})();
