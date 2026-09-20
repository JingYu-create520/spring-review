import { hasAnnotation, methodsOf, writtenIdentifiers } from "../../analyze/java.js";
import type { Rule } from "../../types.js";
import { draft, isBeanType, isNonSingletonScope } from "../util.js";

/**
 * SPR005 — mutable state on a singleton bean (experimental, off by default).
 *
 * The highest false-positive risk in the set, which is why it ships behind
 * `--experimental`. Built-in mitigations: constructor / field-initialiser /
 * `@PostConstruct` writes count as initialisation, `synchronized` (or
 * `@Transactional`) writers are treated as guarded, and volatile, final and
 * thread-safe types are skipped.
 */
const SAFE_TYPES =
  /^(?:ConcurrentHashMap|ConcurrentSkipListMap|CopyOnWriteArrayList|CopyOnWriteArraySet|Atomic\w+|ThreadLocal|InheritableThreadLocal|ImmutableList|ImmutableMap|BlockingQueue\w*)$/;

const UNSAFE_TYPES =
  /^(?:HashMap|TreeMap|LinkedHashMap|Hashtable|ArrayList|LinkedList|HashSet|TreeSet|ArrayDeque|StringBuilder|StringBuffer|SimpleDateFormat|Date|LocalDate|LocalDateTime|Map|List|Set|Collection|int|long|double|float|boolean|byte|char|short)$/;

const rule: Rule = {
  id: "SPR005",
  title: "单例 Bean 可变状态",
  titleEn: "Mutable state on a singleton bean",
  severity: "warn",
  target: "java",
  experimental: true,
  needsFullContext: true,
  rationale:
    "单例 Bean 的实例字段被并发读写会产生竞态。改局部变量、换线程安全类型、或用 @RequestScope。误报可能偏高,默认关闭,加 --experimental 打开。",
  run({ unit, java }) {
    if (!java) return [];
    const out = [];
    for (const [typeIndex, type] of java.types.entries()) {
      if (!isBeanType(type) || isNonSingletonScope(type)) continue;
      const methods = methodsOf(java, typeIndex);
      const ownFields = java.fields.filter(
        (f) =>
          f.start > type.bodyStart &&
          f.end < type.bodyEnd &&
          !f.modifiers.includes("static") &&
          !hasAnnotation(f.annotations, "Autowired", "Resource", "Value", "Inject"),
      );
      for (const field of ownFields) {
        const bareType = field.type.replace(/<.*$/, "").trim().split(".").pop() ?? "";
        const isArray = /[\[\]]$/.test(field.type.trim());
        if (field.modifiers.includes("volatile")) continue;
        if (SAFE_TYPES.test(bareType)) continue;
        // `Map<K,V> cache = new ConcurrentHashMap<>()` — the interface is declared,
        // the implementation is thread-safe. That is the fix, not the problem.
        const initType = (/new\s+([A-Za-z_$][\w$.]*)/.exec(field.initializer ?? "")?.[1] ?? "")
          .split(".")
          .pop() as string;
        if (initType && SAFE_TYPES.test(initType)) continue;
        if (/Collections\s*\.\s*(synchronized|unmodifiable)\w+/.test(field.initializer ?? "")) continue;
        if (/^\s*(?:List|Set|Map|ImmutableList|ImmutableMap)\s*\.\s*of\s*\(/.test(field.initializer ?? "")) continue;
        if (field.modifiers.includes("final") && !isArray && !UNSAFE_TYPES.test(bareType)) continue;
        if (!UNSAFE_TYPES.test(bareType) && !isArray) continue;

        const unguarded: Array<{ method: string; line: number }> = [];
        for (const member of methods) {
          if (member.kind === "constructor" || member.bodyStart < 0) continue;
          if (hasAnnotation(member.annotations, "PostConstruct")) continue;
          const guarded =
            member.modifiers.includes("synchronized") ||
            hasAnnotation(member.annotations, "Transactional");
          if (guarded) continue;
          const writes = writtenIdentifiers(java, member);
          for (const name of field.names) {
            const line = writes.get(name);
            if (line !== undefined) unguarded.push({ method: member.name, line });
          }
        }
        if (unguarded.length === 0) continue;
        const first = unguarded[0]!;
        out.push(
          draft(
            rule,
            unit,
            field.line,
            `单例 Bean ${type.name} 的可变字段 ${field.names.join(", ")}(${field.type})在 ${unguarded.length} 处非同步方法里被写(首次:${first.method}() 第 ${first.line} 行),并发下会丢更新或读到中间状态。`,
            `Field ${field.names[0]} of singleton bean ${type.name} is written from ${unguarded.length} unguarded method(s).`,
            {
              suggestion:
                "改成方法内局部变量;确实需要共享时用 ConcurrentHashMap / Atomic* 等线程安全类型,或 @RequestScope 让每个请求一个实例。",
            },
          ),
        );
      }
    }
    return out;
  },
};

export default rule;
