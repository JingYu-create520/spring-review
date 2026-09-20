import type { Rule } from "../types.js";
import spr001 from "./spring/spr001.js";
import spr002 from "./spring/spr002.js";
import spr003 from "./spring/spr003.js";
import spr004 from "./spring/spr004.js";
import spr005 from "./spring/spr005.js";
import spr006 from "./spring/spr006.js";
import myb001 from "./mybatis/myb001.js";
import myb002 from "./mybatis/myb002.js";
import myb003 from "./mybatis/myb003.js";
import myb004 from "./mybatis/myb004.js";
import myb005 from "./mybatis/myb005.js";

/** Declaration order is the order `list_rules` and the README table use. */
export const rules: Rule[] = [
  spr001,
  spr002,
  spr003,
  spr004,
  spr005,
  spr006,
  myb001,
  myb002,
  myb003,
  myb004,
  myb005,
];

export const ruleById = new Map(rules.map((r) => [r.id, r]));

export const EXPERIMENTAL_RULES = rules.filter((r) => r.experimental).map((r) => r.id);

export interface RuleDoc {
  id: string;
  title: string;
  titleEn: string;
  severity: Severity;
  appliesTo: Rule["target"];
  experimental: boolean;
  rationale: string;
}

type Severity = import("../types.js").Severity;

export function listRules(): RuleDoc[] {
  return rules.map((r) => ({
    id: r.id,
    title: r.title,
    titleEn: r.titleEn,
    severity: r.severity,
    appliesTo: r.target,
    experimental: Boolean(r.experimental),
    rationale: r.rationale,
  }));
}
