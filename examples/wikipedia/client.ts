/**
 * Fetches articles at a fixed point in time, so a run sees the same pages today and next year.
 *
 *   1. revision lookup: the newest revision of a title at or before `snapshot`   (action API, tiny)
 *   2. the article's HTML by that revision id                                     (REST API, immutable)
 *
 * Both go through whatever `fetch` is given: the cassette in tests, the real network in the CLI.
 */
import { parseArticle, type Article } from "./article.js";

/** Revisions are taken as of this moment. Changing it re-records every page. */
export const SNAPSHOT = "2026-11-01T00:00:00Z";

export type WikipediaClientOptions = {
  fetch?: typeof fetch;
  baseUrl?: string;
  snapshot?: string;
};

export type Page = Article & { revision: number };

export class PageError extends Error {}

export function createClient(opts: WikipediaClientOptions = {}) {
  const baseUrl = opts.baseUrl ?? "https://en.wikipedia.org";
  const snapshot = opts.snapshot ?? SNAPSHOT;
  const doFetch = (url: string) => (opts.fetch ?? globalThis.fetch)(url);

  async function revisionOf(title: string): Promise<{ title: string; revision: number }> {
    const url =
      `${baseUrl}/w/api.php?action=query&prop=revisions&rvprop=ids&rvlimit=1&rvdir=older&redirects=1&format=json&formatversion=2` +
      `&rvstart=${encodeURIComponent(snapshot)}&titles=${encodeURIComponent(title)}`;
    const res = await doFetch(url);
    if (!res.ok) throw new PageError(`Wikipedia revision lookup for "${title}" failed: HTTP ${res.status}`);
    const body = (await res.json()) as { query?: { pages?: { title: string; missing?: boolean; revisions?: { revid: number }[] }[] } };
    const page = body.query?.pages?.[0];
    const revision = page?.revisions?.[0]?.revid;
    if (!page || revision === undefined) throw new PageError(`There is no article "${title}" (at ${snapshot})`);
    return { title: page.title, revision };
  }

  /** The article with this title (redirects followed), as it was at the snapshot. */
  async function page(title: string): Promise<Page> {
    const found = await revisionOf(title);
    const res = await doFetch(`${baseUrl}/api/rest_v1/page/html/${encodeURIComponent(found.title.replace(/ /g, "_"))}/${found.revision}`);
    if (!res.ok) throw new PageError(`Wikipedia article "${found.title}" failed: HTTP ${res.status}`);
    // The recorded form (see http.ts) is the parsed article as JSON; the live form is Parsoid HTML.
    const article: Article = (res.headers.get("content-type") ?? "").includes("json") ? ((await res.json()) as Article) : parseArticle(await res.text());
    return { ...article, title: found.title, revision: found.revision };
  }

  return { page };
}
