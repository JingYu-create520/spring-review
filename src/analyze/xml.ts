import { LineIndex } from "../util/text.js";
import type { MapperStatement, MapperXml } from "../types.js";

/**
 * MyBatis mapper XML reader.
 *
 * Deliberately not a generic XML DOM: we need statement bodies as *text* (SQL is
 * only valid once `<if>`/`<where>` fragments are inlined), plus accurate line
 * numbers for the findings. XML comments are stripped first — a `${}` inside
 * `<!-- -->` must never fire MYB001.
 */

const STATEMENT_TAGS = new Set(["select", "insert", "update", "delete"]);

interface RawTag {
  closing: boolean;
  selfClosing: boolean;
  name: string;
  attrs: Record<string, string>;
  /** Offset of `<`. */
  start: number;
  /** Offset just after `>`. */
  end: number;
}

const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
const ATTR = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function stripXmlComments(text: string): string {
  // Preserve offsets by blanking rather than removing.
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      const stop = end < 0 ? text.length : end + 3;
      for (let k = i; k < stop; k++) if (out[k] !== "\n") out[k] = " ";
      i = stop;
      continue;
    }
    i++;
  }
  return out.join("");
}

function parseTag(text: string, match: RegExpExecArray, start: number): RawTag {
  const attrs: Record<string, string> = {};
  const attrText = match[3] ?? "";
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  const attrRe = new RegExp(ATTR.source, "g");
  while ((m = attrRe.exec(attrText))) {
    attrs[m[1] as string] = (m[3] ?? m[4] ?? "").trim();
  }
  return {
    closing: match[1] === "/",
    selfClosing: /\/\s*$/.test(attrText),
    name: match[2] as string,
    attrs,
    start,
    end: start + match[0].length,
  };
}

function unwrapCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_all, inner: string) => inner);
}

/**
 * Remove child tags but keep their text (MyBatis dynamic SQL is inline) — except
 * the tags that *emit a SQL keyword*, which are replaced by the word they put
 * into the statement. `<where>` contributes `WHERE`, `<set>` contributes `SET`,
 * `<trim prefix="WHERE">` contributes its prefix. Erasing them is what made a
 * statement whose WHERE lives in an included `<sql>` fragment read as "no WHERE,
 * full-table read" — the false positive came from stripping the evidence, not
 * from the SQL.
 */
export function stripTags(text: string): string {
  return text
    .replace(/<where\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, " where ")
    .replace(/<set\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, " set ")
    .replace(/<trim\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (_all, attrs: string) => {
      const prefix = /\bprefix\s*=\s*["']([^"']+)["']/i.exec(attrs);
      return prefix ? ` ${prefix[1]} ` : " ";
    })
    .replace(/<\/?[A-Za-z_][\w:.-]*(?:"[^"]*"|'[^']*'|[^"'>])*\/?>/g, " ");
}

/**
 * The document's root element name, for telling a mapper file from an XML
 * document that merely *contains* `<select>`: MyBatis' own site docs are
 * `<document>` files whose `<source>` blocks hold mapper examples, and every
 * rule fires happily on them. Comments are blanked and `<?xml`, `<!DOCTYPE` and
 * `<![CDATA[` never match the name pattern, so the first hit is the root.
 * `undefined` means no root element is present at all, which is the case for a
 * unit rebuilt from a header-less patch fragment — that one must stay readable.
 */
export function rootElementOf(source: string): string | undefined {
  const masked = stripXmlComments(source);
  const m = /<([A-Za-z_][\w:.-]*)(?:"[^"]*"|'[^']*'|[^"'>])*[>/]/.exec(masked);
  return m?.[1];
}

export function analyzeMapperXml(path: string, source: string): MapperXml {
  const masked = stripXmlComments(source);
  const lines = new LineIndex(source);
  const diagnostics: string[] = [];
  const statements: MapperStatement[] = [];
  const fragments: Record<string, { body: string; line: number }> = {};
  const resultMaps: MapperXml["resultMaps"] = [];
  let namespace: string | undefined;

  // A mapper is recognised by its root *or* by MyBatis statement signatures:
  // a unit rebuilt from a patch fragment has holes where the <mapper> tag is, and
  // must still be readable. `resultType=`/`namespace=` keeps HTML `<select id>` out.
  const isMapper =
    /<\s*mapper[\s>]/.test(masked) ||
    /<\s*(select|insert|update|delete)\s+[^>]*(resultType|resultMap|parameterType|useGeneratedKeys)=/.test(masked) ||
    /<\s*mapper\s+namespace\s*=/.test(masked);
  if (!isMapper) {
    diagnostics.push("root element is not <mapper> — skipped");
    return {
      path,
      source,
      lines: source.split("\n"),
      statements: [],
      fragments: {},
      resultMaps: [],
      diagnostics,
    };
  }

  const stack: RawTag[] = [];
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  let currentMap: { id: string; line: number; nestedSelectLines: number[] } | null = null;

  while ((m = TAG.exec(masked))) {
    const start = m.index ?? 0;
    const tag = parseTag(masked, m, start);
    if (tag.name === "mapper" && !tag.closing) {
      namespace = tag.attrs["namespace"];
      continue;
    }
    if (tag.name === "resultMap") {
      if (!tag.closing && !tag.selfClosing) {
        currentMap = { id: tag.attrs["id"] ?? "", line: lines.lineOf(start), nestedSelectLines: [] };
        continue;
      }
      if (tag.closing && currentMap) {
        resultMaps.push(currentMap);
        currentMap = null;
      }
      continue;
    }
    if ((tag.name === "collection" || tag.name === "association") && tag.attrs["select"] && currentMap) {
      currentMap.nestedSelectLines.push(lines.lineOf(start));
    }

    if (STATEMENT_TAGS.has(tag.name) && !tag.closing) {
      const bodyStart = tag.end;
      let bodyEnd = -1;
      if (tag.selfClosing) {
        bodyEnd = bodyStart;
      } else {
        const close = new RegExp(`</\\s*${tag.name}\\s*>`, "i").exec(masked.slice(bodyStart));
        if (!close) {
          diagnostics.push(`unclosed <${tag.name}> at line ${lines.lineOf(start)}`);
          continue;
        }
        bodyEnd = bodyStart + (close.index ?? 0);
      }
      const rawBody = unwrapCdata(masked.slice(bodyStart, bodyEnd));
      const id = tag.attrs["id"] ?? "";
      statements.push({
        kind: tag.name,
        id,
        rawSql: rawBody,
        sql: stripTags(rawBody).replace(/\s+/g, " ").trim(),
        line: lines.lineOf(start),
        endLine: lines.lineOf(Math.max(bodyEnd, tag.end)),
        attributes: tag.attrs,
      });
      TAG.lastIndex = tag.selfClosing ? tag.end : bodyEnd + `</${tag.name}>`.length;
      continue;
    }

    if (tag.name === "sql" && !tag.closing && !tag.selfClosing) {
      const close = /<\/\s*sql\s*>/i.exec(masked.slice(tag.end));
      if (close) {
        const id = tag.attrs["id"] ?? "";
        const bodyEnd = tag.end + (close.index ?? 0);
        if (id) fragments[id] = { body: unwrapCdata(masked.slice(tag.end, bodyEnd)), line: lines.lineOf(start) };
        TAG.lastIndex = bodyEnd + `</sql>`.length;
      }
      continue;
    }
    stack.push(tag);
    if (stack.length > 200) break;
  }

  if (statements.length === 0 && Object.keys(fragments).length === 0) {
    diagnostics.push("no <select>/<insert>/<update>/<delete> and no <sql> fragment found");
  }
  return {
    path,
    source,
    lines: source.split("\n"),
    namespace,
    statements: statements.sort((a, b) => a.line - b.line),
    fragments,
    resultMaps,
    diagnostics,
  };
}

/**
 * Find a `<sql>` fragment by refid. MyBatis accepts the namespace-qualified form
 * for a fragment in the same file (`refid="demo.UserMapper.Cols"`), so that
 * prefix is stripped before giving up. A refid pointing into *another* file is
 * not resolvable here — that file is reviewed on its own, which is where its
 * `${}` will be reported.
 */
function fragmentOf(xml: MapperXml, refid: string): { body: string; line: number } | undefined {
  const id = refid.trim();
  const direct = xml.fragments[id];
  if (direct) return direct;
  const prefix = xml.namespace ? `${xml.namespace}.` : undefined;
  if (prefix && id.startsWith(prefix)) return xml.fragments[id.slice(prefix.length)];
  return undefined;
}

/** Refids a statement or fragment asks for that this file cannot supply. */
export function unresolvedIncludes(xml: MapperXml, rawText: string): string[] {
  const out: string[] = [];
  for (const m of rawText.matchAll(/<include[^>]*refid=["']([^"']+)["'][^>]*\/?>/gi)) {
    const refid = (m[1] ?? "").trim();
    if (refid && !fragmentOf(xml, refid) && !out.includes(refid)) out.push(refid);
  }
  return out;
}

/** Inline `<include refid="…"/>` fragments so keyword checks see the real SQL. */
export function inlineFragments(xml: MapperXml, rawText: string): string {
  let text = rawText;
  for (let pass = 0; pass < 3; pass++) {
    const re = /<include[^>]*refid=["']([^"']+)["'][^>]*\/?>/gi;
    let replaced = false;
    text = text.replace(re, (_all, refid: string) => {
      const fragment = fragmentOf(xml, refid);
      if (!fragment) return " ";
      replaced = true;
      return ` ${unwrapCdata(fragment.body)} `;
    });
    if (!replaced) break;
  }
  return stripTags(text).replace(/\s+/g, " ").trim();
}

export function resolveIncludes(xml: MapperXml, statement: MapperStatement): string {
  return inlineFragments(xml, statement.rawSql);
}

/** Line number of the first match of `re` inside a statement's own range. */
export function findStatementLine(
  xml: MapperXml,
  statement: MapperStatement,
  re: RegExp,
  fallback = statement.line,
): number {
  const from = xml.lines.slice(statement.line - 1, statement.endLine);
  for (let i = 0; i < from.length; i++) {
    re.lastIndex = 0;
    if (re.test(from[i] as string)) return statement.line + i;
  }
  return fallback;
}

export function looksLikeMapperPath(path: string): boolean {
  return /\.xml$/i.test(path);
}

/** Java-side `@Select("…")` style SQL, found in mapper interfaces. */
export function annotationSql(java: { source: string }, annotationName: string): string {
  const re = new RegExp(`@${annotationName}\\s*\\(((?:[^()]|\\([^()]*\\))*)\\)`, "g");
  let out = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(java.source))) out += ` ${(m[1] ?? "").replace(/"?\s*\+\s*"?/g, " ").replace(/"/g, " ")} `;
  return out.replace(/\s+/g, " ").trim();
}
