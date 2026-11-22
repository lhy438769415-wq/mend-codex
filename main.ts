// mend applies unified, SEARCH/REPLACE, V4A and JSON patches to a local tree.
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

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
  if (p === '' || p.startsWith('/') || p.includes('\\') || p.split('/').some((s) => s === '' || s === '.' || s === '..')) return false;
  // Check existing ancestors as well, since an edit can create a new file.
  for (let part = p; part !== '.'; part = dirname(part)) {
    try {
      lstatSync(part);
    } catch {
      continue;
    }
    try {
      return withinTree(realpathSync(part));
    } catch {
      return false;
    }
  }
  return true;
}

function withinTree(path: string): boolean {
  const fromRoot = relative(process.cwd(), path);
  return fromRoot !== '..' && !fromRoot.startsWith('..' + sep) && !isAbsolute(fromRoot);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly moves: { path: string; target: string }[] = [];
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

type Edit = (tree: Tree) => void;

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

function parseError(index: number): never {
  throw new Exit2(`error: parse ${index + 1}`);
}

function checkPath(path: string): void {
  if (!safe(path)) throw new Fail('unsafe', path);
}

function requireFile(tree: Tree, path: string): string {
  const text = tree.get(path);
  if (text === null) throw new Fail('missing', path);
  return text;
}

function requireAbsent(tree: Tree, path: string): void {
  if (tree.get(path) !== null) throw new Fail('exists', path);
}

function readLines(text: string) {
  const firstBreak = text.indexOf('\n');
  const br = firstBreak > 0 && text[firstBreak - 1] === '\r' ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function writeLines(lines: string[], br = '\n', final = true): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

const normalizeLine = [
  (line: string) => line,
  (line: string) => line.replace(/[ \t]+$/, ''),
  (line: string) => line.replace(/^[ \t]+|[ \t]+$/g, ''),
];

function findLines(lines: string[], old: string[], strict: boolean, start = 0, endOnly = false) {
  const last = lines.length - old.length;
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const normalize = normalizeLine[tier]!;
    const needle = old.map(normalize);
    const positions: number[] = [];
    for (let at = endOnly ? Math.max(start, last) : start; at <= last; at++) {
      if (needle.every((line, offset) => line === normalize(lines[at + offset]!))) positions.push(at);
    }
    if (positions.length) return { tier, positions };
  }
  return null;
}

type NewLine = { text: string; context?: number; noBreak?: boolean };
type LineEdit = { old: string[]; next: NewLine[] };

function addBodyLine(edit: LineEdit, line: string): void {
  const prefix = line[0] ?? ' ';
  const text = line.slice(1);
  if (prefix === '+') {
    edit.next.push({ text });
    return;
  }
  if (prefix === ' ') edit.next.push({ text, context: edit.old.length });
  edit.old.push(text);
}

function replaceLines(lines: string[], at: number, edit: LineEdit, tier: number): string[] {
  const from = edit.old[0]?.match(/^[ \t]*/)?.[0] ?? '';
  const to = lines[at]?.match(/^[ \t]*/)?.[0] ?? '';
  const next = edit.next.map(({ text, context }) => {
    if (context !== undefined) return lines[at + context]!;
    if (tier === 2 && !blank(text) && text.startsWith(from)) return to + text.slice(from.length);
    return text;
  });
  return lines.slice(0, at).concat(next, lines.slice(at + edit.old.length));
}

function finishEdit(tree: Tree, path: string, target: string, text: string): void {
  if (target !== path) {
    tree.now.set(path, null);
    tree.moves.push({ path, target });
  }
  tree.now.set(target, text);
}

function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousPath: string | undefined;
  let candidate: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimEnd() !== '<<<<<<< SEARCH') {
      const path = line.trim();
      if (path && !path.startsWith('```')) candidate = path;
      continue;
    }

    const path = candidate ?? previousPath ?? parseError(i);
    const separator = lines.findIndex((line, index) => index > i && line.trimEnd() === '=======');
    const end = separator < 0 ? -1 : lines.findIndex((line, index) => index > separator && line.trimEnd() === '>>>>>>> REPLACE');
    if (end < 0) parseError(i);
    const old = lines.slice(i + 1, separator);
    const next = lines.slice(separator + 1, end).map((text) => ({ text }));
    edits.push((tree) => {
      checkPath(path);
      if (old.length === 0) {
        requireAbsent(tree, path);
        tree.now.set(path, writeLines(next.map(({ text }) => text)));
        return;
      }
      const file = readLines(requireFile(tree, path));
      const match = findLines(file.lines, old, strict);
      if (!match) throw new Fail('no-match', path);
      if (match.positions.length > 1) throw new Fail('ambiguous', path);
      const result = replaceLines(file.lines, match.positions[0]!, { old, next }, match.tier);
      tree.now.set(path, writeLines(result, file.br, file.final));
    });
    previousPath = path;
    candidate = undefined;
    i = end;
  }
  return edits;
}

type Hunk = LineEdit & { start: number };
type Unified = {
  oldPath: string | null;
  newPath: string | null;
  paired: boolean;
  create: boolean;
  delete: boolean;
  hunks: Hunk[];
};

function unifiedPath(text: string): string | null {
  const path = text.split('\t', 1)[0]!.trim();
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
}

function unifiedEdit(section: Unified, strict: boolean): Edit {
  return (tree) => {
    const { oldPath, newPath, hunks } = section;
    if (oldPath !== null) checkPath(oldPath);
    if (newPath !== null) checkPath(newPath);
    if (section.create || oldPath === null) {
      const path = newPath ?? '';
      checkPath(path);
      requireAbsent(tree, path);
      const added = hunks.flatMap((hunk) => hunk.next.filter((line) => line.context === undefined));
      tree.now.set(path, writeLines(added.map((line) => line.text), '\n', !added.at(-1)?.noBreak));
      return;
    }
    const before = requireFile(tree, oldPath);
    if (section.delete || newPath === null) {
      tree.now.set(oldPath, null);
      return;
    }
    if (newPath !== oldPath) requireAbsent(tree, newPath);
    const file = readLines(before);
    let delta = 0;
    for (const hunk of hunks) {
      let at = Math.max(0, Math.min(hunk.start + delta, file.lines.length));
      let tier = 0;
      if (hunk.old.length) {
        const match = findLines(file.lines, hunk.old, strict);
        if (!match) throw new Fail('no-match', oldPath);
        tier = match.tier;
        const expected = hunk.start - 1 + delta;
        at = match.positions.reduce((best, pos) =>
          Math.abs(pos - expected) < Math.abs(best - expected) ? pos : best);
      }
      if (at + hunk.old.length === file.lines.length) file.final = !hunk.next.at(-1)?.noBreak;
      file.lines = replaceLines(file.lines, at, hunk, tier);
      delta += hunk.next.length - hunk.old.length;
    }
    finishEdit(tree, oldPath, newPath, writeLines(file.lines, file.br, file.final));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let section: Unified | undefined;
  function open(oldPath: string | null, newPath: string | null, paired: boolean) {
    if (section) edits.push(unifiedEdit(section, strict));
    section = { oldPath, newPath, paired, create: false, delete: false, hunks: [] };
    return section;
  }
  const isPair = (i: number) => lines[i]?.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!header) parseError(i);
      open(header[1]!, header[2]!, false);
    } else if (isPair(i)) {
      const oldPath = unifiedPath(line.slice(4));
      const newPath = unifiedPath(lines[++i]!.slice(4));
      if (section && !section.paired && section.hunks.length === 0) {
        Object.assign(section, { oldPath, newPath, paired: true });
      } else {
        open(oldPath, newPath, true);
      }
    } else if (line.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (!section || !header) parseError(i);
      const hunk: Hunk = { start: Number(header[1]), old: [], next: [] };
      let end = i + 1;
      while (end < lines.length && !isPair(end) && /^(?:[ +\\-]|$)/.test(lines[end]!)) end++;
      let contentEnd = end;
      while (contentEnd > i + 1 && lines[contentEnd - 1] === '') contentEnd--;
      let previousNew: NewLine | undefined;
      for (let j = i + 1; j < contentEnd; j++) {
        const body = lines[j]!;
        if (body.startsWith('\\')) {
          if (previousNew) previousNew.noBreak = true;
          previousNew = undefined;
        } else {
          addBodyLine(hunk, body);
          previousNew = body.startsWith('-') ? undefined : hunk.next.at(-1);
        }
      }
      section.hunks.push(hunk);
      i = end - 1;
    } else if (section && section.hunks.length === 0) {
      if (line.startsWith('--- ')) parseError(i + 1);
      if (line.startsWith('new file mode')) section.create = true;
      if (line.startsWith('deleted file mode')) section.delete = true;
      if (!section.paired) {
        if (line.startsWith('rename from ')) section.oldPath = line.slice(12);
        if (line.startsWith('rename to ')) section.newPath = line.slice(10);
      }
    }
  }
  if (section) edits.push(unifiedEdit(section, strict));
  return edits;
}

type Chunk = LineEdit & { anchor: string; endOnly: boolean };

function v4aUpdate(lines: string[], start: number, end: number, path: string, strict: boolean): Edit {
  let i = start + 1;
  let target: string | undefined;
  if (i < end && lines[i]!.startsWith('*** Move to: ')) target = lines[i++]!.slice(13).trim();
  const chunks: Chunk[] = [];
  while (i < end) {
    const line = lines[i]!;
    const chunk: Chunk = { anchor: '', endOnly: false, old: [], next: [] };
    if (line.startsWith('@@')) {
      chunk.anchor = line.slice(2).trim();
      i++;
    } else if (chunks.length > 0 || !/^(?:[ +\-]|$)/.test(line)) {
      parseError(i);
    }
    while (i < end && /^(?:[ +\-]|$)/.test(lines[i]!)) addBodyLine(chunk, lines[i++]!);
    if (i < end && lines[i] === '*** End of File') {
      chunk.endOnly = true;
      i++;
    }
    chunks.push(chunk);
  }
  if (!chunks.length && target === undefined) parseError(start);

  return (tree) => {
    checkPath(path);
    if (target !== undefined) checkPath(target);
    const file = readLines(requireFile(tree, path));
    if (target !== undefined) requireAbsent(tree, target);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor) {
        const match = findLines(file.lines, [chunk.anchor], strict, cursor);
        if (!match) throw new Fail('no-match', path);
        cursor = match.positions[0]! + 1;
      }

      let at = chunk.endOnly ? file.lines.length : cursor;
      let tier = 0;
      if (chunk.old.length) {
        const match = findLines(file.lines, chunk.old, strict, cursor, chunk.endOnly);
        if (!match) throw new Fail('no-match', path);
        at = match.positions[0]!;
        tier = match.tier;
      }
      file.lines = replaceLines(file.lines, at, chunk, tier);
      cursor = at + chunk.next.length;
    }
    finishEdit(tree, path, target ?? path, writeLines(file.lines, file.br, file.final));
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') parseError(Math.max(first, 0));
  let last = lines.length - 1;
  while (blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') parseError(lines.length);

  const header = /^\*\*\* (Add|Delete|Update) File: (.*)$/;
  const edits: Edit[] = [];
  for (let i = first + 1; i < last;) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const section = header.exec(lines[i]!);
    if (!section) parseError(i);
    const path = section[2]!.trim();
    let next = i + 1;
    while (next < last && !header.test(lines[next]!)) next++;
    let end = next;
    while (end > i + 1 && blank(lines[end - 1]!)) end--;

    if (section[1] === 'Update') {
      edits.push(v4aUpdate(lines, i, end, path, strict));
    } else if (section[1] === 'Add') {
      const added: string[] = [];
      for (let j = i + 1; j < end; j++) {
        if (lines[j] !== '' && !lines[j]!.startsWith('+')) parseError(j);
        added.push(lines[j]!.slice(1));
      }
      edits.push((tree) => {
        checkPath(path);
        requireAbsent(tree, path);
        tree.now.set(path, writeLines(added));
      });
    } else {
      if (end > i + 1) parseError(i + 1);
      edits.push((tree) => {
        checkPath(path);
        requireFile(tree, path);
        tree.now.set(path, null);
      });
    }
    i = next;
  }
  return edits;
}

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
    if (file === null) {
      text = readFileSync(0, 'utf8');
    } else {
      if (isAbsolute(file) || !withinTree(resolve(file)) || !withinTree(realpathSync(file))) {
        return { code: 2, out: ['error: no-patch'] };
      }
      text = readFileSync(file, 'utf8');
    }
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    switch (kind) {
      case 'json': edits = jsonEdits(text, lines); break;
      case 'unified': edits = unifiedEdits(lines, strict); break;
      case 'search-replace': edits = searchEdits(lines, strict); break;
      default: edits = v4aEdits(lines, strict);
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: string[] = [];
  const renamed = new Map<string, string>();
  const movedFrom = new Set<string>();
  for (const { path, target } of tree.moves) {
    if (movedFrom.has(path) || renamed.has(target)) continue;
    if (tree.original(path) !== null && tree.get(path) === null &&
        tree.original(target) === null && tree.get(target) !== null) {
      renamed.set(target, path);
      movedFrom.add(path);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const source = renamed.get(p);
    if (source !== undefined) rows.push(`R ${source} -> ${p}`);
    else if (!movedFrom.has(p)) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
