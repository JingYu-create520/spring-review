import { callSites, loopRanges, methodsOf } from "../../analyze/java.js";
import type { Rule } from "../../types.js";
import { draft, isMapperReceiver, looksLikeQuery, mapperFieldNames } from "../util.js";

/**
 * MYB002 — N+1 queries.
 *
 * Two shapes are detected, both deterministic:
 *   a) a mapper/DAO/repository call inside a loop, stream lambda or `forEach` —
 *      one query per element;
 *   b) a MyBatis `<collection select="…">` / `<association select="…">` nested
 *      select, which is the framework generating the N+1 for you.
 *
 * To keep the false-positive rate near zero we only trust a receiver that
 * textually looks like a data-access object (`userMapper`, `baseMapper`,
 * `orderDao`, `userRepository`) **and** a method name that looks like a query.
 */
const rule: Rule = {
  id: "MYB002",
  title: "N+1 查询",
  titleEn: "N+1 query pattern",
  severity: "error",
  target: "both",
  needsFullContext: true,
  rationale:
    "循环里逐条查询会产生 1+N 次往返。改为一次 IN 批量查询后在内存组装,或用 join + resultMap 一次取回。",
  run({ unit, java, xml }) {
    const out = [];

    if (java) {
      const fieldNames = mapperFieldNames(java);
      for (const [typeIndex] of java.types.entries()) {
        for (const member of methodsOf(java, typeIndex)) {
          if (member.bodyStart < 0) continue;
          const loops = loopRanges(java, member);
          if (loops.length === 0) continue;
          for (const call of callSites(java, member)) {
            if (!(call.offset > member.bodyStart && call.offset < member.bodyEnd)) continue;
            const loop = loops.find((l) => call.offset > l.start && call.offset < l.end);
            if (!loop) continue;
            const receiver = call.receiver.join(".");
            const looksLikeDao =
              isMapperReceiver(receiver) ||
              (receiver === "" ? false : fieldNames.has(receiver.split(".")[0] as string)) ||
              fieldNames.has(receiver);
            if (!looksLikeDao || !looksLikeQuery(call.callee)) continue;
            out.push(
              draft(
                rule,
                unit,
                call.line,
                `${member.name}() 在 ${describeLoop(loop.kind)}中调用 ${receiver}.${call.callee}(),循环 N 次就打 N 次库(N+1)。`,
                `${member.name}() calls ${receiver}.${call.callee}() inside a ${loop.kind} loop — one query per element.`,
                {
                  suggestion: `先收集 id 一次性查:List<X> rows = ${receiver.split(".").pop()}.selectByIds(ids) 或 IN (…) 批量查,再 Map<id, X> 组装。`,
                },
              ),
            );
          }
        }
      }
    }

    if (xml) {
      for (const map of xml.resultMaps) {
        for (const line of map.nestedSelectLines) {
          out.push(
            draft(
              rule,
              unit,
              line,
              `resultMap ${map.id} 使用嵌套 select(N+1 的经典写法):主查询每行都会再触发一次子查询。`,
              `resultMap ${map.id} uses a nested select, so the parent query fires one child query per row.`,
              { suggestion: "改成一次 join 查询 + <collection>/<association> 的 resultMap 列映射(注意列前缀)。" },
            ),
          );
        }
      }
    }

    return out;
  },
};

function describeLoop(kind: string): string {
  switch (kind) {
    case "for":
      return "for 循环";
    case "while":
      return "while 循环";
    case "forEach":
      return "forEach 迭代";
    default:
      return "stream 管道";
  }
}

export default rule;
