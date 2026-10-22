/** Routes to compare: from a list, or from the sitemap of the after site. */
import { readFileSync } from "node:fs";

export function parseSitemap(xml) {
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/g)].map((m) =>
    m[1].replace(/&amp;/g, "&"),
  );
  return { index: /<sitemapindex[\s>]/.test(xml), locs };
}

export function toRoute(loc) {
  if (loc.startsWith("/")) return loc;
  if (!URL.canParse(loc)) return null;
  const { pathname, search } = new URL(loc);
  return pathname + search;
}

async function read(source) {
  if (!/^https?:\/\//.test(source)) return readFileSync(source, "utf8");
  const response = await fetch(source);
  if (!response.ok) throw new Error(`${source} answered HTTP ${response.status}`);
  return response.text();
}

/** Where a site keeps its sitemap: the first "Sitemap:" line of robots.txt, else /sitemap.xml. */
export async function findSitemap(site, reader = read) {
  try {
    const line = (await reader(`${site}/robots.txt`)).match(/^sitemap:\s*(\S+)/im);
    // The path only: robots.txt names the public address, the site under test may be local
    if (line && toRoute(line[1])) return site + toRoute(line[1]);
  } catch {
    // no robots.txt
  }
  return `${site}/sitemap.xml`;
}

/**
 * Sorted, unique paths. Without a list, the union of both sitemaps: a new page is in one only.
 * With `orNone` (there are states to compare) a site without a sitemap gives no routes instead
 * of an error; a sitemap named with --sitemap must still be there.
 */
export async function collectRoutes({ routes = [], sitemap, before, after, orNone = false }, reader = read) {
  let found = routes;
  if (!found.length) {
    const sources = sitemap ? [sitemap] : [await findSitemap(after, reader), await findSitemap(before, reader)];
    const locs = [];
    for (const source of sources) {
      let first;
      try {
        first = parseSitemap(await reader(source));
      } catch (err) {
        if (sitemap || (source.startsWith(after) && !orNone)) throw err;
        continue; // the before site may have no sitemap yet
      }
      if (!first.index) locs.push(...first.locs);
      else for (const child of first.locs) locs.push(...parseSitemap(await reader(sitemap ? child : new URL(source).origin + toRoute(child))).locs);
    }
    found = locs.map(toRoute).filter(Boolean);
    if (!found.length && !orNone) throw new Error("No routes found. Pass --routes or --sitemap.");
  }
  return [...new Set(found.map((r) => (r.startsWith("/") ? r : `/${r}`)))].sort();
}

/** A file name for a route: "/" is "index", "/docs/a?b=1" is "docs-a-b-1". */
export function slug(route) {
  return route.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "index";
}
