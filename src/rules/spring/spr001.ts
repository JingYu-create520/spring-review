import { callSites, hasAnnotation, methodsOf } from "../../analyze/java.js";
import type { Rule, RuleContext } from "../../types.js";
import {
  annotationArgs,
  draft,
  hasMeaningfulTxAttributes,
  joinsCallerTransaction,
  transactionalOf,
} from "../util.js";

/**
 * SPR001 — `@Transactional` self-invocation.
 *
 * Spring applies transaction advice through a proxy, so a call that stays inside
 * the instance (`this.m()` or a bare `m()`) never reaches the interceptor.
 *
 * Deliberate silence (this is what keeps the false-positive rate at zero):
 *  - the caller is itself transactional and the callee only joins the current
 *    transaction (REQUIRED/SUPPORTS/MANDATORY with no extra attributes) — the
 *    behaviour is genuinely unchanged;
 *  - the callee is private/static (not proxyable in the first place, so the
 *    self-call is not what breaks it);
 *  - the call sits inside an anonymous class body, where `this` is another object.
 */
const rule: Rule = {
  id: "SPR001",
  title: "@Transactional 自调用失效",
  titleEn: "@Transactional self-invocation",
  severity: "error",
  target: "java",
  needsFullContext: true,
  rationale:
    "Spring 的事务通知靠代理对象生效,同类内部调用不经过代理,注解被静默忽略。改为拆分到另一个 Bean、注入自身代理,或 AopContext.currentProxy()。",
  run({ unit, java }: RuleContext) {
    if (!java) return [];
    const out = [];
    for (const [typeIndex, type] of java.types.entries()) {
      const methods = methodsOf(java, typeIndex);
      if (methods.length === 0) continue;
      for (const caller of methods) {
        if (caller.bodyStart < 0) continue;
        if (caller.modifiers.includes("static")) continue;
        const callerTx = transactionalOf(caller, type);
        for (const call of callSites(java, caller)) {
          if (call.receiver.length > 1) continue; // a.b().foo() — not a plain self call
          if (call.receiver.length === 1 && call.receiver[0] !== "this") continue;
          const targets = methodsOf(java, typeIndex).filter(
            (m) =>
              m.name === call.callee &&
              m.params.length === arityOf(call.args) &&
              m.kind === "method",
          );
          for (const target of targets) {
            if (target.modifiers.includes("static") || target.modifiers.includes("private")) continue;
            const targetTx = transactionalOf(target, type);
            if (!targetTx) continue;
            if (callerTx && !hasMeaningfulTxAttributes(targetTx.annotation)) continue;
            if (
              callerTx &&
              joinsCallerTransaction(targetTx.annotation) &&
              sameTransactionSemantics(callerTx.annotation, targetTx.annotation)
            ) {
              continue;
            }
            out.push(
              draft(
                rule,
                unit,
                call.line,
                `${caller.name}() 通过${call.receiver.length ? " this." : ""}${call.callee}() 调用同类中带 @Transactional 的方法,代理不拦截自调用,事务通知不会生效。`,
                `${caller.name}() self-invokes @Transactional ${call.callee}(); the proxy never sees it, so no transaction is started.`,
                {
                  endLine: call.line,
                  suggestion:
                    "把 " +
                    call.callee +
                    "() 挪到另一个 Bean,或注入自身代理后再调用(@Lazy 注入本类 / AopContext.currentProxy())。",
                },
              ),
            );
          }
        }
      }
    }
    return out;
  },
};

function arityOf(args: string): number {
  const trimmed = args.trim();
  if (!trimmed) return 0;
  // Rough but safe: count top-level commas; mismatched arity simply finds no target.
  let depth = 0;
  let count = 1;
  for (const ch of trimmed) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

function sameTransactionSemantics(
  caller: Parameters<typeof annotationArgs>[0],
  target: Parameters<typeof annotationArgs>[0],
): boolean {
  const a = annotationArgs(caller);
  const b = annotationArgs(target);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

export default rule;
