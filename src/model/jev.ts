import { DecisionModelError, type Answer, type DecisionModel, type DecisionRequest, type DecisionResponse } from "./types.js";

export type JevModelOptions = {
  /** Pinned model id. Default `jev-1.14.0`: a versioned id, so recordings replay against the same model. */
  model?: string;
  baseUrl?: string;
  /**
   * Default `dummy`: a proxy injects the real key. Pass a key to talk to the API directly.
   * Never put a real key in a committed file; cassettes redact anything but `Bearer dummy`.
   */
  apiKey?: string;
  /** Retries on 429, 503 and 529. Default 4, with exponential backoff. */
  retries?: number;
  /** First backoff delay in ms. Default 500. */
  backoffMs?: number;
  fetch?: typeof fetch;
};

export class JevModel implements DecisionModel {
  readonly id: string;
  protected readonly baseUrl: string;
  protected readonly apiKey: string;
  protected readonly retries: number;
  protected readonly backoffMs: number;
  protected readonly fetchImpl?: typeof fetch;

  constructor(opts: JevModelOptions = {}) {
    this.id = opts.model ?? "jev-1.14.0";
    this.baseUrl = opts.baseUrl ?? "https://api.typesafe.ai";
    this.apiKey = opts.apiKey ?? "dummy";
    this.retries = opts.retries ?? 4;
    this.backoffMs = opts.backoffMs ?? 500;
    this.fetchImpl = opts.fetch;
  }

  /** Looked up at call time so that a replaced `globalThis.fetch` (e.g. a network block) is honoured. */
  protected doFetch(input: string, init: RequestInit): Promise<Response> {
    return (this.fetchImpl ?? globalThis.fetch)(input, init);
  }

  async ask(request: DecisionRequest): Promise<DecisionResponse> {
    const images = request.images ?? {};
    const hasImages = Object.keys(images).length > 0 || Object.values(request.questions).some((q) => q.type === "box");
    const body = {
      model: this.id,
      state: request.state,
      questions: request.questions,
      ...(Object.keys(images).length
        ? {
            assets: Object.fromEntries(
              Object.entries(images).map(([id, img]) => [id, { type: "image", format: img.format, data_base64: img.base64 }]),
            ),
          }
        : {}),
    };
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` };
    if (hasImages) headers["TypeSafe-Danger-Zone-Images"] = "true";

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.doFetch(`${this.baseUrl}/v1/systemone`, { method: "POST", headers, body: JSON.stringify(body) });
      } catch (e) {
        throw new DecisionModelError(`Jev request failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const text = await res.text();
      if (res.ok) return parseResponse(text);
      const retryable = res.status === 429 || res.status === 503 || res.status === 529;
      if (retryable && attempt < this.retries) {
        await new Promise((r) => setTimeout(r, this.backoffMs * 2 ** attempt));
        continue;
      }
      let detail: unknown = text;
      try {
        detail = JSON.parse(text);
      } catch {}
      throw new DecisionModelError(`Jev request failed: HTTP ${res.status} ${text.slice(0, 500)}`, res.status, detail);
    }
  }
}

function parseResponse(text: string): DecisionResponse {
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new DecisionModelError(`Jev returned a body that is not JSON: ${text.slice(0, 200)}`);
  }
  if (!body || typeof body.model !== "string" || typeof body.answers !== "object" || body.answers === null) {
    throw new DecisionModelError(`Jev returned an unexpected body: ${text.slice(0, 200)}`);
  }
  return { model: body.model, answers: body.answers as Record<string, Answer>, usage: body.usage ?? { input_tokens: 0, output_tokens: 0 } };
}
