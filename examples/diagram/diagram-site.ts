/**
 * The page the assistant draws on: a small self-hosted "Diagram Studio" on loopback. It draws the Mermaid text it is given with Mermaid itself
 * (the library of the repo's `node_modules`, served from loopback, so there is no network) and shows that text in a pane beside the drawing.
 * Fonts are bundled, so that screenshots look the same wherever it runs.
 *
 *   /              the drawing (left), the Mermaid source (top right), and room for the assistant's panel (bottom right)
 *   window.drawDiagram(text)   draws `text`; resolves `{ ok: true }` or `{ ok: false, error }` when Mermaid cannot read it
 *
 * The page keeps no diagram of its own that anyone could edit: what it shows is the last text it was given. The agent's state is the text,
 * so a run is checked against the text (and against what the page drew from it), never against what the model said.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";

const fonts = join(import.meta.dirname, "../../tests/support/fixtures");
const mermaidFile = createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js");

const CSS = `
@font-face { font-family: "Test Sans"; src: url(/fonts/DejaVuSans-ascii.woff); font-weight: 400; }
@font-face { font-family: "Test Sans"; src: url(/fonts/DejaVuSans-Bold-ascii.woff); font-weight: 700; }
* { box-sizing: border-box; border-radius: 0 !important; }
body { margin: 0; font: 400 18px/26px "Test Sans", sans-serif; color: #1f2937; background: #e2e8f0; user-select: none; overflow: hidden; }
header { height: 64px; background: #1e3a5f; color: #ffffff; display: flex; align-items: center; gap: 20px; padding: 0 32px; font: 700 24px "Test Sans"; }
header small { font: 400 16px "Test Sans"; color: #bcd0e8; }
/* The right 356 px are left for the source pane and the assistant's panel (340 px + 16 px margin). */
#canvas { position: absolute; left: 32px; top: 88px; width: 872px; height: 688px; background: #ffffff; border: 2px solid #94a3b8; display: flex; align-items: center; justify-content: center; overflow: hidden; }
#canvas svg { max-width: 100%; max-height: 100%; }
#canvas .empty { color: #64748b; font-size: 20px; }
#canvas .error { color: #7f1d1d; background: #fee2e2; border: 2px solid #dc2626; padding: 16px 20px; max-width: 760px; white-space: pre-wrap; font-size: 16px; line-height: 22px; }
#source { position: absolute; left: 924px; top: 88px; width: 340px; height: 264px; background: #0f172a; color: #e2e8f0; border: 2px solid #0f172a; padding: 10px 12px; font: 400 14px/20px "Test Sans", sans-serif; white-space: pre; overflow: hidden; }
#source b { display: block; color: #7ee0a8; font: 700 13px/20px "Test Sans"; margin-bottom: 4px; }
#source code { display: block; white-space: pre; }
`;

const script = `
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  themeVariables: { fontFamily: '"Test Sans", sans-serif', fontSize: "20px", primaryColor: "#dbeafe", primaryBorderColor: "#1e3a5f", primaryTextColor: "#1f2937", lineColor: "#334155", edgeLabelBackground: "#ffffff" },
  flowchart: { htmlLabels: false, curve: "linear", nodeSpacing: 50, rankSpacing: 60, padding: 16, wrappingWidth: 400 },
});
let drawn = 0;
const canvas = document.getElementById("canvas"), code = document.querySelector("#source code");
window.drawDiagram = async (text) => {
  await document.fonts.load('18px "Test Sans"'); await document.fonts.load('700 18px "Test Sans"');
  code.textContent = text;
  code.parentElement.scrollTop = code.parentElement.scrollHeight;
  const nodes = text.split("\\n").filter((l) => /^\\s*n\\d+\\[/.test(l)).length;
  if (nodes === 0 && text.trim() === "flowchart TD") { canvas.replaceChildren(Object.assign(document.createElement("div"), { className: "empty", textContent: "Nothing drawn yet" })); return { ok: true }; }
  const id = "diagram" + (++drawn);
  try {
    const { svg } = await mermaid.render(id, text);
    canvas.innerHTML = svg;
    // Drawn as large as the canvas allows, up to one and a half times its natural size, so that a small diagram is still easy to read.
    const el = canvas.querySelector("svg"), [, , w, h] = el.getAttribute("viewBox").split(" ").map(Number);
    const zoom = Math.min(1.5, 840 / w, 650 / h);
    el.style.maxWidth = "none"; el.style.maxHeight = "none"; el.setAttribute("width", String(Math.round(w * zoom))); el.setAttribute("height", String(Math.round(h * zoom)));
    return { ok: true };
  } catch (e) {
    document.getElementById("d" + id)?.remove();
    canvas.replaceChildren(Object.assign(document.createElement("div"), { className: "error", textContent: String(e && e.message || e) }));
    return { ok: false, error: String(e && e.message || e) };
  }
};
window.drawDiagram("flowchart TD");
`;

const page = () => `<!doctype html><html><head><meta charset="utf-8"><title>Diagram Studio</title><style>${CSS}</style></head><body>
<header>Diagram Studio <small>flowcharts from Mermaid text</small></header>
<div id="canvas"></div>
<div id="source"><b>diagram.mmd</b><code></code></div>
<script src="/mermaid.js"></script>
<script>${script}</script></body></html>`;

export type DiagramSite = {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** Every request, as `METHOD /path`. */
  requests: string[];
  close(): Promise<void>;
};

export async function startDiagramSite(opts: { port?: number } = {}): Promise<DiagramSite> {
  const requests: string[] = [];
  const mermaid = readFileSync(mermaidFile);
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    requests.push(`${req.method} ${path}`);
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    if (path === "/mermaid.js") return send(200, "text/javascript; charset=utf-8", mermaid);
    if (path.startsWith("/fonts/")) {
      try {
        return send(200, "font/woff", readFileSync(join(fonts, path.slice("/fonts/".length))));
      } catch {
        return send(404, "text/plain", "not found");
      }
    }
    if (path === "/") return send(200, "text/html; charset=utf-8", page());
    send(404, "text/plain", "not found");
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
