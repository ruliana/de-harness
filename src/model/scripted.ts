/**
 * A model that answers from a script, for mechanics tests that need a forced decision.
 * It still goes through the public API end to end, so such tests are acceptance tests.
 *
 * Each script step is `Record<questionId, Say | string | number>` (or a function of the request returning one):
 *   string  -> choice of that option      number -> noul probability
 *   say.score(2) / say.box({...}) for the others.
 * Questions a step does not mention get a neutral default (first option, level 0, noul 0.5).
 * When the script runs out, the last step repeats. An `Error` step makes the model fail.
 * Every request received is kept in `requests`.
 */
import { DecisionModelError, type Answer, type Box, type DecisionModel, type DecisionRequest, type DecisionResponse, type Question } from "./types.js";

export type Say = Answer;
export const say = {
  choice: (choice: string, probability = 0.95): Say => ({ type: "choice", choice, confidence: probability, probabilities: { [choice]: probability } }),
  noul: (noul: number): Say => ({ type: "noul", noul }),
  score: (level: number, probability = 0.95): Say => ({ type: "score", score: level, confidence: probability, probabilities: { [String(level)]: probability } }),
  box: (box: Box): Say => ({ type: "box", box, confidence: 0.9 }),
};

export type ScriptStep = Record<string, Say | string | number>;
export type ScriptEntry = ScriptStep | Error | ((request: DecisionRequest, index: number) => ScriptStep | Error);

export class ScriptedModel implements DecisionModel {
  readonly id = "scripted";
  readonly requests: DecisionRequest[] = [];

  constructor(private readonly script: ScriptEntry[]) {
    if (script.length === 0) throw new Error("ScriptedModel needs at least one step");
  }

  async ask(request: DecisionRequest): Promise<DecisionResponse> {
    const index = this.requests.length;
    this.requests.push(structuredClone(request));
    const raw = this.script[Math.min(index, this.script.length - 1)]!;
    const entry = typeof raw === "function" ? raw(request, index) : raw;
    if (entry instanceof Error) {
      throw entry instanceof DecisionModelError ? entry : new DecisionModelError(entry.message);
    }
    const answers: Record<string, Answer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      answers[id] = answerFor(question, entry[id]);
    }
    return { model: this.id, answers, usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

function answerFor(question: Question, said: Say | string | number | undefined): Answer {
  if (said !== undefined && typeof said === "object") return said;
  switch (question.type) {
    case "choice": {
      const options = Object.keys(question.criteria);
      const choice = typeof said === "string" ? said : options[0]!;
      if (!options.includes(choice)) throw new DecisionModelError(`ScriptedModel: "${choice}" is not one of ${options.join(", ")}`);
      return say.choice(choice);
    }
    case "noul":
      return say.noul(typeof said === "number" ? said : 0.5);
    case "score":
      return say.score(typeof said === "number" ? said : 0);
    case "box":
      return say.box({ top: 0, bottom: 1, left: 0, right: 1 });
  }
}
