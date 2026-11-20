/** The browser module: `import { BrowserSession, browserTools } from "de-harness/browser"`. Not part of the core entry; needs the optional `playwright` peer dependency. */
export { BrowserSession, type BrowserOptions, type PageInfo, type ScrollDirection, type Clicked, type Zoomed } from "./session.js";
export { browserTools, snapshotOf, type BrowserToolsOptions, type Candidates } from "./tools.js";
export { DEFAULT_NO_CHANGE, isStuck, nextStuck, sameScreen } from "./stuck.js";
export type { Region } from "./pixels.js";
