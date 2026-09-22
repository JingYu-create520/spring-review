import type { LineIndex } from "./util/text.js";

/**
 * Core data model.
 *
 * The one non-obvious decision lives in {@link ReviewUnit}: rules always run on
 * the **full file content**, and the engine filters findings down to `addedLines`
 * afterwards. Diff hunks alone cannot answer "is the called method in the same
 * class?" (SPR001) or "is there a class-level @Transactional?" (SPR002/004/005),
 * so analysing patch fragments is a dead end — we read the real file and keep
 * only the line-number filter from the diff.
 */

export type Severity = "error" | "warn" | "info";

export const SEVERITY_RANK: Record<Severity, number> = {
  error: 3,
  warn: 2,
  info: 1,
};

export interface Finding {
  /** Rule id, e.g. "SPR001". */
  rule: string;
  severity: Severity;
  /** Repo-relative path with forward slashes. */
  file: string;
  /** 1-based line in HEAD / working tree. */
  line: number;
  endLine?: number;
  /** Evidence: the offending source line(s), trimmed. */
  snippet: string;
  /** Chinese: what + why + how to fix. */
  message: string;
  /** English one-liner for the `github`/`json` consumers. */
  messageEn: string;
  /** Suggested replacement snippet. */
  suggestion?: string;
  /**
   * Set when a rule had to give up because the file could not be fully
   * reconstructed (patch-only mode over a file that is not on disk).
   */
  degraded?: boolean;
}

/** Where the content of a review unit came from. */
export type ContentSource = "worktree" | "index" | "head" | "patch" | "empty";

export interface ReviewUnit {
  path: string;
  /**
   * Full file content, LF-normalised, **line numbers aligned with HEAD**.
   * Lines we could not recover (patch-only mode with gaps) are empty strings,
   * so the numbering never drifts.
   */
  content: string;
  /**
   * Lines introduced by the change. `null` means whole-file mode: every line
   * is reportable.
   */
  addedLines: Set<number> | null;
  contentSource: ContentSource;
  /**
   * False when the content is a sparse reconstruction from diff context lines.
   * Structure-heavy rules must skip such units (and emit nothing, or `info`).
   */
  complete: boolean;
  /** Language hint derived from the extension. */
  lang: "java" | "xml" | "other";
  /**
   * For a mapper XML: the Java interface named by its `namespace`, when it can
   * be found. Used only for metadata that the XML cannot express (pagination
   * parameters) — never as a source of findings, since its line numbers belong
   * to a different file.
   */
  companion?: { path: string; content: string };
}

export interface JavaFile {
  path: string;
  /** Raw source, LF-normalised. */
  source: string;
  /** Source with comments and string/char literal bodies blanked out (same length). */
  masked: string;
  /**
   * Source with comments blanked but string literals intact (same length), for
   * reading the SQL inside `@Select("…")` without mistaking a Javadoc example
   * for an annotation.
   */
  commentMasked: string;
  /** Raw source split by line; index 0 is line 1. */
  lines: string[];
  /** offset → line number, for every structure we located in `masked`. */
  index: LineIndex;
  types: JavaType[];
  members: JavaMember[];
  fields: JavaField[];
  /** Structural features we could not handle. Non-empty ⇒ rules should stay quiet. */
  diagnostics: string[];
}

export interface JavaAnnotation {
  /** Simple name, without `@`. */
  name: string;
  /** As written, e.g. `org.springframework.transaction.annotation.Transactional`. */
  full: string;
  /** Raw argument text inside the parentheses, without them (undefined if bare `@Foo`). */
  args?: string;
  line: number;
  /** Offset of `@` in {@link JavaFile.masked}. */
  offset: number;
}

export interface JavaType {
  name: string;
  kind: "class" | "interface" | "enum" | "record" | "anonymous";
  annotations: JavaAnnotation[];
  modifiers: string[];
  /** Offset range of the type declaration and its body. */
  declStart: number;
  bodyStart: number;
  bodyEnd: number;
  line: number;
  endLine: number;
  /** Index into {@link JavaFile.types} of the enclosing type, if any. */
  enclosing: number | null;
  /** Type indices whose body is directly nested in this one. */
  nested: number[];
  /** True for `new Foo() { ... }` bodies — `this` there is not the outer bean. */
  anonymous: boolean;
}

export interface JavaMember {
  kind: "method" | "constructor";
  name: string;
  /** Index into {@link JavaFile.types}. */
  owner: number;
  annotations: JavaAnnotation[];
  modifiers: string[];
  returnType?: string;
  params: string[];
  throwsTypes: string[];
  abstract: boolean;
  /** Offset of the signature start. */
  start: number;
  /** Offset of the opening brace, -1 for abstract/interface methods. */
  bodyStart: number;
  bodyEnd: number;
  line: number;
  endLine: number;
}

export interface JavaField {
  names: string[];
  /** Declared type text, e.g. `Map<String, Object>`. */
  type: string;
  annotations: JavaAnnotation[];
  modifiers: string[];
  initializer?: string;
  line: number;
  start: number;
  end: number;
}

export interface MapperStatement {
  /** "select" | "insert" | "update" | "delete" */
  kind: string;
  id: string;
  /** Statement body with child tags removed and whitespace collapsed. */
  sql: string;
  /** Statement body exactly as written, including `<if>`/`<where>` tags. */
  rawSql: string;
  line: number;
  endLine: number;
  attributes: Record<string, string>;
}

export interface MapperXml {
  path: string;
  source: string;
  lines: string[];
  namespace?: string;
  statements: MapperStatement[];
  /**
   * `<sql id="...">` fragments, referenced by `<include refid="...">`. Stored
   * with their own line because a fragment is reviewed in its own right: an
   * `${}` inside a shared `<sql>` block is one finding on the block, not one per
   * statement that includes it.
   */
  fragments: Record<string, { body: string; line: number }>;
  resultMaps: Array<{ id: string; line: number; nestedSelectLines: number[] }>;
  diagnostics: string[];
}

/** What a rule returns; the engine fills in `snippet` and normalises the rest. */
export type FindingDraft = Omit<Finding, "snippet"> & { snippet?: string };

export interface RuleContext {
  unit: ReviewUnit;
  java?: JavaFile;
  xml?: MapperXml;
  /**
   * Analysed mapper interface behind a mapper XML unit. Metadata only — never
   * report a finding against it (wrong file, wrong line space).
   */
  companion?: JavaFile;
  options: RuleOptions;
}

export interface RuleOptions {
  /** Report `--experimental` rules (SPR005) — off by default. */
  experimental: boolean;
}

export interface Rule {
  id: string;
  title: string;
  titleEn: string;
  severity: Severity;
  /** `both` = the rule scans mapper XML *and* Java `@Select`-style SQL. */
  target: "java" | "xml" | "both";
  experimental?: boolean;
  /**
   * Needs the whole file to decide (class-level annotations, sibling methods,
   * complete loop bodies). Skipped for units that only exist as patch fragments.
   */
  needsFullContext?: boolean;
  /** Why it matters + what to do, shown in `list_rules` and README. */
  rationale: string;
  run(ctx: RuleContext): FindingDraft[];
}

export interface ReviewOptions extends RuleOptions {
  minSeverity: Severity;
  exclude: string[];
  onlyRules?: string[];
  /** Disable rules by id (from `.spring-review.json` or `--disable`). */
  disabledRules?: string[];
}

export interface ReviewResult {
  findings: Finding[];
  units: number;
  skipped: Array<{ path: string; reason: string }>;
  /** Rule ids that produced at least one finding. */
  hitRules: string[];
}
