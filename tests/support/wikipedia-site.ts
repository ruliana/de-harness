/**
 * A tiny Wikipedia look-alike served on loopback: the same two endpoints the example uses (revision lookup and
 * article HTML by revision), with Parsoid-shaped HTML. Lets tests control what an article contains.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeArticle = {
  title: string;
  /** Wiki links in the lead paragraph: [target, anchor text]. */
  lead?: [string, string][];
  /** Wiki links in the first body section. */
  body?: [string, string][];
  /** Links that must NOT be offered. */
  infobox?: string[];
  seeAlso?: string[];
  references?: string[];
};

const slug = (t: string) => encodeURIComponent(t.replace(/ /g, "_"));
const link = (target: string, text: string) => `<a rel="mw:WikiLink" href="./${slug(target)}" title="${target}">${text}</a>`;

export function articleHtml(a: FakeArticle): string {
  const lead = (a.lead ?? []).map(([t, x]) => link(t, x)).join(", ");
  const body = (a.body ?? []).map(([t, x]) => `<li>${link(t, x)}</li>`).join("");
  return `<!DOCTYPE html><html><head><title>${a.title}</title></head><body>
<section data-mw-section-id="0">
<div role="note" class="hatnote navigation-not-searchable">For other uses, see ${link(`${a.title} (disambiguation)`, "disambiguation")}.</div>
<table class="infobox"><tbody><tr><td>${(a.infobox ?? []).map((t) => link(t, t)).join(" ")}</td></tr></tbody></table>
<p>${a.title} is a made-up article used to test navigation, and it links to ${lead}${link(a.title, "itself")}, ${link("File:Picture.jpg", "a picture")} and ${link("Category:Tests", "a category")}<sup class="mw-ref reference">${link(`${a.title}#cite_note-1`, "[1]")}</sup>.
A broken one: <a rel="mw:WikiLink" href="./Nowhere_Land?action=edit&amp;redlink=1" title="Nowhere Land" class="new">Nowhere Land</a>.</p>
<figure><figcaption>${link("Figure caption link", "caption")}</figcaption></figure>
</section>
<section data-mw-section-id="1"><h2 id="History">History</h2><ul>${body}</ul></section>
<section data-mw-section-id="2"><h2 id="See_also">See also</h2><ul>${(a.seeAlso ?? []).map((t) => `<li>${link(t, t)}</li>`).join("")}</ul></section>
<section data-mw-section-id="3"><h2 id="References">References</h2><div class="reflist"><ol>${(a.references ?? []).map((t) => `<li>${link(t, t)}</li>`).join("")}</ol></div></section>
</body></html>`;
}

export type FakeSite = { baseUrl: string; requests: string[]; close(): Promise<void> };

export async function startFakeSite(articles: FakeArticle[]): Promise<FakeSite> {
  const byTitle = new Map(articles.map((a, i) => [a.title, { article: a, revision: 1000 + i }]));
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/w/api.php") {
      const title = url.searchParams.get("titles") ?? "";
      const found = byTitle.get(title);
      const page = found ? { title, revisions: [{ revid: found.revision }] } : { title, missing: true };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ query: { pages: [page] } }));
      return;
    }
    const m = /^\/api\/rest_v1\/page\/html\/([^/]+)\/(\d+)$/.exec(url.pathname);
    const found = m && byTitle.get(decodeURIComponent(m[1]!).replace(/_/g, " "));
    if (found && String(found.revision) === m![2]) res.writeHead(200, { "content-type": "text/html" }).end(articleHtml(found.article));
    else res.writeHead(404).end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
