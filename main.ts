// main.ts is mend, the CLI SPEC.md specifies: Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none, printing what it changed or why it failed.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

interface Move {
  old: string;
  nw: string;
}
interface RunCtx {
  moves: Move[];
  strict: boolean;
}

type Edit = (tree: Tree, ctx: RunCtx) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 3: a file as lines, its own break, and whether it ends with one. ----

interface LineFile {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): LineFile {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function writeFile(lf: LineFile): string {
  if (lf.lines.length === 0) return '';
  return lf.lines.join(lf.br) + (lf.finalBreak ? lf.br : '');
}

// ---- Section 5: matching lines at three tiers. ----

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  return a.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') === b.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `o` occurs at or after `from`; `eof` keeps only occurrences that end at the file's last line. */
function findTier(lines: string[], o: string[], strict: boolean, from: number, eof: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = occurrences(lines, o, t, from);
    if (eof) pos = pos.filter((p) => p + o.length === lines.length);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function reindent(line: string, tier: number, f: string, p: string): string {
  if (tier !== 2) return line;
  if (line === '' || line.trim() === '') return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

interface OLine {
  text: string;
  ctx: boolean;
}

/** The lines that replace a matched block: a context line is the file's own matched line, every other line is the
 * patch's line, re-indented at tier 2. */
function buildReplacement(oldLines: OLine[], newLines: OLine[], fileLines: string[], at: number, tier: number): string[] {
  const f = leadingWs(fileLines[at] ?? '');
  const p = leadingWs(oldLines[0]!.text);
  const out: string[] = [];
  let oi = 0;
  for (const nl of newLines) {
    if (nl.ctx) {
      while (oi < oldLines.length && !oldLines[oi]!.ctx) oi++;
      out.push(oi < oldLines.length ? fileLines[at + oi]! : nl.text);
      oi++;
    } else {
      out.push(reindent(nl.text, tier, f, p));
    }
  }
  return out;
}

// ---- Section 6: unified diffs. ----

interface Hunk {
  a: number;
  old: OLine[];
  nw: OLine[];
  plus: { text: string; noNl: boolean }[];
  lastCtxPlusNoNl: boolean;
  lastPlusNoNl: boolean;
}

interface Section {
  kind: 'change' | 'create' | 'delete' | 'move';
  oldPath: string | null;
  newPath: string | null;
  hunks: Hunk[];
}

function pathFromHeader(l: string): string {
  let s = l.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  return s.trim();
}

function stripPrefix(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

interface BodyEntry {
  kind: ' ' | '-' | '+';
  text: string;
  noNl: boolean;
}

function parseHunk(lines: string[], at: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[at]!);
  if (!m) throw new Exit2(`error: parse ${at + 1}`);
  const a = Number(m[1]);
  const raw: string[] = [];
  let j = at + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      raw.push(l);
      j++;
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const body: BodyEntry[] = [];
  for (const l of raw) {
    if (l[0] === '\\') {
      if (body.length > 0) body[body.length - 1]!.noNl = true;
    } else if (l === '') {
      body.push({ kind: ' ', text: '', noNl: false });
    } else {
      body.push({ kind: l[0] as ' ' | '-' | '+', text: l.slice(1), noNl: false });
    }
  }
  const old: OLine[] = [];
  const nw: OLine[] = [];
  const plus: { text: string; noNl: boolean }[] = [];
  for (const e of body) {
    if (e.kind === ' ') {
      old.push({ text: e.text, ctx: true });
      nw.push({ text: e.text, ctx: true });
    } else if (e.kind === '-') {
      old.push({ text: e.text, ctx: false });
    } else {
      nw.push({ text: e.text, ctx: false });
      plus.push({ text: e.text, noNl: e.noNl });
    }
  }
  let lastCtxPlusNoNl = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === ' ' || body[k]!.kind === '+') {
      lastCtxPlusNoNl = body[k]!.noNl;
      break;
    }
  }
  const lastPlusNoNl = plus.length > 0 ? plus[plus.length - 1]!.noNl : false;
  return { hunk: { a, old, nw, plus, lastCtxPlusNoNl, lastPlusNoNl }, next: j };
}

function parseUnifiedSection(lines: string[], start: number): { sec: Section; next: number } {
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  let headerOld: string | null = null;
  let headerNew: string | null = null;
  let hasHeaderOld = false;
  let hasHeaderNew = false;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let newFile = false;
  let deletedFile = false;
  let sawOld = false;
  const hunks: Hunk[] = [];
  let i = start;
  if (lines[i]!.startsWith('diff --git ')) {
    const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[i]!);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    diffOld = m[1]!;
    diffNew = m[2]!;
    i++;
  }
  let inHeader = true;
  while (i < lines.length) {
    const l = lines[i]!;
    if (inHeader) {
      if (l.startsWith('@@')) {
        const h = parseHunk(lines, i);
        hunks.push(h.hunk);
        i = h.next;
        inHeader = false;
        continue;
      }
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        if (sawOld) break;
        headerOld = stripPrefix(pathFromHeader(l));
        hasHeaderOld = true;
        sawOld = true;
        i++;
        continue;
      }
      if (l.startsWith('+++ ')) {
        headerNew = stripPrefix(pathFromHeader(l));
        hasHeaderNew = true;
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        renameFrom = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        renameTo = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        newFile = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const h = parseHunk(lines, i);
      hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    i++;
  }
  const oldPath = hasHeaderOld ? headerOld : (renameFrom ?? diffOld);
  const newPath = hasHeaderNew ? headerNew : (renameTo ?? diffNew);
  const kind: Section['kind'] = newFile || oldPath === null ? 'create' : deletedFile || newPath === null ? 'delete' : oldPath !== newPath ? 'move' : 'change';
  return { sec: { kind, oldPath, newPath, hunks }, next: i };
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      const s = parseUnifiedSection(lines, i);
      sections.push(s.sec);
      i = s.next;
    } else {
      i++;
    }
  }
  return sections.map((sec) => unifiedSectionEdit(sec));
}

function applyHunk(lf: LineFile, h: Hunk, d: number, strict: boolean, path: string): void {
  const o = h.old.map((e) => e.text);
  if (o.length === 0) {
    const pos = Math.min(h.a + d, lf.lines.length);
    const atEnd = pos === lf.lines.length;
    lf.lines.splice(pos, 0, ...h.nw.map((e) => e.text));
    if (atEnd) lf.finalBreak = !h.lastPlusNoNl;
    return;
  }
  const found = findTier(lf.lines, o, strict, 0, false);
  if (!found) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  for (const p of found.pos) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const atEnd = best + o.length === lf.lines.length;
  const repl = buildReplacement(h.old, h.nw, lf.lines, best, found.tier);
  lf.lines.splice(best, o.length, ...repl);
  if (atEnd) lf.finalBreak = !h.lastCtxPlusNoNl;
}

function unifiedSectionEdit(sec: Section): Edit {
  return (tree, ctx) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (sec.kind === 'create') {
      const p = newP ?? '';
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plusLines: string[] = [];
      for (const h of sec.hunks) for (const e of h.plus) plusLines.push(e.text);
      const lastPlusNoNl = sec.hunks.length > 0 && sec.hunks[sec.hunks.length - 1]!.plus.length > 0 ? sec.hunks[sec.hunks.length - 1]!.plus[sec.hunks[sec.hunks.length - 1]!.plus.length - 1]!.noNl : false;
      tree.now.set(p, plusLines.length === 0 ? '' : plusLines.join('\n') + (lastPlusNoNl ? '' : '\n'));
      return;
    }
    if (sec.kind === 'delete') {
      const p = oldP ?? '';
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP ?? '';
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (sec.kind === 'move') {
      const np = newP ?? '';
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const lf = parseFile(cur);
      let d = 0;
      for (const h of sec.hunks) {
        applyHunk(lf, h, d, ctx.strict, p);
        d += h.nw.length - h.old.length;
      }
      const out = writeFile(lf);
      tree.now.set(np, out);
      tree.now.set(p, null);
      ctx.moves.push({ old: p, nw: np });
      return;
    }
    const lf = parseFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      applyHunk(lf, h, d, ctx.strict, p);
      d += h.nw.length - h.old.length;
    }
    tree.now.set(p, writeFile(lf));
  };
}

// ---- Section 7: SEARCH/REPLACE blocks. ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree, ctx) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const lf = parseFile(cur);
    const found = findTier(lf.lines, oldLines, strict, 0, false);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const repl = buildReplacement(
      oldLines.map((t) => ({ text: t, ctx: false })),
      newLines.map((t) => ({ text: t, ctx: false })),
      lf.lines,
      at,
      found.tier,
    );
    lf.lines.splice(at, oldLines.length, ...repl);
    tree.now.set(path, writeFile(lf));
  };
}

// ---- Section 8: V4A patches. ----

interface VChunk {
  anchor: string | null;
  old: OLine[];
  nw: OLine[];
  eof: boolean;
}

function isV4aSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return -1;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let j = first + 1;
  while (j < last) {
    const l = lines[j]!;
    if (blank(l)) {
      j++;
      continue;
    }
    const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : l.startsWith('*** Update File: ') ? 'update' : null;
    if (kind === null) throw new Exit2(`error: parse ${j + 1}`);
    const headerLine = j + 1;
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = l.slice(prefix.length).trim();
    j++;
    const bodyStart = j;
    while (j < last && !isV4aSectionStart(lines[j]!) && lines[j]!.trim() !== '*** End Patch') j++;
    const body = lines.slice(bodyStart, j);
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    edits.push(v4aSectionEdit(kind, path, body, bodyStart + 1, headerLine, strict));
  }
  return edits;
}

function v4aSectionEdit(kind: 'add' | 'delete' | 'update', path: string, body: string[], bodyStartLine: number, headerLine: number, strict: boolean): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < body.length; k++) {
      const l = body[k]!;
      if (l === '') fileLines.push('');
      else if (l[0] === '+') fileLines.push(l.slice(1));
      else throw new Exit2(`error: parse ${bodyStartLine + k}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (let k = 0; k < body.length; k++) {
      throw new Exit2(`error: parse ${bodyStartLine + k}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let k = 0;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = body[0]!.slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let first = true;
  while (k < body.length) {
    const l = body[k]!;
    const lineNo = bodyStartLine + k;
    if (l.startsWith('@@')) {
      if (cur) chunks.push(cur);
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, old: [], nw: [], eof: false };
      first = false;
      k++;
      continue;
    }
    if (l === '*** End of File') {
      if (!cur) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      first = false;
      k++;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (!cur) {
        if (!first) throw new Exit2(`error: parse ${lineNo}`);
        cur = { anchor: null, old: [], nw: [], eof: false };
      }
      if (l === '') {
        cur.old.push({ text: '', ctx: true });
        cur.nw.push({ text: '', ctx: true });
      } else if (l[0] === ' ') {
        cur.old.push({ text: l.slice(1), ctx: true });
        cur.nw.push({ text: l.slice(1), ctx: true });
      } else if (l[0] === '-') {
        cur.old.push({ text: l.slice(1), ctx: false });
      } else {
        cur.nw.push({ text: l.slice(1), ctx: false });
      }
      k++;
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree, ctx) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const lf = parseFile(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const ai = findAnchor(lf.lines, ch.anchor, cursor, strict);
        if (ai < 0) throw new Fail('no-match', path);
        cursor = ai + 1;
      }
      const o = ch.old.map((e) => e.text);
      if (o.length === 0) {
        const pos = ch.eof ? lf.lines.length : cursor;
        const ins = ch.nw.map((e) => e.text);
        lf.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
        continue;
      }
      const found = findTier(lf.lines, o, strict, cursor, ch.eof);
      if (!found) throw new Fail('no-match', path);
      const at = found.pos[0]!;
      const repl = buildReplacement(ch.old, ch.nw, lf.lines, at, found.tier);
      lf.lines.splice(at, o.length, ...repl);
      cursor = at + repl.length;
    }
    const out = writeFile(lf);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      ctx.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---- Section 1, 2 and 10: the command line, the output, and the all-or-nothing write. ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const ctx: RunCtx = { moves: [], strict };
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree, ctx);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const mv of ctx.moves) {
    if (tree.original(mv.old) !== null && tree.get(mv.old) === null && tree.original(mv.nw) === null && tree.get(mv.nw) !== null) {
      rows.push({ key: mv.nw, line: `R ${mv.old} -> ${mv.nw}` });
      suppressed.add(mv.old);
      suppressed.add(mv.nw);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
