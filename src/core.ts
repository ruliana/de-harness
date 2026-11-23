/**
 * The browser-safe core: the loop, tools, params, models that talk HTTP, scripted input. Nothing here imports a Node
 * module, so it bundles for a web page (`npm run build` makes `dist/de-harness.browser.js`). The Node entry
 * (`src/index.ts`) is this plus cassettes, terminal input and image files.
 */
export { version } from "./version.js";
export * from "./model/types.js";
export { JevModel, type JevModelOptions } from "./model/jev.js";
export { ScriptedModel, say, type ScriptStep, type ScriptEntry, type Say } from "./model/scripted.js";
export { createAgent, type Agent, type AgentConfig, type RunResult, type StepRecord, type SubAgentConfig } from "./loop/agent.js";
export { defineTool, type Tool, type AnyTool, type ToolContext, type ToolResult, type AvailabilityContext } from "./tools/tool.js";
export { param, readNoul, type BoxSpec, defaultThresholds, type ParamSpec, type Params, type ArgsOf, type Options, type ParamContext, type Thresholds, type Optional } from "./tools/param.js";
export * from "./input/provider.js";
export { ScriptedInput, type ScriptedReply } from "./input/scripted.js";
export { ToolRegistry, type ToolChange } from "./tools/registry.js";
export { delegate, type DelegateOptions } from "./tools/delegate.js";
export { endTool } from "./tools/builtin.js";
export { REVIEW_QUESTION, READY_QUESTION, wantedId, type ReviewConfig } from "./review/review.js";
export type { LookaheadConfig, Criterion, SearchEvent } from "./lookahead/lookahead.js";
export { TOOL_QUESTION, questionId, memberKey, statedKey, presentKey, thresholds } from "./questions/build.js";
export type { HarnessEvent } from "./events/events.js";
export type { Json, StateView } from "./state/state.js";
export { DEFAULT_CONTEXT_BUDGET, CHARS_PER_TOKEN, estimateTokens, requestTokens, BudgetError } from "./budget/budget.js";
export type { Phase } from "./events/events.js";
export { image, isImageValue, IMAGE_LIMITS, type ImageValue } from "./state/images.js";
export { openApiTools, resolveBaseUrl, type OpenApiTools, type OpenApiToolsOptions, type OperationInfo } from "./openapi/openapi.js";
