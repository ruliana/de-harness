/**
 * Record / replay of HTTP, so acceptance tests are deterministic and need neither a key nor a network.
 *
 *   replay       (default) answer from tests/cassettes; an unrecorded request fails with `no recording for <hash>`
 *   record       call the real network and write the response to the cassette
 *   passthrough  call the real network, write nothing
 *
 * Mode comes from the HARNESS_CASSETTE environment variable (`npm run test:live` sets `record`).
 * The recording key is a hash of method + url + canonical JSON body. Authorization is never recorded except
 * `Bearer dummy`; any other value is stored as `Bearer <redacted>`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JevModel, type JevModelOptions } from "./jev.js";

export type CassetteMode = "record" | "replay" | "passthrough";

export function cassetteMode(): CassetteMode {
  const m = process.env.HARNESS_CASSETTE ?? "replay";
  if (m !== "record" && m !== "replay" && m !== "passthrough") throw new Error(`HARNESS_CASSETTE must be record, replay or passthrough, got "${m}"`);
  return m;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The hash a request is recorded under. */
export function requestHash(method: string, url: string, body: string | undefined): string {
  const b = body === undefined ? "" : canonical(parsed(body));
  return createHash("sha256").update(`${method.toUpperCase()} ${url}\n${b}`).digest("hex").slice(0, 16);
}

export type CassetteEntry = {
  hash: string;
  request: { method: string; url: string; headers: Record<string, string>; body: unknown };
  response: { status: number; contentType: string | null; body: unknown };
};

export type CassetteFetchOptions = {
  /** Directory holding the recordings, e.g. `tests/cassettes/model`. */
  dir: string;
  mode?: CassetteMode;
  /** The fetch used to reach the real network in record / passthrough mode. Default: the global fetch, at call time. */
  inner?: typeof fetch;
};

function redact(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key === "authorization") out[key] = value === "Bearer dummy" ? value : "Bearer <redacted>";
    else if (key === "content-type" || key.startsWith("typesafe-")) out[key] = value;
  });
  return out;
}

export function cassetteFetch(opts: CassetteFetchOptions): typeof fetch {
  const mode = opts.mode ?? cassetteMode();
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    const hash = requestHash(method, url, body);
    const file = join(opts.dir, `${hash}.json`);

    if (mode === "replay") {
      if (!existsSync(file)) throw new Error(`no recording for ${hash} (${method} ${url}); run npm run test:live to record it`);
      const entry = JSON.parse(readFileSync(file, "utf8")) as CassetteEntry;
      const text = typeof entry.response.body === "string" ? entry.response.body : JSON.stringify(entry.response.body);
      return new Response(text, { status: entry.response.status, headers: entry.response.contentType ? { "content-type": entry.response.contentType } : {} });
    }

    const res = await (opts.inner ?? globalThis.fetch)(input, init);
    if (mode === "record" && res.status !== 429 && res.status !== 503 && res.status !== 529) {
      const text = await res.clone().text();
      const entry: CassetteEntry = {
        hash,
        request: { method, url, headers: redact(new Headers(init?.headers)), body: body === undefined ? null : parsed(body) },
        response: { status: res.status, contentType: res.headers.get("content-type"), body: parsed(text) },
      };
      mkdirSync(opts.dir, { recursive: true });
      writeFileSync(file, JSON.stringify(entry, null, 2) + "\n");
    }
    return res;
  };
}

export type CassetteModelOptions = Omit<JevModelOptions, "fetch"> & {
  dir: string;
  mode?: CassetteMode;
  /** Real network access for record / passthrough. Default: the global fetch. */
  inner?: typeof fetch;
};

/** A JevModel whose HTTP goes through a cassette. In replay mode it never touches the network. */
export class CassetteModel extends JevModel {
  constructor(opts: CassetteModelOptions) {
    super({ ...opts, fetch: cassetteFetch({ dir: opts.dir, mode: opts.mode, inner: opts.inner }) });
  }
}
