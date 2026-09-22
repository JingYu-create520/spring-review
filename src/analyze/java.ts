import { LineIndex, matchBrace, splitTopLevel } from "../util/text.js";
import type { JavaAnnotation, JavaField, JavaFile, JavaMember, JavaType } from "../types.js";

/**
 * Lightweight Java structure extractor: no javaparser, no type resolution.
 * It answers exactly the questions the rules need —
 *   which types/methods/fields exist and what annotations they carry,
 *   where a method body begins and ends, what is called inside it.
 *
 * All structure is computed over a *masked* copy of the source where comment and
 * string/char literal bodies are replaced by spaces (length and line breaks
 * preserved), so a brace inside `"{"` or `// {` cannot corrupt the state machine.
 * Snippets and line numbers always come from the raw source.
 *
 * Failure mode is deliberately conservative: what we cannot understand is pushed
 * to {@link JavaFile.diagnostics} and the rules stay silent.
 */

const MODIFIERS = new Set([
  "public",
  "protected",
  "private",
  "static",
  "final",
  "abstract",
  "synchronized",
  "native",
  "transient",
  "volatile",
  "default",
  "strictfp",
  "sealed",
]);

/** Words followed by `(` that are not method invocations. */
const NON_CALLEE_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "do",
  "else",
  "try",
  "throw",
  "case",
  "synchronized",
  "super",
  "this",
  "new",
  "assert",
  "instanceof",
  "yield",
]);

function* iterate(text: string, re: RegExp): Generator<RegExpExecArray> {
  const local = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = local.exec(text))) yield m;
}

/**
 * Replace comment / literal bodies with spaces, keeping length and newlines.
 *
 * `keepStrings` is for the one place that reads *inside* a string literal — the
 * SQL of an `@Select("…")` — where blanking the literals would blank the input.
 * Comments still go, because annotation examples in Javadoc are not code: on
 * mybatis-3 the unmasked scan reported `select *` from the `@Select` javadoc of
 * `annotations/Select.java` as if it were a query somebody wrote.
 */
export function maskJavaLiterals(src: string, opts: { keepStrings?: boolean } = {}): string {
  const keepStrings = opts.keepStrings === true;
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (keepStrings) {
      i += 1;
      continue;
    }
    if (ch === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      let end = src.indexOf('"""', i + 3);
      end = end < 0 ? src.length : end + 3;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < src.length) {
        const c = src[j] as string;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break; // unterminated literal: stop at the line end
        if (c === quote) {
          j++;
          break;
        }
        j++;
      }
      blank(i, Math.min(j, src.length));
      i = j;
      continue;
    }
    i++;
  }
  return out.join("");
}

const NAMED_TYPE = /(?:^|[^\w$.])(class|interface|enum|record)\s+([A-Za-z_$]\w*)/g;
const ANON_TYPE = /(?:^|[^\w$.])new\s+([A-Za-z_$][\w$.]*)\s*(\([^()]*\))?\s*\{/g;

export const STEREOTYPES = [
  "Component",
  "Service",
  "RestController",
  "Controller",
  "Repository",
  "Configuration",
  "ControllerAdvice",
  "RestControllerAdvice",
  "Mapper",
];

/** Annotation readers need line numbers, so a LineIndex is threaded through. */
interface Ctx {
  masked: string;
  /** Comments blanked, string literals intact — the text an annotation argument is read from. */
  commentMasked: string;
  lines: LineIndex;
}

function declarationStart(masked: string, keywordAt: number): number {
  let i = keywordAt;
  while (i > 0) {
    const ch = masked[i - 1] as string;
    if (ch === ";" || ch === "}" || ch === "{") return i;
    i--;
  }
  return 0;
}

function collectTypes(ctx: Ctx): JavaType[] {
  const { masked, lines } = ctx;
  const found: JavaType[] = [];

  const remember = (
    kind: JavaType["kind"],
    name: string,
    keywordOffset: number,
    bodyStart: number,
    bodyEnd: number,
  ) => {
    const declStart = declarationStart(masked, keywordOffset);
    const header = masked.slice(declStart, bodyStart);
    found.push({
      name,
      kind,
      annotations: readAnnotations(header, declStart, lines, ctx.commentMasked),
      modifiers: readModifiers(header),
      declStart,
      bodyStart,
      bodyEnd,
      line: lines.lineOf(keywordOffset),
      endLine: lines.lineOf(bodyEnd),
      anonymous: kind === "anonymous",
      enclosing: null,
      nested: [],
    });
  };

  for (const m of iterate(masked, NAMED_TYPE)) {
    const kind = m[1] as JavaType["kind"];
    const name = m[2] as string;
    const keywordOffset = (m.index ?? 0) + 1; // +1: the lookahead char
    const bodyStart = masked.indexOf("{", keywordOffset + m[0].length - 2);
    if (bodyStart < 0) continue;
    const bodyEnd = matchBrace(masked, bodyStart);
    if (bodyEnd < 0) continue;
    remember(kind, name, keywordOffset, bodyStart, bodyEnd);
  }

  for (const m of iterate(masked, ANON_TYPE)) {
    const typeName = m[1] as string;
    const head = (m.index ?? 0) + 1; // offset of `new`
    const brace = (m.index ?? 0) + m[0].length - 1;
    if (/\[\s*\]?\s*$/.test(masked.slice(head, brace))) continue; // `new int[]{…}`
    const bodyEnd = matchBrace(masked, brace);
    if (bodyEnd < 0) continue;
    remember("anonymous", `${typeName}<anonymous>`, head, brace, bodyEnd);
  }

  found.sort((a, b) => a.declStart - b.declStart);
  for (let i = 0; i < found.length; i++) {
    const candidate = found[i] as JavaType;
    let best: number | null = null;
    for (let j = 0; j < i; j++) {
      const outer = found[j] as JavaType;
      if (candidate.declStart > outer.bodyStart && candidate.declStart < outer.bodyEnd) best = j;
    }
    candidate.enclosing = best;
    if (best !== null) found[best]?.nested.push(i);
  }
  return found;
}

function readModifiers(header: string): string[] {
  return header.split(/[\s,]+/).filter((w) => MODIFIERS.has(w));
}

/**
 * Balanced-paren annotation reader; `baseOffset` makes offsets file-absolute.
 *
 * Structure (where the argument list ends) is decided on the masked copy, so a
 * `)` inside a string cannot close the annotation early. The argument *text* is
 * then re-read from `argText` — the copy with string literals intact — because an
 * argument that is a literal is the value rules need: reading
 * `@Cacheable(key = "#code+':'+#key")` out of the masked copy yields `key =` and
 * the rule concludes no key was given.
 */
export function readAnnotations(
  text: string,
  baseOffset: number,
  lines?: LineIndex,
  argText?: string,
): JavaAnnotation[] {
  const out: JavaAnnotation[] = [];
  const re = /@([A-Za-z_$][\w$.]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const offset = baseOffset + (m.index ?? 0);
    let after = (m.index ?? 0) + m[0].length;
    while (after < text.length && /[ \t\n]/.test(text[after] as string)) after++;
    let args: string | undefined;
    if (text[after] === "(") {
      const close = matchBrace(text, after, "(", ")");
      if (close > 0) {
        args = (argText ?? text).slice(baseOffset + after + 1, baseOffset + close).trim();
        re.lastIndex = close;
      }
    }
    const full = m[1] as string;
    out.push({
      name: full.split(".").pop() as string,
      full,
      args,
      offset,
      line: lines ? lines.lineOf(offset) : 0,
    });
  }
  return out;
}

const METHOD_SHAPE =
  /^(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>\s+)?([\w$.<>,\[\] ]+?)\s+([A-Za-z_$]\w*)\s*\(([\s\S]*)\)\s*(?:throws\s+([\w$.,\s]+))?$/;
const CTOR_SHAPE =
  /^(?:(?:public|protected|private)\s+)?([A-Za-z_$]\w*)\s*\(([\s\S]*)\)\s*(?:throws\s+([\w$.,\s]+))?$/;
const FIELD_SHAPE =
  /^(?:(?:public|protected|private|static|final|transient|volatile)\s+)*([\w$.<>,\[\]\s?]+?)\s+([A-Za-z_$]\w*(?:\s*,\s*[A-Za-z_$]\w*)*)$/;

export function analyzeJava(path: string, source: string): JavaFile {
  const masked = maskJavaLiterals(source);
  const commentMasked = maskJavaLiterals(source, { keepStrings: true });
  const lines = new LineIndex(source);
  const ctx: Ctx = { masked, commentMasked, lines };
  const diagnostics: string[] = [];
  const types = collectTypes(ctx);
  const members: JavaMember[] = [];
  const fields: JavaField[] = [];

  for (let ti = 0; ti < types.length; ti++) {
    const type = types[ti] as JavaType;
    const end = type.bodyEnd;
    let i = type.bodyStart + 1;
    let guard = 0;
    while (i < end && guard++ < 50000) {
      // Anchor the segment at its first real token, not at the previous member's
      // closing brace — findings are reported on the annotation/signature line.
      while (i < end && /\s/.test(masked[i] as string)) i++;
      if (i >= end) break;
      const segStart = i;
      let j = i;
      let depth = 0;
      let blockStart = -1;
      while (j < end) {
        const c = masked[j] as string;
        if (c === "(" || c === "[") depth++;
        else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
        else if (depth === 0 && c === ";") break;
        else if (depth === 0 && (c === "{" || c === "}")) {
          if (c === "{") blockStart = j;
          break;
        }
        j++;
      }
      const header = masked.slice(segStart, blockStart >= 0 ? blockStart : j).trim();

      if (blockStart >= 0) {
        const close = matchBrace(masked, blockStart);
        if (close < 0) {
          diagnostics.push(`unbalanced '{' near line ${lines.lineOf(blockStart)}`);
          break;
        }
        const member = parseMember(header, ti, type, close, blockStart, segStart, lines, false, commentMasked);
        if (member) members.push(member);
        else {
          const field = parseField(header, segStart, lines, commentMasked);
          if (field) fields.push(field);
        }
        i = close + 1;
      } else {
        const member = parseMember(header, ti, type, -1, -1, segStart, lines, true, commentMasked);
        if (member) members.push(member);
        else {
          const field = parseField(header, segStart, lines, commentMasked);
          if (field) fields.push(field);
        }
        i = j + 1;
      }
    }
  }

  members.sort((a, b) => a.start - b.start);
  fields.sort((a, b) => a.start - b.start);
  return {
    path,
    source,
    masked,
    commentMasked,
    index: lines,
    lines: source.split("\n"),
    types,
    members,
    fields,
    diagnostics,
  };
}

function parseMember(
  rawHeader: string,
  typeIndex: number,
  type: JavaType,
  bodyEnd: number,
  blockStart: number,
  segStart: number,
  lines: LineIndex,
  declarationOnly: boolean,
  argText?: string,
): JavaMember | null {
  const header = rawHeader.trim().replace(/;+$/, "").trim();
  if (!header) return null;
  // A nested type declaration, not a member. Must not trip on `Exception.class`.
  if (/(?:^|[^\w$.])(?:class|interface|enum|record)\s+[A-Za-z_$]/.test(header)) return null;
  const annotations = readAnnotations(header, segStart, lines, argText);
  const stripped = stripAnnotations(header);
  if (!stripped) return null;

  const modifiers = readModifiers(stripped);
  // Leading modifiers are removed first: `public Foo()` would otherwise read as
  // return type `public`, method name `Foo`.
  const bare = stripped.replace(
    /^(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)+/,
    "",
  );

  const finish = (m: RegExpExecArray, kind: JavaMember["kind"], name: string, returnType: string, params: string[], throwsRaw: string): JavaMember | null => {
    if (kind === "method" && !returnType) return null;
    if (NON_CALLEE_KEYWORDS.has(name)) return null;
    return {
      kind,
      name,
      owner: typeIndex,
      annotations,
      modifiers,
      returnType: returnType || undefined,
      params,
      // As written, qualified or not: `looksChecked` matches the simple name at
      // the end either way, and the finding has to name the exception the author
      // wrote rather than each dot-separated piece of it.
      throwsTypes: splitTopLevel(throwsRaw).map((s) => s.trim()).filter(Boolean),
      abstract: declarationOnly || modifiers.includes("abstract") || type.kind === "interface",
      start: segStart,
      bodyStart: blockStart,
      bodyEnd,
      line: lines.lineOf(segStart),
      endLine: lines.lineOf(bodyEnd < 0 ? segStart : bodyEnd),
    };
  };

  const ctor = CTOR_SHAPE.exec(bare);
  if (ctor && (ctor[1] as string) === type.name && !declarationOnly) {
    return finish(ctor, "constructor", ctor[1] as string, "", splitTopLevel((ctor[2] as string).trim()), ctor[3] ?? "");
  }
  const m = METHOD_SHAPE.exec(bare);
  if (m) {
    const returnType = (m[1] as string).trim();
    const name = (m[2] as string).trim();
    if (returnType.split(/\s+/).some((w) => MODIFIERS.has(w))) return null;
    return finish(m, "method", name, returnType, splitTopLevel((m[3] as string).trim()), m[4] ?? "");
  }
  if (ctor && (ctor[1] as string) === type.name) {
    // Constructor declaration in an interface/abstract context — still a ctor.
    return finish(ctor, "constructor", ctor[1] as string, "", splitTopLevel((ctor[2] as string).trim()), ctor[3] ?? "");
  }
  return null;
}

function parseField(header: string, segStart: number, lines: LineIndex, argText?: string): JavaField | null {
  const trimmed = header.trim().replace(/;+$/, "").trim();
  if (!trimmed) return null;
  const annotations = readAnnotations(trimmed, segStart, lines, argText);
  const stripped = stripAnnotations(trimmed);
  if (!stripped) return null;
  if (/^(package|import|extends|implements|assert)\b/.test(stripped)) return null;
  const eq = topLevelEquals(stripped);
  const declaration = (eq >= 0 ? stripped.slice(0, eq) : stripped).trim();
  // Only the *declaration* part may be paren-free; `= new HashMap<>()` is fine.
  if (declaration.includes("(") || declaration.includes(")")) return null;
  const m = FIELD_SHAPE.exec(declaration);
  if (!m) return null;
  const type = (m[1] as string).trim();
  const names = splitTopLevel(m[2] as string).map((n) => n.trim());
  if (!names.length || !type) return null;
  // `Foo bar` where Foo is really part of a construct we do not model — keep it simple.
  if (MODIFIERS.has(type) || NON_CALLEE_KEYWORDS.has(type)) return null;
  return {
    names,
    type,
    annotations,
    modifiers: readModifiers(declaration),
    initializer: eq >= 0 ? stripped.slice(eq + 1).trim() : undefined,
    line: lines.lineOf(segStart),
    start: segStart,
    end: segStart + trimmed.length,
  };
}

/** Index of the first `=` that is not part of `==`, `!=`, `<=`, `>=`. */
function topLevelEquals(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === "=" && depth === 0) {
      const prev = text[i - 1];
      const next = text[i + 1];
      if (prev === "=" || prev === "!" || prev === "<" || prev === ">") continue;
      if (next === "=") continue;
      return i;
    }
  }
  return -1;
}

export function stripAnnotations(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "@" && /^@[A-Za-z_$]/.test(text.slice(i))) {
      let j = i + 1;
      while (j < text.length && /[\w$.]/.test(text[j] as string)) j++;
      let k = j;
      while (k < text.length && /\s/.test(text[k] as string)) k++;
      if (text[k] === "(") {
        const close = matchBrace(text, k, "(", ")");
        j = close < 0 ? text.length : close + 1;
      }
      out += " ";
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/\s+/g, " ").trim();
}

export function findAnnotation(
  annotations: JavaAnnotation[],
  ...names: string[]
): JavaAnnotation | undefined {
  return annotations.find((a) => names.includes(a.name));
}

export function hasAnnotation(annotations: JavaAnnotation[], ...names: string[]): boolean {
  return findAnnotation(annotations, ...names) !== undefined;
}

export interface CallSite {
  callee: string;
  /** Receiver chain without the callee; empty means a bare `foo()` call. */
  receiver: string[];
  args: string;
  offset: number;
  line: number;
}

/** Nested type bodies that are inside `member` — `this` there is another object. */
export function nestedBodiesWithin(java: JavaFile, member: JavaMember): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const collect = (index: number) => {
    const type = java.types[index];
    if (!type) return;
    for (const child of type.nested) {
      const ct = java.types[child];
      if (!ct) continue;
      if (ct.bodyStart > member.bodyStart && ct.bodyEnd < member.bodyEnd) out.push([ct.bodyStart, ct.bodyEnd]);
      collect(child);
    }
  };
  collect(member.owner);
  return out;
}

/** Every `name(...)` invocation textually inside a member body. */
export function callSites(java: JavaFile, member: JavaMember): CallSite[] {
  if (member.bodyStart < 0) return [];
  const text = java.masked;
  // The file's own index: `java.source` is unchanged, so rebuilding it per member
  // was pure cost — a 20k-method generated class took 20s per rule that asks.
  const lines = java.index;
  const opaque = nestedBodiesWithin(java, member);
  const hidden = (offset: number) => opaque.some(([a, b]) => offset > a && offset < b);
  const out: CallSite[] = [];
  for (let i = member.bodyStart; i < member.bodyEnd; i++) {
    if (text[i] !== "(") continue;
    let j = i - 1;
    while (j > member.bodyStart && /\s/.test(text[j] as string)) j--;
    const end = j + 1;
    while (j > member.bodyStart && /[\w$.]/.test(text[j] as string)) j--;
    const chain = text.slice(j + 1, end);
    if (!chain) continue;
    if (hidden(j + 1)) continue;
    if (!/^[A-Za-z_$][\w$.]*$/.test(chain)) continue;
    const parts = chain.split(".").filter(Boolean);
    const callee = parts.pop() as string;
    if (!callee || NON_CALLEE_KEYWORDS.has(callee)) continue;
    const before = text.slice(Math.max(0, j - 20), j + 1);
    if (/\bnew\s+$/.test(before)) continue;
    if (/@[\w$.]*\s*$/.test(before)) continue; // annotation usage
    const close = matchBrace(text, i, "(", ")");
    out.push({
      callee,
      receiver: parts,
      args: text.slice(i + 1, close < 0 ? member.bodyEnd : close),
      offset: j + 1,
      line: lines.lineOf(i),
    });
  }
  return out;
}

export interface LoopRange {
  kind: "for" | "while" | "forEach" | "stream";
  start: number;
  end: number;
  line: number;
}

/** Outermost iteration bodies inside a member — the N+1 haystack. */
/**
 * Is the receiver of a `.map(` / `.flatMap(` a call that yields **one** element?
 *
 * `Optional.map` runs its lambda at most once, so it is not a per-element loop.
 * Reading it as one turned a plain single-row update —
 * `repository.findByName(name).map(existing -> repository.save(existing))`, seen
 * in a real gateway service — into a reported N+1. Only an explicitly
 * collection-shaped receiver (`…All`, `…List`, `…Ids`, `.stream()`, `.list()`)
 * stays in the loop set.
 *
 * Known limit: an Optional held in a local variable (`Optional<User> u = …; u.map(…)`)
 * is still treated as a stream, since resolving it needs the symbol table.
 */
function receiverIsSingleResult(text: string, dotIndex: number, bodyStart: number): boolean {
  let i = dotIndex - 1;
  while (i > bodyStart && /\s/.test(text[i] as string)) i--;
  if (text[i] !== ")") return false;
  let depth = 0;
  for (let j = i; j > bodyStart; j--) {
    const ch = text[j];
    if (ch === ")") depth++;
    else if (ch === "(") {
      depth--;
      if (depth > 0) continue;
      let k = j - 1;
      while (k >= 0 && /[\w$.]/.test(text[k] as string)) k--;
      const callee = text.slice(k + 1, j).split(".").pop() ?? "";
      if (callee === "") return false;
      return !/(?:all|list|stream|ids|s)$/i.test(callee) && /^(?:find|get|load|select|query|reference|of)/i.test(callee);
    }
  }
  return false;
}

export function loopRanges(java: JavaFile, member: JavaMember): LoopRange[] {
  if (member.bodyStart < 0) return [];
  const text = java.masked;
  const lines = java.index;
  const opaque = nestedBodiesWithin(java, member);
  const hidden = (offset: number) => opaque.some(([a, b]) => offset > a && offset < b);
  const patterns: Array<{ kind: LoopRange["kind"]; re: RegExp }> = [
    { kind: "for", re: /\bfor\s*\(/g },
    { kind: "while", re: /\bwhile\s*\(/g },
    { kind: "forEach", re: /\.forEach\s*\(/g },
    { kind: "stream", re: /\.(map|mapToInt|mapToLong|flatMap|peek)\s*\(/g },
  ];
  const out: LoopRange[] = [];
  const covered: Array<[number, number]> = [];
  for (const { kind, re } of patterns) {
    for (const m of iterate(text.slice(member.bodyStart, member.bodyEnd), re)) {
      const at = member.bodyStart + (m.index ?? 0);
      if (at > member.bodyEnd) continue;
      if (hidden(at)) continue;
      if (kind === "stream" && receiverIsSingleResult(text, at, member.bodyStart)) continue;
      if (covered.some(([a, b]) => at > a && at < b)) continue; // keep outermost only
      const open = text.indexOf("(", at);
      if (open < 0) continue;
      const parenClose = matchBrace(text, open, "(", ")");
      if (parenClose < 0) continue;
      let k = parenClose + 1;
      while (k < member.bodyEnd && /\s/.test(text[k] as string)) k++;
      let start: number;
      let end: number;
      if (text[k] === "{") {
        start = k;
        end = matchBrace(text, k);
      } else if (kind === "for" || kind === "while") {
        const semi = text.indexOf(";", k);
        start = k;
        end = semi < 0 || semi > member.bodyEnd ? member.bodyEnd : semi;
      } else {
        // `forEach(x -> …)` / `map(x -> …)`: the lambda body lives inside the call
        // parentheses, whether or not it uses braces.
        start = open + 1;
        end = parenClose;
      }
      if (end <= start) continue;
      covered.push([start, end]);
      out.push({ kind, start, end, line: lines.lineOf(at) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Identifiers assigned or mutated inside a member body → their first line. */
export function writtenIdentifiers(java: JavaFile, member: JavaMember): Map<string, number> {
  const map = new Map<string, number>();
  if (member.bodyStart < 0) return map;
  const text = java.masked;
  const opaque = nestedBodiesWithin(java, member);
  const hidden = (offset: number) => opaque.some(([a, b]) => offset > a && offset < b);
  const re =
    /([A-Za-z_$]\w*)\s*(?:=(?!=)|\+=|-=|\*=|\/=|%=|\+\+|--)|([A-Za-z_$]\w*)\s*\.\s*(?:add|addAll|put|putAll|putIfAbsent|merge|compute|computeIfAbsent|remove|removeAll|retainAll|clear|set|setAll|sort|replace|replaceAll|offer|push|increment)\s*\(/g;
  const body = text.slice(member.bodyStart, member.bodyEnd);
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const at = member.bodyStart + (m.index ?? 0);
    if (hidden(at)) continue;
    const name = (m[1] ?? m[2]) as string;
    if (m[1] && isLocalDeclaration(body.slice(0, m.index ?? 0), name)) continue;
    if (!map.has(name)) map.set(name, java.index.lineOf(at));
  }
  return map;
}

/** `int x = 1` / `Map<K,V> cache = new HashMap<>()` declare a local, they do not write a field. */
function isLocalDeclaration(prefix: string, name: string): boolean {
  const trimmed = prefix.trimEnd();
  if (/\b(?:int|long|double|float|boolean|byte|char|short|var)\s*$/.test(trimmed)) return true;
  const lastWord = trimmed.split(/[\s,;(<]+/).pop() ?? "";
  if (!/^[A-Za-z_$][\w$.<>\[\]]*$/.test(lastWord) || lastWord === name) return false;
  return /^[A-Z]/.test(lastWord) || /[>\]]$/.test(lastWord);
}

/**
 * Members that belong to one type. Memoised per file: rules ask this once per
 * call site, and a generated class with 20k methods turned each ask into a full
 * scan of the member list — 40s of CI for one file.
 */
const membersByOwner = new WeakMap<JavaFile, Map<number, JavaMember[]>>();

export function methodsOf(java: JavaFile, typeIndex: number): JavaMember[] {
  let byOwner = membersByOwner.get(java);
  if (!byOwner) {
    byOwner = new Map();
    membersByOwner.set(java, byOwner);
  }
  let owned = byOwner.get(typeIndex);
  if (!owned) {
    owned = java.members.filter((m) => m.owner === typeIndex);
    byOwner.set(typeIndex, owned);
  }
  return owned;
}

export function isSpringBeanType(type: JavaType): boolean {
  return hasAnnotation(type.annotations, ...STEREOTYPES);
}

/** True when `thrown` looks like a checked exception (not RuntimeException/Error). */
export function looksChecked(thrown: string): boolean {
  if (!thrown) return false;
  return !/(^|\.)((Runtime)?Exception|Error|Throwable|RuntimeException|IllegalArgumentException|IllegalStateException|UnsupportedOperationException|ConcurrentModificationException|NumberFormatException|ArithmeticException|NullPointerException|ClassCastException)$/i.test(
    thrown,
  );
}
