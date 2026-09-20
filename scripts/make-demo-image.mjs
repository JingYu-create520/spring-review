// Renders the README screenshot from *real* CLI output — nothing in the image is
// hand-written, so it cannot drift into a claim the tool does not keep.
//
//   node scripts/make-demo-image.mjs      # writes docs/assets/demo.html
//   then open it in a browser and capture, or: npx playwright screenshot …
//
// The PNG in docs/assets is produced from this HTML; regenerate both whenever the
// report wording changes.
import { main } from "../dist/cli.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const ARGS = [
  "node",
  "spring-review",
  "--cwd",
  "examples/demo-project",
  "--format",
  "table",
  "--file",
  "src/main/java/com/example/shop/order/OrderService.java",
  "src/main/java/com/example/shop/mapper/OrderMapper.java",
];

let out = "";
const code = await main(ARGS, { stdout: (chunk) => (out += chunk), isTTY: true });

const COLORS = {
  31: "#ff6b6b", // error
  32: "#5ddc7f", // suggestion
  33: "#ffd166", // warn
  34: "#7aa2f7", // info
  36: "#7dcfff", // file header
  1: "#ffffff",
  2: "#8b95a7", // dim
};

const escaped = out.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// Map the ANSI runs the CLI emitted onto spans, so the picture shows exactly what
// a real terminal shows. Unclosed runs are closed at the end of the line.
let opened = 0;
const html = escaped
  .replace(/\x1b\[([0-9;]*)m/g, (_m, codes) => {
    const head = (codes || "0").split(";")[0];
    if (head === "0") {
      if (opened === 0) return "";
      opened--;
      return "</span>";
    }
    opened++;
    return `<span style="color:${COLORS[head] ?? "#e6e6e6"}">`;
  })
  .replace(/\n/g, "<br>") + "</span>".repeat(opened);

mkdirSync(join(root, "docs", "assets"), { recursive: true });
writeFileSync(
  join(root, "docs", "assets", "demo.html"),
  `<!doctype html><meta charset=utf-8>
<style>
  body{margin:0;background:#0d1117;display:flex;justify-content:center;padding:28px;
       font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
  .term{width:1300px;background:#0d1117;border:1px solid #30363d;border-radius:10px;
        overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.55)}
  .bar{background:#161b22;padding:10px 14px;border-bottom:1px solid #30363d;
       color:#8b95a7;font-size:13px;display:flex;align-items:center;gap:7px}
  .dot{width:11px;height:11px;border-radius:50%;display:inline-block}
  .body{padding:16px 18px;color:#e6e6e6;font-size:13.5px;line-height:1.6;white-space:pre-wrap}
</style>
<div class="term">
  <div class="bar">
    <i class="dot" style="background:#ff5f56"></i><i class="dot" style="background:#ffbd2e"></i><i class="dot" style="background:#27c93f"></i>
    &nbsp;spring-review &mdash; examples/demo-project (exit ${code})
  </div>
  <div class="body">${html}</div>
</div>
`,
);

process.stdout.write(`wrote docs/assets/demo.html (${out.split("\n").length} lines, exit ${code})\n`);
