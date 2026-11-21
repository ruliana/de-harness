/**
 * The page the assistant draws on: a small self-hosted "Diagram Studio" on loopback. It draws the Mermaid text it is given with Mermaid itself
 * (the library of the repo's `node_modules`, served from loopback, so there is no network) and shows that text in a pane beside the drawing.
 * Fonts are bundled (Inter and JetBrains Mono, from node_modules), so that screenshots look the same wherever it runs. The page is three static
 * files in `page/`: `index.html`, `studio.css` (the theme) and `studio.js` (draws, and animates every change with CSS transitions: what is in
 * both drawings moves, what is new grows or draws itself in, what is gone fades out).
 *
 *   /              the drawing (left), the Mermaid source (top right), and room for the assistant's panel (bottom right)
 *   window.drawDiagram(text)   draws `text` (a flowchart or a sequence diagram; an empty text is "nothing drawn yet"); resolves `{ ok: true }` or `{ ok: false, error }` when Mermaid cannot read it
 *
 * The page keeps no diagram of its own that anyone could edit: what it shows is the last text it was given. The agent's state is the text,
 * so a run is checked against the text (and against what the page drew from it), never against what the model said.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const here = join(import.meta.dirname, "page");
const mermaidFile = createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js");
const fontsource = (name: string) => join(dirname(createRequire(import.meta.url).resolve(`@fontsource/${name}/package.json`)), "files");
/** The fonts of the page, by the name the page asks for: Inter for the text, JetBrains Mono for the source pane (both from node_modules, so there is no network). */
export const FONTS: Record<string, string> = {
  "inter-400.woff2": join(fontsource("inter"), "inter-latin-400-normal.woff2"),
  "inter-500.woff2": join(fontsource("inter"), "inter-latin-500-normal.woff2"),
  "inter-600.woff2": join(fontsource("inter"), "inter-latin-600-normal.woff2"),
  "inter-700.woff2": join(fontsource("inter"), "inter-latin-700-normal.woff2"),
  "mono-400.woff2": join(fontsource("jetbrains-mono"), "jetbrains-mono-latin-400-normal.woff2"),
  "mono-500.woff2": join(fontsource("jetbrains-mono"), "jetbrains-mono-latin-500-normal.woff2"),
};
const PAGE: Record<string, [file: string, type: string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/studio.css": ["studio.css", "text/css; charset=utf-8"],
  "/studio.js": ["studio.js", "text/javascript; charset=utf-8"],
};

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
    const font = FONTS[path.startsWith("/fonts/") ? path.slice("/fonts/".length) : ""];
    if (font) return send(200, "font/woff2", readFileSync(font));
    const file = PAGE[path];
    if (file) return send(200, file[1], readFileSync(join(here, file[0])));
    send(404, "text/plain", "not found");
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
