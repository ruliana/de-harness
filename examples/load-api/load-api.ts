/**
 * Tools that add tools: the agent starts with `load_api` alone, and reading an API's OpenAPI document gives it one tool per endpoint.
 *
 *   load_api(api)   picks one API of `state.apis`, reads its OpenAPI document, adds a tool for each operation it can
 *                   (`openApiTools`, in src/openapi) and removes itself, because there is nothing left to load.
 *
 * The catalog (name -> address of the document) is held by code. The model only picks a name from it: it cannot write an address.
 * Addresses stay out of the state, so a recorded run does not depend on the port the test server happened to get.
 */
import { defineTool, openApiTools, param, resolveBaseUrl, type AnyTool, type Json } from "../../src/index.js";

export type ApiCatalog = Record<string, { description: string; spec: string }>;

export function createLoader(catalog: ApiCatalog, options: { fetch?: typeof fetch } = {}) {
  const doFetch: typeof fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, init);
  const initialState = { apis: Object.entries(catalog).map(([name, { description }]) => ({ name, description })) };

  const loadApi = defineTool({
    name: "load_api",
    description: "Loads one of the APIs of `state.apis`: its endpoints become tools that can be called from the next step on.",
    params: {
      api: param.choice({
        question: "Which API of `state.apis` has the endpoints that `instructions` need?",
        options: () => Object.fromEntries(Object.entries(catalog).map(([name, { description }]) => [name, description])),
      }),
    },
    run: async ({ api }, ctx) => {
      const specUrl = catalog[api]!.spec;
      const res = await doFetch(specUrl);
      if (!res.ok) throw new Error(`GET ${api} document failed with ${res.status}`);
      const spec = (await res.json()) as Record<string, any>;
      const { tools, skipped } = openApiTools(spec, { baseUrl: resolveBaseUrl(spec, specUrl), fetch: doFetch });
      for (const tool of tools) ctx.tools.add(tool);
      ctx.tools.remove("load_api");
      const loaded: Json = { api, tools: tools.map((t: AnyTool) => t.name), not_loaded: skipped.map((s) => `${s.tool}: ${s.reason}`) };
      return { state: { apis: null, loaded }, summary: `loaded the ${api} API: ${tools.length} tools` };
    },
  });

  return { tools: [loadApi] as AnyTool[], initialState };
}
