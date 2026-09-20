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

/** Remove child tags but keep their text (MyBatis dynamic SQL is inline). */
export function stripTags(text: string): string {
  return text.replace(/<\/?[A-Za-z_][\w:.-]*(?:"[^"]*"|'[^']*'|[^"'>])*\/?>/g, " ");
}

export function analyzeMapperXml(path: string, source: string): MapperXml {
  const masked = stripXmlComments(source);
  const lines = new LineIndex(source);
  const diagnostics: string[] = [];
  const statements: MapperStatement[] = [];
  const fragments: Record<string, string> = {};
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
        if (id) fragments[id] = unwrapCdata(masked.slice(tag.end, tag.end + (close.index ?? 0)));
        TAG.lastIndex = tag.end + (close.index ?? 0) + `</sql>`.length;
      }
      continue;
    }
    stack.push(tag);
    if (stack.length > 200) break;
  }

  if (statements.length === 0) diagnostics.push("no <select>/<insert>/<update>/<delete> found");
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

/** Inline `<include refid="…"/>` fragments so keyword checks see the real SQL. */
export function resolveIncludes(xml: MapperXml, statement: MapperStatement): string {
  let text = statement.rawSql;
  for (let pass = 0; pass < 3; pass++) {
    const re = /<include[^>]*refid=["']([^"']+)["'][^>]*\/?>/gi;
    let replaced = false;
    text = text.replace(re, (_all, refid: string) => {
      const body = xml.fragments[refid.trim()];
      if (body === undefined) return " ";
      replaced = true;
      return ` ${unwrapCdata(body)} `;
    });
    if (!replaced) break;
  }
  return stripTags(text).replace(/\s+/g, " ").trim();
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
