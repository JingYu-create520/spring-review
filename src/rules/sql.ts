import { inlineFragments, resolveIncludes, stripTags } from "../analyze/xml.js";
import type { JavaFile, MapperXml } from "../types.js";

/**
 * One searchable piece of SQL, whether it came from a mapper XML statement or a
 * `@Select("…")` annotation. `raw` keeps the dynamic-SQL tags (needed to tell
 * `<where>` from a real WHERE), `resolved` has fragments inlined and tags
 * stripped (needed for keyword checks). Both keep `line` as the offset base so
 * findings land on the right line.
 */
export interface SqlScope {
  /** `sql` = a `<sql id="…">` fragment; text rules scan it, shape rules skip it. */
  kind: "select" | "insert" | "update" | "delete" | "sql" | "other";
  id: string;
  raw: string;
  resolved: string;
  line: number;
  source: "xml" | "annotation";
}

export function lineAt(text: string, offset: number, base: number): number {
  let line = base;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

export function xmlScopes(xml: MapperXml): SqlScope[] {
  const out: SqlScope[] = xml.statements.map((statement) => ({
    kind: statement.kind as SqlScope["kind"],
    id: statement.id,
    raw: statement.rawSql,
    resolved: resolveIncludes(xml, statement),
    line: statement.line,
    source: "xml" as const,
  }));
  // A `<sql>` fragment is SQL somebody wrote, and it sits outside every
  // statement's line range, so scanning only statements hides whatever lives
  // there. Reporting it on the fragment is also the right count: an `${}` in a
  // shared `<if>` block is one finding, not one per `<include>`.
  for (const [id, fragment] of Object.entries(xml.fragments)) {
    out.push({
      kind: "sql",
      id,
      raw: fragment.body,
      resolved: inlineFragments(xml, fragment.body),
      line: fragment.line,
      source: "xml",
    });
  }
  return out;
}

const ANNO = /@(Select|Update|Insert|Delete)\s*\(((?:"[^"]*"(?:\s*\+\s*"[^"]*")*\s*)|(?:[^()]*))\)/g;

/** SQL written in mapper-interface annotations. */
export function javaSqlScopes(java: JavaFile): SqlScope[] {
  const out: SqlScope[] = [];
  const source = java.source;
  ANNO.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANNO.exec(source))) {
    const kind = (m[1] as string).toLowerCase() as SqlScope["kind"];
    const body = m[2] ?? "";
    const literals = [...body.matchAll(/"([^"]*)"/g)].map((x) => x[1] as string);
    const text = (literals.length ? literals.join(" ") : body).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const innerOffset = (m.index ?? 0) + m[0].indexOf(body);
    out.push({
      kind,
      id: `${kind}Annotation`,
      raw: text,
      resolved: stripTags(text).replace(/\s+/g, " ").trim(),
      line: java.index.lineOf(innerOffset),
      source: "annotation",
    });
  }
  return out;
}

export function scopesFor(ctx: { java?: JavaFile; xml?: MapperXml }): SqlScope[] {
  const out: SqlScope[] = [];
  if (ctx.xml) out.push(...xmlScopes(ctx.xml));
  if (ctx.java) out.push(...javaSqlScopes(ctx.java));
  return out;
}

/** Does this SQL restrict rows at all? Used by MYB005 to avoid bogus alerts. */
export function hasBoundingClause(scope: SqlScope): boolean {
  const resolved = scope.resolved.toLowerCase();
  if (/\bwhere\b/.test(resolved)) return true;
  if (/\blimit\b|\boffset\b|\btop\s+\d/.test(resolved)) return true;
  if (/<\s*(where|if|foreach|trim|choose|when|where)\b/i.test(scope.raw)) return true;
  if (/\bhaving\b|\bexists\s*\(|\bin\s*\(/.test(resolved)) return true;
  // `${ew.customSqlSegment}` carries the Wrapper's conditions — bounded by construction.
  if (/\$\{\s*ew\./.test(scope.raw)) return true;
  return false;
}

/** MyBatis-Plus / PageHelper pagination, judged from the mapper interface. */
export function isPagedQuery(scope: SqlScope, companion?: JavaFile): boolean {
  const text = `${scope.raw} ${scope.resolved}`.toLowerCase();
  if (/rowbounds|pagehelper|startpage/.test(text)) return true;
  if (!companion) return false;
  // `<select id="selectPage">` matching an interface method that takes IPage/Page<T>
  // is paginated by the interceptor: no `limit` in the SQL, and no full-table read.
  const re = new RegExp(`\\b${scope.id}\\s*\\(([^)]*)\\)`, "i");
  const m = re.exec(companion.source);
  if (!m) return false;
  const params = (m[1] ?? "").toLowerCase();
  return /\b(ipage|page)\s*</.test(params) || /pagehelper|startpage|rowbounds/.test(params);
}
