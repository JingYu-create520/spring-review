import { looksChecked, methodsOf } from "../../analyze/java.js";
import type { Rule } from "../../types.js";
import { annotationArgs, draft, transactionalOf } from "../util.js";

/**
 * SPR002 — `@Transactional` without `rollbackFor` on a method that throws a
 * checked exception.
 *
 * The default rollback rule is "RuntimeException and Error only", so a checked
 * exception escaping the method commits a half-finished write. This is the
 * quietest possible rule: it needs an explicit `throws` clause in the signature.
 */
const rule: Rule = {
  id: "SPR002",
  title: "@Transactional 缺 rollbackFor",
  titleEn: "@Transactional missing rollbackFor for checked exceptions",
  severity: "error",
  target: "java",
  needsFullContext: true,
  rationale:
    "@Transactional 默认只对 RuntimeException/Error 回滚,受检异常抛出后已写入的数据会被提交。加 rollbackFor=Exception.class(或 Throwable.class)。",
  run({ unit, java }) {
    if (!java) return [];
    const out = [];
    for (const [typeIndex, type] of java.types.entries()) {
      for (const member of methodsOf(java, typeIndex)) {
        const tx = transactionalOf(member, type);
        if (!tx) continue;
        const checked = member.throwsTypes.filter(looksChecked);
        if (checked.length === 0) continue;
        const args = annotationArgs(tx.annotation);
        if (args["rollbackFor"] || args["rollbackForClassName"] || args["noRollbackFor"]) continue;
        out.push(
          draft(
            rule,
            unit,
            member.line,
            `${member.name}() 声明抛出受检异常 ${checked.join(", ")},但 @Transactional 未指定 rollbackFor,异常抛出时事务仍会提交。`,
            `${member.name}() throws checked ${checked.join(", ")} but @Transactional has no rollbackFor, so the transaction still commits.`,
            {
              suggestion: `@Transactional(rollbackFor = Exception.class)${tx.classLevel ? "(类级注解可被方法级覆盖)" : ""}`,
            },
          ),
        );
      }
    }
    return out;
  },
};

export default rule;
