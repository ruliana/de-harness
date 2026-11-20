/**
 * Reads a Wikipedia article (Parsoid HTML, as served by the REST API) into what the agent needs:
 * the title, the lead text, and the links of the article body.
 *
 * "Article-body links" are the wiki links in running text and lists of the article's own sections. Left out:
 * references and everything after them (See also, Further reading, External links, ...), info boxes and other tables,
 * navboxes, figures, hatnotes, citation markers, redlinks, other namespaces (File:, Category:, ...) and self links.
 */
import { parse, type HTMLElement } from "node-html-parser";

export type WikiLink = {
  /** The target article, e.g. "Turing machine". */
  title: string;
  /** How the article's text shows it (up to 3 distinct anchor texts, in order of appearance). */
  texts: string[];
};

export type Article = {
  title: string;
  /** The first paragraph of the lead, as plain text. */
  lead: string;
  /** Distinct body links in document order. */
  links: WikiLink[];
};

/** Sections that hold references, not content. The first one ends the article body. */
const END_SECTIONS = new Set(["see_also", "references", "notes", "footnotes", "citations", "further_reading", "external_links", "bibliography", "sources", "works_cited", "explanatory_notes"]);
const SKIPPED_TAGS = new Set(["sup", "table", "figure", "style", "script", "link", "meta", "sidebar"]);
const SKIPPED_CLASSES = ["hatnote", "navbox", "reflist", "references", "thumb", "mw-references-wrap", "sidebar", "infobox", "shortdescription", "metadata", "mw-ref", "gallery", "toc", "navigation-not-searchable"];
const NAMESPACES = new Set(["file", "image", "category", "help", "wikipedia", "template", "portal", "special", "talk", "user", "draft", "module", "mediawiki", "media", "book", "timedtext", "topic", "wp", "wikt", "commons"]);

function inSkippedPart(el: HTMLElement, within: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n && n !== within; n = n.parentNode) {
    if (SKIPPED_TAGS.has(n.tagName?.toLowerCase())) return true;
    const cls = n.getAttribute?.("class");
    if (cls && SKIPPED_CLASSES.some((c) => cls.split(/\s+/).includes(c))) return true;
    if (n.getAttribute?.("role") === "note") return true;
  }
  return false;
}

/** `./Alan_Turing#Early_life` -> `Alan Turing`; null for anything that is not an article. */
export function articleTitle(href: string): string | null {
  if (!href.startsWith("./") || href.includes("redlink=1")) return null;
  let t = href.slice(2).split("#")[0]!.split("?")[0]!;
  try {
    t = decodeURIComponent(t);
  } catch {
    return null;
  }
  t = t.replace(/_/g, " ").trim();
  if (!t) return null;
  const colon = t.indexOf(":");
  if (colon > 0 && NAMESPACES.has(t.slice(0, colon).toLowerCase().replace(/ talk$/, ""))) return null;
  return t;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseArticle(html: string): Article {
  const root = parse(html);
  const title = squash(root.querySelector("title")?.text ?? "");
  const body = root.querySelector("body") ?? root;
  const sections = body.childNodes.filter((n): n is HTMLElement => (n as HTMLElement).tagName?.toLowerCase() === "section");

  let lead = "";
  const links = new Map<string, WikiLink>();
  for (const [i, section] of sections.entries()) {
    if (i > 0) {
      const heading = section.querySelector("h2, h3, h4");
      if (END_SECTIONS.has((heading?.getAttribute("id") ?? "").toLowerCase())) break;
    }
    if (i === 0 && !lead) {
      for (const p of section.querySelectorAll("p")) {
        if (inSkippedPart(p, section)) continue;
        for (const x of p.querySelectorAll("sup, style")) x.remove();
        const text = squash(p.text);
        if (text.length >= 40) {
          lead = text;
          break;
        }
      }
    }
    for (const a of section.querySelectorAll("a")) {
      if (a.getAttribute("rel") !== "mw:WikiLink" || (a.getAttribute("class") ?? "").split(/\s+/).includes("new")) continue;
      if (inSkippedPart(a, section)) continue;
      const target = articleTitle(a.getAttribute("href") ?? "");
      if (!target || target === title) continue;
      const text = squash(a.text);
      const known = links.get(target);
      if (!known) links.set(target, { title: target, texts: text ? [text] : [] });
      else if (text && known.texts.length < 3 && !known.texts.includes(text)) known.texts.push(text);
    }
  }
  return { title, lead, links: [...links.values()] };
}
