/**
 * The shops of the generality check and the one-sentence task for each. Nothing here changes how the agent decides: the agent is the
 * one of `examples/storefront-by-sight` (planner, tactics and wording untouched), and the task is the same plain sentence
 * (`plainTask`) with only the shop, the item and the size filled in.
 *
 * `hosts` are the hosts a shop needs to draw itself: its own, its image and font hosts, and its consent banner, so that a
 * visitor's cookie banner is there to be dealt with. Ads, trackers, chat widgets and tag managers are aborted, as for aloyoga.com.
 */
export type Shop = {
  id: string;
  /** What a person types: the shop's name as a domain. */
  name: string;
  platform: string;
  home: string;
  hosts: string[];
  /** The item as the task words it, and the size. */
  what: string;
  size: string;
  /** For the person who scores a run: what a correct end looks like. */
  expect: string;
};

export const SHOPS: Shop[] = [
  {
    id: "taylorstitch",
    name: "taylorstitch.com",
    platform: "Shopify theme, mega menu",
    home: "https://www.taylorstitch.com/",
    hosts: ["taylorstitch.com", "tagalys.com", "shopify.com", "shopifycdn.com", "bunny.net", "googleapis.com", "gstatic.com", "typekit.net", "vimeo.com", "vimeocdn.com", "cookiebot.com"],
    what: "a gray sweater",
    size: "medium",
    expect: "a gray sweater, size M selected, its price",
  },
  {
    id: "llbean",
    name: "llbean.com",
    platform: "custom (L.L.Bean's own stack), e-mail pop-up and cookie notice",
    home: "https://www.llbean.com/",
    hosts: ["llbean.com", "llbean.net", "googleapis.com", "gstatic.com", "dynamicyield.com"],
    what: "a pair of brown boots",
    size: "10",
    expect: "brown boots, size 10 selected, its price",
  },
  {
    id: "zappos",
    name: "zappos.com",
    platform: "custom (Amazon), cookie banner, grid with many brands",
    home: "https://www.zappos.com/",
    hosts: ["zappos.com", "media-amazon.com", "trustarc.com"],
    what: "a pair of white sneakers",
    size: "9",
    expect: "white sneakers, size 9 selected, its price",
  },
  {
    id: "carhartt",
    name: "carhartt.com",
    platform: "Salesforce Commerce Cloud",
    home: "https://www.carhartt.com/",
    hosts: ["carhartt.com", "scene7.com", "googleapis.com", "gstatic.com", "gigya.com", "cdnjs.cloudflare.com"],
    what: "a black hoodie",
    size: "large",
    expect: "a black hooded sweatshirt, size L selected, its price",
  },
  {
    id: "gymshark",
    name: "gymshark.com",
    platform: "headless storefront (Next.js on Shopify), cookie banner over a dark home page",
    home: "https://www.gymshark.com/",
    hosts: ["gymshark.com", "shopify.com", "cookielaw.org", "onetrust.com", "algolia.net", "awswaf.com", "googleapis.com", "gstatic.com"],
    what: "a red t-shirt",
    size: "medium",
    expect: "a red t-shirt, size M selected, its price",
  },
];
