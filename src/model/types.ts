/**
 * The decision-model abstraction. The loop talks only to `DecisionModel`, so the same agent runs against live
 * Jev, a cassette, or a scripted fake.
 */

export type Image = { format: "png" | "jpg" | "jpeg"; base64: string };

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "box"; instructions: string };

export type Box = { top: number; bottom: number; left: number; right: number };

export type Answer =
  | { type: "choice"; choice: string; confidence: number | null; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number | null; legend?: Record<string, string>; probabilities: Record<string, number> }
  | { type: "box"; box: Box; confidence: number | null };

export type DecisionRequest = {
  /** Everything the questions refer to. Objects with named fields work best. */
  state: unknown;
  /** Questions by id. The model never sees the ids, but answers come back under them. */
  questions: Record<string, Question>;
  /**
   * Images by placeholder. Each placeholder string appearing in `state` or in a question is replaced by the image.
   * A request with images or a Box question is sent with the images header.
   */
  images?: Record<string, Image>;
};

export type DecisionResponse = {
  /** The model that actually answered, e.g. `jev-1.14.0`. */
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
};

export interface DecisionModel {
  /** Identifier of the model this instance asks (pinned, so recordings stay meaningful). */
  readonly id: string;
  /** Resolve with typed answers, or reject with DecisionModelError. A failure is never an answer. */
  ask(request: DecisionRequest): Promise<DecisionResponse>;
}

export class DecisionModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "DecisionModelError";
  }
}
