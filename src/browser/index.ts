/** The browser module: `import { BrowserSession, browserTools } from "de-harness/browser"`. Not part of the core entry; needs the optional `playwright` peer dependency. */
export { BrowserSession, type BrowserOptions, type PageInfo, type ScrollDirection, type Clicked } from "./session.js";
export { browserTools, snapshotOf, type BrowserToolsOptions, type Candidates } from "./tools.js";
export { DEFAULT_NO_CHANGE, isStuck, nextStuck } from "./stuck.js";
