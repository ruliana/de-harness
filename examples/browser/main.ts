// npm run example:browser -- --url https://example.com "Click the More information link" [--text "some text"]... [--out last.png]
// Drives a headless Chromium with the generic browser tools: the page is only a screenshot, Jev points with boxes.
// The browser may only talk to the host of --url, so a click cannot walk the agent off the site.
import { writeFileSync } from "node:fs";
import { BrowserSession, JevModel, browserTools, createAgent } from "../../src/index.js";

const args = process.argv.slice(2);
const take = (flag: string): string[] => {
  const values: string[] = [];
  for (let i = args.indexOf(flag); i >= 0; i = args.indexOf(flag)) values.push(...args.splice(i, 2).slice(1));
  return values;
};
const url = take("--url")[0];
const texts = take("--text");
const out = take("--out")[0];
const instructions = args.join(" ");
if (!url || !instructions) {
  console.error('usage: npm run example:browser -- --url <address> "<what to do>" [--text <candidate>]... [--out last.png]');
  process.exit(2);
}

const browser = await BrowserSession.launch({ allowedHosts: [new URL(url).hostname] });
try {
  await browser.goto(url);
  const result = await createAgent({
    model: new JevModel({ apiKey: process.env.TYPESAFE_API_KEY }),
    instructions,
    tools: browserTools(browser, { texts: texts.length ? texts : undefined }),
    initialState: await browser.snapshot(),
    maxSteps: 12,
    onEvent: (e) => {
      if (e.type === "tool_call") console.log(`step ${e.step}: ${e.tool}(${JSON.stringify(e.args)})`);
      if (e.type === "tool_result" && e.summary) console.log(`        -> ${e.summary}`);
    },
  }).run();
  console.log(`\nstatus: ${result.status} after ${result.steps.length} steps; on ${(await browser.info()).url}`);
  if (result.error) console.error(result.error.message);
  if (out) {
    writeFileSync(out, await browser.screenshot());
    console.log(`wrote ${out}`);
  }
} finally {
  await browser.close();
}
