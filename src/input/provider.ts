/**
 * User input that holds the loop. A tool calls `ctx.input.ask(prompt)` and the loop simply awaits the answer:
 * no request for the next step is sent until the reply arrives.
 *
 * An `InputProvider` is whatever supplies the reply (a terminal, a test script, a web hook). Providers stay simple:
 * the harness itself enforces the timeout and the abort signal around them, so a provider may ignore both.
 */
export type InputProvider = {
  /** Resolve with the user's reply. Rejecting is allowed and becomes the tool's error. */
  ask(prompt: string, options: AskInput): Promise<string>;
};

/** What a provider receives. */
export type AskInput = {
  /** Aborted on timeout or when the run is aborted; honour it to stop waiting early. */
  signal: AbortSignal;
  /** Suggested replies, for providers that can show them. The reply is not restricted to these. */
  choices?: readonly string[];
};

/** Options of one `ctx.input.ask` call. */
export type AskOptions = {
  /** Give up after this long and throw `InputTimeoutError`. Defaults to the agent's `inputTimeoutMs`; unset means wait forever. */
  timeoutMs?: number;
  choices?: readonly string[];
};

/** What tools see as `ctx.input`. */
export type InputPort = {
  ask(prompt: string, options?: AskOptions): Promise<string>;
};

/** Nothing answered in time. Thrown out of `ctx.input.ask`; unless a tool catches it, it becomes the `error` slot. */
export class InputTimeoutError extends Error {
  override name = "InputTimeoutError";
  constructor(readonly timeoutMs: number) {
    super(`No reply from the user within ${timeoutMs} ms`);
  }
}

/** The run was aborted while waiting. The loop ends the run with status `aborted`. */
export class InputAbortedError extends Error {
  override name = "InputAbortedError";
  constructor() {
    super("The run was aborted while waiting for the user");
  }
}

/** No provider was configured, so nothing can be asked. */
export class NoInputProviderError extends Error {
  override name = "NoInputProviderError";
  constructor() {
    super("No user input is available: pass `input` (an InputProvider) to createAgent");
  }
}

export type InputObserver = {
  requested(prompt: string, choices?: readonly string[]): void;
  received(reply: string): void;
  failed(reason: "timeout" | "aborted" | "error", message: string): void;
};

/** Builds the `ctx.input` of one tool call: wraps the provider with the timeout, the abort signal and trace events. */
export function createInputPort(provider: InputProvider | undefined, opts: { signal: AbortSignal; defaultTimeoutMs?: number; observer: InputObserver }): InputPort {
  return {
    async ask(prompt, options = {}) {
      const { observer, signal } = opts;
      const timeoutMs = options.timeoutMs ?? opts.defaultTimeoutMs;
      observer.requested(prompt, options.choices);
      if (!provider) {
        const error = new NoInputProviderError();
        observer.failed("error", error.message);
        throw error;
      }
      if (signal.aborted) {
        observer.failed("aborted", "aborted before asking");
        throw new InputAbortedError();
      }

      const stop = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const interruption = new Promise<never>((_, reject) => {
        if (timeoutMs !== undefined) timer = setTimeout(() => reject(new InputTimeoutError(timeoutMs)), timeoutMs);
        onAbort = () => reject(new InputAbortedError());
        signal.addEventListener("abort", onAbort, { once: true });
      });
      interruption.catch(() => {}); // settled by the race below; never an unhandled rejection
      try {
        const reply = await Promise.race([provider.ask(prompt, { signal: stop.signal, ...(options.choices ? { choices: options.choices } : {}) }), interruption]);
        observer.received(reply);
        return reply;
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        observer.failed(error instanceof InputTimeoutError ? "timeout" : error instanceof InputAbortedError ? "aborted" : "error", error.message);
        throw error;
      } finally {
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener("abort", onAbort);
        stop.abort(); // tell the provider to stop waiting
      }
    },
  };
}
