import { splitTopLevel } from "../util/text.js";
import type {
  FindingDraft,
  JavaAnnotation,
  JavaFile,
  JavaMember,
  JavaType,
  ReviewUnit,
  Severity,
} from "../types.js";

export function draft(
  rule: { id: string; severity: Severity },
  unit: ReviewUnit,
  line: number,
  message: string,
  messageEn: string,
  extra: Partial<FindingDraft> = {},
): FindingDraft {
  return {
    rule: rule.id,
    severity: rule.severity,
    file: unit.path,
    line,
    message,
    messageEn,
    ...extra,
  };
}

/** Read `key = value` pairs out of an annotation argument list. */
export function annotationArgs(annotation: JavaAnnotation | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = annotation?.args;
  if (!raw) return out;
  for (const part of splitTopLevel(raw, ",")) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      out["value"] = cleanValue(part);
      continue;
    }
    out[part.slice(0, eq).trim()] = cleanValue(part.slice(eq + 1));
  }
  return out;
}

function cleanValue(raw: string): string {
  return raw
    .trim()
    .replace(/^\{(.*)\}$/s, "$1") // array literal `{A.class, B.class}`
    .replace(/^"|"$/g, "")
    .replace(/^[A-Za-z$.]*\./, "") // Propagation.REQUIRED → REQUIRED
    .trim();
}

export const SPRING_TX = "Transactional";

/** Attributes that change behaviour and are therefore silently lost on a self-call. */
const MEANINGFUL_TX_KEYS = ["propagation", "isolation", "readOnly", "timeout", "rollbackFor", "noRollbackFor"];

export function transactionalOf(
  member: JavaMember,
  type: JavaType,
): { annotation: JavaAnnotation; classLevel: boolean } | undefined {
  const own = member.annotations.find((a) => a.name === SPRING_TX);
  if (own) return { annotation: own, classLevel: false };
  const onType = type.annotations.find((a) => a.name === SPRING_TX);
  // Interfaces/annotations such as @Transactional(readOnly=true) on the class apply
  // to every public method — the single most common reason a rule misses SPR002.
  if (onType && member.kind === "method" && !member.modifiers.includes("static")) {
    return { annotation: onType, classLevel: true };
  }
  return undefined;
}

export function hasMeaningfulTxAttributes(annotation: JavaAnnotation): boolean {
  const args = annotationArgs(annotation);
  return MEANINGFUL_TX_KEYS.some((k) => args[k] !== undefined);
}

export function propagationOf(annotation: JavaAnnotation): string {
  return annotationArgs(annotation)["propagation"] ?? "REQUIRED";
}

/** Propagations that reuse the caller's transaction, making a self-call harmless. */
const JOINING = new Set(["REQUIRED", "SUPPORTS", "MANDATORY"]);

export function joinsCallerTransaction(annotation: JavaAnnotation): boolean {
  return JOINING.has(propagationOf(annotation));
}

const MAPPER_SUFFIX = /(Mapper|Dao|DAO|Repository)$/;

export function isMapperReceiver(name: string): boolean {
  if (!name) return false;
  if (name === "baseMapper") return true;
  return MAPPER_SUFFIX.test(name);
}

const QUERY_METHOD =
  /^(select|find|get|query|list|count|exists|page|search|load|fetch|insert|update|delete|save|remove|batch)/i;

export function looksLikeQuery(callee: string): boolean {
  return QUERY_METHOD.test(callee);
}

/** Field names whose declared type looks like a mapper/dao/repository. */
export function mapperFieldNames(java: JavaFile): Set<string> {
  const out = new Set<string>();
  for (const field of java.fields) {
    if (isMapperType(field.type)) for (const name of field.names) out.add(name);
  }
  return out;
}

const BEAN_STEREOTYPES = [
  "Service",
  "Component",
  "RestController",
  "Controller",
  "Repository",
  "Configuration",
  "ControllerAdvice",
  "RestControllerAdvice",
  "WebService",
  "Endpoint",
  "Tag",
];

/**
 * Bean-ness decided from the file alone: no classpath, so a `@MyService`
 * meta-annotation or an `@Bean`-registered class is invisible to us. Documented
 * limitation; rules that need it stay conservative.
 */
export function isBeanType(type: JavaType): boolean {
  if (type.anonymous) return false;
  if (type.annotations.some((a) => BEAN_STEREOTYPES.includes(a.name))) return true;
  return /(?:Controller|Service|Component|Manager|Handler|Listener|Task|Job|Consumer|Facade)$/.test(
    type.name,
  );
}

const SCOPED = ["RequestScope", "SessionScope", "ApplicationRequestScope", "PrototypeScope"];

/** True when the type is not a shared singleton (so mutable state is fine). */
export function isNonSingletonScope(type: JavaType): boolean {
  if (type.annotations.some((a) => SCOPED.includes(a.name))) return true;
  const scope = type.annotations.find((a) => a.name === "Scope");
  if (!scope) return false;
  return /prototype|request|session|application/i.test(scope.args ?? "");
}

export const MAPPER_SUFFIX_RE = /(Mapper|Dao|DAO|Repository)$/;

export function isMapperType(typeText: string): boolean {
  return MAPPER_SUFFIX_RE.test(typeText.replace(/<.*$/, "").trim());
}

export const REQUIRES_NEW = "REQUIRES_NEW";
