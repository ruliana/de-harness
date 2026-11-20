/**
 * OpenAPI to tools: one tool per operation of an OpenAPI 3 document, with its parameters turned into harness questions.
 *
 *   enum (string or number)             Choice over the enum values
 *   boolean                             Noul ('unsure' on a required one fails the call; an optional one is simply not sent)
 *   array of enum                       Set: one Noul per member
 *   integer with a small min..max       Choice over the numbers
 *   path parameter (`/tickets/{id}`)    Choice over the ids found in the state: the response of the GET on the collection (`/tickets`),
 *                                       which the agent has to have called first, so the tool is left out of a step until then
 *   anything else (free text, ...)      Jev cannot write text, so the caller supplies candidates (`candidates`), or the operation
 *                                       is not turned into a tool and appears in `skipped` with the reason
 *   not required                        `optional: { stated }`: one more Noul asks whether `instructions` state a value at all
 *
 * Calling a tool sends the request, and the response goes to `state.api.<tool>`. A failed call (not 2xx) throws, which the loop turns
 * into the `error` slot of the next step. After a call that is not a GET, the GETs the agent has made are made again, so the state
 * shows what the server says now.
 *
 * Question wording is in `wording` below, one place, and names the action by its summary and state by path in backticks.
 */
import { param, type Options, type ParamContext, type ParamSpec } from "../tools/param.js";
import { defineTool, type AnyTool } from "../tools/tool.js";

type Schema = Record<string, any>;
type Spec = Record<string, any>;

export type OperationInfo = { tool: string; method: string; path: string; summary: string };

export type OpenApiToolsOptions = {
  /** Where the paths of the document live, without a trailing slash. See `resolveBaseUrl`. */
  baseUrl: string;
  /** Leave an operation out. Default: every operation becomes a tool. */
  include?: (operation: OperationInfo) => boolean;
  /**
   * Candidates for a parameter that has no enum and is not an id taken from the state (free text, an unbounded number).
   * Return `undefined` when there are none: the operation is then skipped.
   */
  candidates?: (where: { tool: string; param: string; schema: Schema }) => Options | ((ctx: ParamContext) => Options) | undefined;
  /** Default: the global fetch, looked up at call time. */
  fetch?: typeof fetch;
};

export type OpenApiTools = {
  tools: AnyTool[];
  /** Operations that could not become a tool, and why. */
  skipped: { tool: string; reason: string }[];
};

/** The address paths are relative to: the first `servers` entry (which may be relative to where the document was read from), else the document's own directory. */
export function resolveBaseUrl(spec: Spec, specUrl: string): string {
  return new URL(spec.servers?.[0]?.url ?? ".", specUrl).href.replace(/\/$/, "");
}

/** The words of the questions. */
const wording = {
  action: (op: OperationInfo) => `the action "${op.summary}"`,
  enumValue: (op: OperationInfo, label: string) => `For ${wording.action(op)}, which ${label} do \`instructions\` call for?`,
  yesNo: (op: OperationInfo, label: string) => `For ${wording.action(op)}, do \`instructions\` call for this: ${label}?`,
  member: (op: OperationInfo, label: string) => `For ${wording.action(op)}, do \`instructions\` call for {} as ${label}?`,
  stated: (op: OperationInfo, label: string) => `For ${wording.action(op)}, do \`instructions\` state ${label}?`,
  entry: (op: OperationInfo, label: string, listSlot: string) => `Which entry of \`${listSlot}\` is the ${label} for ${wording.action(op)}, to carry out \`instructions\`?`,
};

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

type Where = "path" | "query" | "body";
type Param = { name: string; key: string; where: Where; required: boolean; schema: Schema };
type Operation = OperationInfo & { description: string; params: Param[]; hasBody: boolean };

const snake = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

export function openApiTools(spec: Spec, options: OpenApiToolsOptions): OpenApiTools {
  const deref = <T>(node: T, depth = 0): T => {
    const ref = node && typeof node === "object" ? (node as Schema).$ref : undefined;
    if (typeof ref !== "string") return node;
    if (!ref.startsWith("#/") || depth > 20) throw new Error(`Unsupported or circular $ref: ${ref}`);
    let target: unknown = spec;
    for (const part of ref.slice(2).split("/")) target = (target as Schema | undefined)?.[part.replaceAll("~1", "/").replaceAll("~0", "~")];
    if (target === undefined) throw new Error(`$ref does not resolve: ${ref}`);
    return deref(target as T, depth + 1);
  };

  const operations: Operation[] = [];
  for (const [path, rawItem] of Object.entries<Spec>(spec.paths ?? {})) {
    const item = deref(rawItem);
    for (const method of METHODS) {
      const op: Spec | undefined = item[method];
      if (!op) continue;
      const tool = snake(op.operationId ?? `${method}_${path}`);
      const params: Param[] = [];
      const taken = new Set<string>();
      const add = (name: string, where: Where, required: boolean, schema: Schema) => {
        const key = taken.has(name) ? `${where}_${name}` : name;
        taken.add(key);
        params.push({ name, key, where, required, schema: deref(schema ?? {}) });
      };
      for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        const p = deref<Spec>(raw);
        if (p.in === "path" || p.in === "query") add(p.name, p.in, p.in === "path" || p.required === true, { ...(p.description ? { description: p.description } : {}), ...deref(p.schema ?? {}) });
      }
      const body = deref<Schema>(op.requestBody?.content?.["application/json"]?.schema ?? {});
      for (const [name, raw] of Object.entries<Schema>(body.properties ?? {})) add(name, "body", (body.required ?? []).includes(name), raw);
      operations.push({ tool, method: method.toUpperCase(), path, summary: op.summary ?? op.description ?? tool, description: op.description ?? "", params, hasBody: Object.keys(body.properties ?? {}).length > 0 });
    }
  }

  const info = (op: Operation): OperationInfo => ({ tool: op.tool, method: op.method, path: op.path, summary: op.summary });
  const wanted = operations.filter((op) => options.include?.(info(op)) ?? true);
  const wantedTools = new Map(wanted.map((op) => [op.tool, op]));
  const skipped: OpenApiTools["skipped"] = [];
  const reads = new Map<string, Record<string, unknown>>();
  const doFetch: typeof fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, init);

  /** The GET on the collection a path parameter points into: `/tickets/{id}/close` -> the GET on `/tickets`. */
  const listFor = (op: Operation, p: Param): Operation | undefined => {
    const segments = op.path.split("/");
    const at = segments.indexOf(`{${p.name}}`);
    const collection = segments.slice(0, at).join("/") || "/";
    return wanted.find((o) => o.method === "GET" && o.path === collection && o.params.every((q) => q.where !== "path"));
  };

  /** The entries of a list response: an array, or the first array an object holds. */
  const entriesOf = (response: unknown): Record<string, unknown>[] => {
    const list = Array.isArray(response) ? response : response && typeof response === "object" ? Object.values(response).find(Array.isArray) : undefined;
    return ((list ?? []) as unknown[]).filter((e): e is Record<string, unknown> => !!e && typeof e === "object");
  };

  const label = (p: Param) => `\`${p.name}\`${p.schema.description ? ` (${p.schema.description})` : ""}`;
  const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

  /** How a parameter is asked, or why it cannot be. */
  const specFor = (op: Operation, p: Param): { spec: ParamSpec; decode: (value: any) => unknown } | { reason: string } => {
    const s = p.schema;
    const optional = p.required ? {} : { optional: { stated: wording.stated(op, label(p)) } };
    const numeric = s.type === "integer" || s.type === "number";
    const parse = (v: string) => (numeric ? Number(v) : v);
    if (Array.isArray(s.enum)) return { spec: param.choice({ question: wording.enumValue(op, label(p)), options: s.enum.map(String), ...optional }), decode: parse };
    if (s.type === "boolean") {
      return { spec: param.noul({ question: wording.yesNo(op, p.schema.description ?? p.name), ...optional }), decode: (v: boolean | "unsure") => {
        if (v === "unsure") throw new Error(`"${p.name}" was not sent: the answer was unsure`);
        return v;
      } };
    }
    if (s.type === "array") {
      const items = deref<Schema>(s.items ?? {});
      if (!Array.isArray(items.enum)) return { reason: `parameter "${p.name}" is a list of free values` };
      return { spec: param.set({ question: wording.member(op, label(p)), members: items.enum.map(String), ...optional }), decode: (v: string[]) => v.map((m) => (items.type === "integer" || items.type === "number" ? Number(m) : m)) };
    }
    if (numeric && Number.isInteger(s.minimum) && Number.isInteger(s.maximum) && s.maximum - s.minimum < 10 && s.maximum >= s.minimum) {
      const options = Array.from({ length: s.maximum - s.minimum + 1 }, (_, i) => String(s.minimum + i));
      return { spec: param.choice({ question: wording.enumValue(op, label(p)), options, ...optional }), decode: parse };
    }
    const supplied = options.candidates?.({ tool: op.tool, param: p.name, schema: s });
    if (supplied) return { spec: param.choice({ question: wording.enumValue(op, label(p)), options: supplied as Options, ...optional } as never), decode: parse };
    if (p.where === "path") {
      const list = listFor(op, p);
      if (!list) return { reason: `path parameter "${p.name}" has no GET on its collection to take ids from` };
      const slot = `state.api.${list.tool}`;
      const key = (e: Record<string, unknown>) => e[p.name] ?? e.id;
      return {
        spec: param.choice({
          question: wording.entry(op, p.name, slot),
          options: (ctx) =>
            Object.fromEntries(
              entriesOf(ctx.state.api?.[list.tool])
                .filter((e) => key(e) !== undefined)
                .map((e) => [String(key(e)), Object.entries(e).filter(([k, v]) => v !== null && typeof v !== "object" && k !== p.name && k !== "id").map(([k, v]) => `${k}: ${v}`).join(", ")]),
            ),
        }),
        decode: parse,
      };
    }
    return { reason: `parameter "${p.name}" is free text, which the model cannot write, and no candidates were supplied` };
  };

  const call = async (op: Operation, args: Record<string, unknown>): Promise<unknown> => {
    let path = op.path;
    const query = new URLSearchParams();
    const body: Record<string, unknown> = {};
    for (const p of op.params) {
      const value = args[p.key];
      if (value === undefined) continue;
      if (p.where === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
      else if (p.where === "query") for (const v of Array.isArray(value) ? value : [value]) query.append(p.name, String(v));
      else body[p.name] = value;
    }
    const url = `${options.baseUrl}${path}${query.size ? `?${query}` : ""}`;
    const res = await doFetch(url, { method: op.method, ...(op.hasBody ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const raw = await res.text();
    let data: unknown = raw;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      /* not JSON: keep the text */
    }
    if (!res.ok) {
      const reason = data && typeof data === "object" ? ((data as Schema).error ?? (data as Schema).message) : undefined;
      throw new Error(`${op.method} ${op.path} failed with ${res.status}: ${reason ?? (raw.slice(0, 200) || "no details")}`);
    }
    return data;
  };

  const tools: AnyTool[] = [];
  for (const op of wanted) {
    const params: Record<string, ParamSpec> = {};
    const decoders: Record<string, (value: any) => unknown> = {};
    let reason: string | undefined;
    for (const p of op.params) {
      const made = specFor(op, p);
      if ("reason" in made) {
        reason = made.reason;
        break;
      }
      params[p.key] = made.spec;
      decoders[p.key] = made.decode;
    }
    if (reason) {
      skipped.push({ tool: op.tool, reason });
      continue;
    }
    tools.push(
      defineTool({
        name: op.tool,
        description: `${op.summary} (${op.method} ${op.path}). ${op.description ? `${op.description} ` : ""}The response is put in \`state.api.${op.tool}\`.`,
        params,
        run: async (args, ctx) => {
          const sent: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(args as Record<string, unknown>)) if (value !== undefined) sent[key] = decoders[key]!(value);
          const response = await call(op, sent);
          const api: Record<string, unknown> = { ...(ctx.state.api ?? {}), [op.tool]: response };
          if (op.method === "GET") reads.set(op.tool, sent);
          else {
            // the server changed: ask again what the agent has looked at, so the state is not stale
            for (const [name, again] of reads) {
              try {
                api[name] = await call(wantedTools.get(name)!, again);
              } catch {
                delete api[name];
                reads.delete(name);
              }
            }
          }
          return { state: { api: api as never }, summary: `${op.method} ${op.path} -> ${op.tool}` };
        },
      }),
    );
  }
  return { tools, skipped };
}
