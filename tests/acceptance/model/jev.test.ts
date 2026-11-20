import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CassetteModel, DecisionModelError, JevModel, ScriptedModel, cassetteFetch, say, type DecisionRequest } from "../../../src/index.js";
import { jevFor } from "../../support/models.js";

const DIR = "tests/cassettes/model";
const greeting = (message: string): DecisionRequest => ({
  state: { message },
  questions: { greeting: { type: "noul", instructions: "Is `message` a greeting?" } },
});
const mixed: DecisionRequest = {
  state: { message: "I was charged twice for my subscription this month. Please refund the extra charge." },
  questions: {
    tone: {
      type: "choice",
      instructions: "What is the tone of `message`?",
      criteria: { angry: "An upset or hostile message", calm: "A neutral or polite message", excited: "An enthusiastic or eager message" },
    },
    urgency: { type: "score", instructions: "How urgent is `message`?", criteria: ["Can wait", "Needs attention this week", "Needs attention today"] },
    billing: { type: "noul", instructions: "Is `message` about billing?" },
  },
};

describe("Jev client", () => {
  it("answers a Noul above 0.7 for a greeting and below 0.3 for an invoice email", async () => {
    const jev = jevFor("model");
    const hello = await jev.ask(greeting("hello there, how are you?"));
    const invoice = await jev.ask(greeting("Please find attached invoice 4471 for March, payable within 30 days."));
    const a = hello.answers.greeting!;
    const b = invoice.answers.greeting!;
    expect(a.type === "noul" && a.noul).toBeGreaterThan(0.7);
    expect(b.type === "noul" && b.noul).toBeLessThan(0.3);
  });

  it("returns a Choice, a Score and a Noul as three typed answers under the same ids, plus model and usage", async () => {
    const res = await jevFor("model").ask(mixed);
    expect(Object.keys(res.answers).sort()).toEqual(["billing", "tone", "urgency"]);
    expect(res.answers.tone!.type).toBe("choice");
    expect(res.answers.urgency!.type).toBe("score");
    expect(res.answers.billing!.type).toBe("noul");
    const tone = res.answers.tone!;
    if (tone.type === "choice") expect(Object.keys(tone.probabilities)).toEqual(expect.arrayContaining([tone.choice]));
    expect(res.model).toBe("jev-1.14.0");
    expect(res.usage.input_tokens).toBeGreaterThan(0);
  });

  it("raises DecisionModelError with status 422 for a malformed question, and returns nothing", async () => {
    const bad = { state: { message: "hi" }, questions: { tone: { type: "choice", instructions: "What is the tone of `message`?" } } } as unknown as DecisionRequest;
    const err = await jevFor("model").ask(bad).then(
      () => undefined,
      (e) => e,
    );
    expect(err).toBeInstanceOf(DecisionModelError);
    expect((err as DecisionModelError).status).toBe(422);
  });

  it("passes tests 1 and 2 from cassettes with the network blocked", async () => {
    const blocked = (async () => {
      throw new Error("network is blocked");
    }) as typeof fetch;
    const jev = new CassetteModel({ dir: DIR, mode: "replay", inner: blocked });
    const hello = await jev.ask(greeting("hello there, how are you?"));
    const res = await jev.ask(mixed);
    expect(hello.answers.greeting!.type).toBe("noul");
    expect(Object.keys(res.answers)).toHaveLength(3);
  });

  it("fails an unrecorded request in replay mode with the hash of the missing recording", async () => {
    const jev = new CassetteModel({ dir: DIR, mode: "replay" });
    const err = await jev.ask(greeting("this exact sentence was never recorded")).then(
      () => undefined,
      (e) => e as Error,
    );
    expect(err).toBeInstanceOf(DecisionModelError);
    expect(err!.message).toMatch(/no recording for [0-9a-f]{16}/);
  });

  it("records every request with Authorization: Bearer dummy and the pinned model id", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      const entry = JSON.parse(readFileSync(join(DIR, f), "utf8"));
      expect(entry.request.headers.authorization).toBe("Bearer dummy");
      expect(entry.request.body.model).toBe("jev-1.14.0");
    }
  });

  it("retries on 429 with backoff, then succeeds", async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      return calls < 3
        ? new Response("{}", { status: 429 })
        : new Response(JSON.stringify({ model: "jev-1.14.0", answers: { greeting: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    }) as typeof fetch;
    const res = await new JevModel({ fetch: flaky, backoffMs: 1 }).ask(greeting("hi"));
    expect(calls).toBe(3);
    expect(res.answers.greeting!.type).toBe("noul");
  });

  it("surfaces a server error as DecisionModelError instead of an answer", async () => {
    const down = (async () => new Response('{"detail":"boom"}', { status: 500 })) as typeof fetch;
    await expect(new JevModel({ fetch: down }).ask(greeting("hi"))).rejects.toMatchObject({ name: "DecisionModelError", status: 500 });
  });
});

describe("fetch cassette for external HTTP", () => {
  it("records a response from a real server, then replays it with the server gone", async () => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ title: "Alan Turing", revision: 1234 }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/page`;
    const dir = mkdtempSync(join(tmpdir(), "cassette-"));

    const recorded = await cassetteFetch({ dir, mode: "record", inner: fetch })(url).then((r) => r.json());
    await new Promise((r) => server.close(r));
    const replayed = await cassetteFetch({ dir, mode: "replay" })(url).then((r) => r.json());

    expect(recorded).toEqual({ title: "Alan Turing", revision: 1234 });
    expect(replayed).toEqual(recorded);
  });
});

describe("ScriptedModel", () => {
  it("answers from a script, defaults the rest, repeats the last step and records requests", async () => {
    const model = new ScriptedModel([{ tone: "calm", billing: 0.9, urgency: say.score(2) }, { tone: "angry" }]);
    const first = await model.ask(mixed);
    expect(first.answers.tone).toMatchObject({ type: "choice", choice: "calm" });
    expect(first.answers.billing).toMatchObject({ noul: 0.9 });
    expect(first.answers.urgency).toMatchObject({ score: 2 });
    const second = await model.ask(mixed);
    const third = await model.ask(mixed);
    expect(second.answers.tone).toMatchObject({ choice: "angry" });
    expect(third.answers.tone).toMatchObject({ choice: "angry" });
    expect(third.answers.billing).toMatchObject({ noul: 0.5 });
    expect(model.requests).toHaveLength(3);
  });

  it("fails with DecisionModelError when the script says the model fails", async () => {
    const model = new ScriptedModel([new DecisionModelError("overloaded", 529)]);
    await expect(model.ask(mixed)).rejects.toMatchObject({ status: 529 });
  });
});
