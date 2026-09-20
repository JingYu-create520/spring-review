import { hasAnnotation, methodsOf } from "../../analyze/java.js";
import type { Rule } from "../../types.js";
import { draft } from "../util.js";

/**
 * SPR004 — threads / thread pools created inside a request-handling bean.
 *
 * A bean serves concurrent requests, so `new Thread()` per call is an unbounded
 * thread leak with no shutdown hook and no rejection policy. `@Bean` methods are
 * exempt — creating the executor once, in configuration, is exactly the fix.
 */
const CREATION = [
  { re: /new\s+Thread\s*\(/g, label: "new Thread(...)", fix: "注入 ThreadPoolTaskExecutor Bean 并 submit 任务" },
  { re: /new\s+ThreadPoolExecutor\s*\(/g, label: "new ThreadPoolExecutor(...)", fix: "在 @Configuration 中声明 ThreadPoolTaskExecutor Bean" },
  { re: /new\s+ScheduledThreadPoolExecutor\s*\(/g, label: "new ScheduledThreadPoolExecutor(...)", fix: "在 @Configuration 中声明 ThreadPoolTaskScheduler Bean" },
  { re: /\bExecutors\s*\.\s*new\w+\s*\(/g, label: "Executors.newXxx(...)", fix: "改用有界队列的 ThreadPoolTaskExecutor Bean(Executors 默认无界队列易 OOM)" },
  { re: /Thread\s*\.\s*startVirtualThread\s*\(/g, label: "Thread.startVirtualThread(...)", fix: "虚拟线程也应有生命周期管理,考虑 ExecutorService Bean" },
];

const rule: Rule = {
  id: "SPR004",
  title: "请求路径内新建线程/线程池",
  titleEn: "Thread or executor created per request",
  severity: "error",
  target: "java",
  needsFullContext: true,
  rationale:
    "Spring Bean 默认单例且并发调用,方法内 new Thread / Executors.newXxx 会造成线程失控、无法优雅关闭、无拒绝策略。应声明 ThreadPoolTaskExecutor Bean 复用。",
  run({ unit, java }) {
    if (!java) return [];
    const out = [];
    for (const [typeIndex, type] of java.types.entries()) {
      if (type.anonymous) continue;
      const beanLike =
        hasAnnotation(type.annotations, ...BEAN_TYPES) || /(?:Controller|Service|Component|Manager|Handler|Listener)$/.test(type.name);
      if (!beanLike) continue;
      for (const member of methodsOf(java, typeIndex)) {
        if (member.bodyStart < 0) continue;
        if (hasAnnotation(member.annotations, "Bean")) continue;
        if (member.kind === "constructor" && member.modifiers.includes("private")) continue;
        const body = java.masked.slice(member.bodyStart, member.bodyEnd);
        for (const { re, label, fix } of CREATION) {
          re.lastIndex = 0;
          const m = re.exec(body);
          if (!m) continue;
          const line = java.index.lineOf(member.bodyStart + (m.index ?? 0));
          out.push(
            draft(
              rule,
              unit,
              line,
              `${type.name}.${member.name}() 在 Bean 方法内 ${label},单例 Bean 并发调用下线程数不可控且不会优雅关闭。`,
              `${type.name}.${member.name}() does ${label} inside a singleton bean: unbounded threads, no graceful shutdown.`,
              { suggestion: fix },
            ),
          );
        }
      }
    }
    return out;
  },
};

const BEAN_TYPES = [
  "Service",
  "Component",
  "RestController",
  "Controller",
  "Repository",
  "Configuration",
  "ControllerAdvice",
  "WebService",
  "Tag",
];

export default rule;
