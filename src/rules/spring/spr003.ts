import { callSites, hasAnnotation, methodsOf } from "../../analyze/java.js";
import type { Rule } from "../../types.js";
import { draft } from "../util.js";

/**
 * SPR003 — `@Async` / `@Scheduled` that can never fire.
 *
 * Same proxy mechanism as SPR001, plus two structural guarantees Spring itself
 * requires: the method must be public and non-static, and `@Scheduled` methods
 * must take no arguments.
 */
const ASYNC_KEYS = ["Async", "Scheduled"];

const rule: Rule = {
  id: "SPR003",
  title: "@Async/@Scheduled 失效",
  titleEn: "@Async/@Scheduled that will never be applied",
  severity: "error",
  target: "java",
  needsFullContext: true,
  rationale:
    "@Async/@Scheduled 同样依赖代理:非 public、static、或同类内部调用都会被忽略。@Scheduled 方法还要求无参,且需要 @EnableScheduling/@EnableAsync 开启。",
  run({ unit, java }) {
    if (!java) return [];
    const out = [];
    for (const [typeIndex, type] of java.types.entries()) {
      const methods = methodsOf(java, typeIndex);
      for (const member of methods) {
        const key = hasAnnotation(member.annotations, ...ASYNC_KEYS)
          ? (member.annotations.find((a) => ASYNC_KEYS.includes(a.name)) as { name: string; line: number })
          : undefined;
        if (!key) continue;
        const reasons: string[] = [];
        if (member.modifiers.includes("static")) reasons.push("static 方法无法被代理拦截");
        else if (!member.modifiers.includes("public")) reasons.push("非 public 方法无法被代理拦截");
        if (key.name === "Scheduled" && member.params.length > 0)
          reasons.push("@Scheduled 方法必须无参");
        if (reasons.length > 0) {
          out.push(
            draft(
              rule,
              unit,
              member.line,
              `${member.name}() 上的 @${key.name} 不会生效:${reasons.join(";")}。`,
              `@${key.name} on ${member.name}() has no effect: ${reasons.join("; ")}.`,
              {
                suggestion:
                  key.name === "Scheduled"
                    ? "改成 public、非 static、无参的方法,并确认启动类有 @EnableScheduling。"
                    : "改成 public 非 static 方法,并确认启动类有 @EnableAsync;同类调用要拆到独立 Bean。",
              },
            ),
          );
          continue;
        }
        // Self-invocation of an @Async/@Scheduled method.
        for (const caller of methods) {
          if (caller.bodyStart < 0 || caller.name === member.name) continue;
          if (caller.modifiers.includes("static")) continue;
          for (const call of callSites(java, caller)) {
            if (call.callee !== member.name || call.receiver.length > 1) continue;
            if (call.receiver.length === 1 && call.receiver[0] !== "this") continue;
            if (call.args.split(",").filter(Boolean).length !== member.params.length) continue;
            out.push(
              draft(
                rule,
                unit,
                call.line,
                `${caller.name}() 在同类内调用 @${key.name} 的 ${member.name}(),不经过代理,异步/定时语义丢失(方法会同步执行)。`,
                `${caller.name}() self-invokes @${key.name} ${member.name}(); the proxy is bypassed so it runs synchronously.`,
                { suggestion: "把异步方法放到另一个 Bean 里,或注入自身代理后调用。" },
              ),
            );
          }
        }
      }
    }
    return out;
  },
};

export default rule;
