import { callSites, hasAnnotation, methodsOf } from "../../analyze/java.js";
import type { Rule } from "../../types.js";
import { annotationArgs, draft } from "../util.js";

/**
 * SPR006 — `@Cacheable` that silently does nothing, or caches too coarsely.
 *
 * Two deterministic failure modes: the proxy is bypassed by a self-call (same
 * root cause as SPR001), and the default `SimpleKeyGenerator` builds one key from
 * *all* arguments, which surprises people the moment a method takes a filter
 * object or a flag that should not participate in the key.
 */
const rule: Rule = {
  id: "SPR006",
  title: "@Cacheable 失效或缓存键过粗",
  titleEn: "@Cacheable bypassed or keyed by all arguments",
  severity: "warn",
  target: "java",
  needsFullContext: true,
  rationale:
    "@Cacheable 依赖代理,自调用不生效;未写 key 时默认用全部参数生成 SimpleKey,参数含布尔开关/查询对象时容易命中率异常或缓存串味。显式给 SpEL key。",
  run({ unit, java }) {
    if (!java) return [];
    const out = [];
    for (const [typeIndex, type] of java.types.entries()) {
      const methods = methodsOf(java, typeIndex);
      for (const member of methods) {
        const cacheable = member.annotations.find((a) => a.name === "Cacheable");
        if (!cacheable) continue;
        const args = annotationArgs(cacheable);
        const multiParam = member.params.length > 1;
        if (multiParam && !args["key"] && !args["condition"]) {
          out.push(
            draft(
              rule,
              unit,
              member.line,
              `${member.name}() 有 ${member.params.length} 个参数但未指定 @Cacheable 的 key,默认 SimpleKey 会把全部参数计入缓存键。`,
              `${member.name}() is @Cacheable with ${member.params.length} parameters and no explicit key; the default SimpleKey includes all of them.`,
              { suggestion: `@Cacheable(key = "#p0") 按需指定参与缓存键的参数。` },
            ),
          );
        }
        if (member.modifiers.includes("private") || member.modifiers.includes("static")) continue;
        for (const caller of methods) {
          if (caller.bodyStart < 0 || caller.name === member.name) continue;
          for (const call of callSites(java, caller)) {
            if (call.callee !== member.name) continue;
            if (call.receiver.length > 1) continue;
            if (call.receiver.length === 1 && call.receiver[0] !== "this") continue;
            out.push(
              draft(
                rule,
                unit,
                call.line,
                `${caller.name}() 同类内调用 @Cacheable 的 ${member.name}(),不走代理,缓存完全失效(每次都会真实执行)。`,
                `${caller.name}() self-invokes @Cacheable ${member.name}(); the cache is bypassed entirely.`,
                { suggestion: "把被缓存方法拆到独立 Bean,或通过自身代理调用。" },
              ),
            );
          }
        }
      }
      void type;
    }
    return out;
  },
};

export default rule;
