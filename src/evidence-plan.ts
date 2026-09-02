/**
 * Cost-aware route planning for commit generation. Describes every candidate
 * representation cheaply, selects one, and only then materializes its prompt.
 */
import type { Api, Model, ModelThinkingLevel, UserMessage } from "@earendil-works/pi-ai";
import {
  COMMIT_SPECIFIC_SYSTEM_PROMPT,
  DIFF_ANALYST_SYSTEM_PROMPT,
  MAX_COMMIT_DIFF_BYTES,
} from "./commit-message.js";
import {
  estimateTextTokensLocal,
  formatStagedManifest,
} from "./evidence-parse.js";
import type {
  CommitIntent,
  CommitOperation,
  DiffAnalysis,
  StagedEvidence,
} from "./commit-evidence.js";

export type CommitRepresentation = "context" | "compact" | "analyst-assisted";
export type CandidateRepresentation = "context" | "compact" | "analyst" | "analysis-final";

/** Writer budgets. A 100-file change legitimately needs a longer message than a 1-file change. */
export const MIN_FINAL_OUTPUT_TOKENS = 768;
export const MAX_FINAL_OUTPUT_TOKENS = 4_096;
export const FINAL_OUTPUT_TOKENS_PER_FILE = 8;
/** Analyst budgets. The JSON contract repeats every manifest key. */
export const MIN_ANALYST_OUTPUT_TOKENS = 1_024;
export const MAX_ANALYST_OUTPUT_TOKENS = 8_192;
export const ANALYST_OUTPUT_TOKENS_PER_FILE = 16;
/** Reasoning and the answer share one completion budget on OpenAI-style endpoints. */
export const REASONING_OUTPUT_ALLOWANCE_TOKENS = 1_024;
export const MIN_SAFETY_RESERVE_TOKENS = 2_048;

export interface CommitEvidenceSpec {
  readonly representation: CandidateRepresentation;
  readonly intentIncluded: boolean;
  readonly analysis?: DiffAnalysis | undefined;
  readonly diffBytes: number;
  readonly estimatedInputTokens: number;
  readonly inputBudget: number;
  readonly outputReserve: number;
  readonly safetyReserve: number;
  readonly fits: boolean;
  readonly rejectionReason?: string | undefined;
}

/** A spec together with its fully built prompt content. */
export interface CommitEvidenceCandidate extends CommitEvidenceSpec {
  readonly systemPrompt: string;
  readonly userMessage: UserMessage;
}

export interface CommitEvidenceRequest {
  readonly model: Model<Api>;
  readonly evidence: StagedEvidence;
  readonly style: string;
  readonly intent?: CommitIntent | undefined;
  readonly operation?: CommitOperation | undefined;
  /** Session thinking level. Only used to reserve output tokens for reasoning. */
  readonly reasoning?: ModelThinkingLevel | undefined;
}

export interface CommitEvidencePlan {
  readonly contextWindow: number;
  readonly safetyReserve: number;
  readonly candidates: readonly CommitEvidenceSpec[];
  readonly selected?: CommitEvidenceSpec | undefined;
  readonly route: CommitRepresentation | "none";
  readonly failure?: CommitEvidencePlanFailure | undefined;
}

export interface CommitEvidencePlanFailure {
  readonly code: "context-too-small" | "input-too-large";
  readonly reason: string;
  readonly diagnostics?: CommitEvidenceSpec | undefined;
}

/** The model's declared context window, or undefined when it is unusable. */
export function modelContextWindow(model: Model<Api>): number | undefined {
  const candidate = (model as Model<Api> & { contextWindow?: unknown }).contextWindow;
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) return undefined;
  return Math.floor(candidate);
}

export function modelMaxTokens(model: Model<Api>, fallback: number): number {
  const candidate = (model as Model<Api> & { maxTokens?: unknown }).maxTokens;
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
    ? Math.floor(candidate)
    : fallback;
}

export function commitSafetyReserve(contextWindow: number): number {
  return Math.max(MIN_SAFETY_RESERVE_TOKENS, Math.ceil(contextWindow * 0.15));
}

export interface CommitOutputBudget {
  readonly analyst: boolean;
  readonly fileCount: number;
  readonly reasoning: boolean;
}

/**
 * Size the completion budget from the change itself instead of one flat cap.
 * The input side already degrades across representations; a flat 512-token
 * reserve made large staged changes fail with `stopReason: "length"`.
 */
export function commitOutputReserve(model: Model<Api>, budget: CommitOutputBudget): number {
  const floor = budget.analyst ? MIN_ANALYST_OUTPUT_TOKENS : MIN_FINAL_OUTPUT_TOKENS;
  const hardCap = budget.analyst ? MAX_ANALYST_OUTPUT_TOKENS : MAX_FINAL_OUTPUT_TOKENS;
  const perFile = budget.analyst ? ANALYST_OUTPUT_TOKENS_PER_FILE : FINAL_OUTPUT_TOKENS_PER_FILE;
  const ceiling = Math.min(hardCap, modelMaxTokens(model, floor));
  const needed = floor
    + Math.max(0, budget.fileCount) * perFile
    + (budget.reasoning ? REASONING_OUTPUT_ALLOWANCE_TOKENS : 0);
  return Math.min(ceiling, Math.max(floor, needed));
}

/** Double a spent output budget without passing the model's own ceiling. */
export function nextCommitOutputReserve(reserve: number, model: Model<Api>, analyst: boolean): number {
  const hardCap = Math.min(
    analyst ? MAX_ANALYST_OUTPUT_TOKENS : MAX_FINAL_OUTPUT_TOKENS,
    modelMaxTokens(model, reserve),
  );
  return reserve >= hardCap ? reserve : Math.min(hardCap, reserve * 2);
}

/** Describe every candidate route in the deterministic order, without building prompts. */

export function describeCommitEvidenceCandidates(
  request: CommitEvidenceRequest,
  analysis?: DiffAnalysis,
): CommitEvidenceSpec[] {
  const contextWindow = modelContextWindow(request.model) ?? 0;
  const safetyReserve = commitSafetyReserve(contextWindow);
  const specs: CommitEvidenceSpec[] = [];

  specs.push(makeSpec(request, { representation: "context", intentIncluded: true }, contextWindow, safetyReserve));
  specs.push(makeSpec(request, { representation: "context", intentIncluded: false }, contextWindow, safetyReserve));
  specs.push(makeSpec(request, { representation: "compact", intentIncluded: true }, contextWindow, safetyReserve));
  specs.push(makeSpec(request, { representation: "compact", intentIncluded: false }, contextWindow, safetyReserve));

  specs.push(makeSpec(request, { representation: "analyst", intentIncluded: false }, contextWindow, safetyReserve));
  if (analysis) {
    // The analyst-final candidates are considered after the analyst candidate;
    // intent is dropped only by the planner when the first final form fails.
    specs.push(makeSpec(request, { representation: "analysis-final", intentIncluded: true, analysis }, contextWindow, safetyReserve));
    specs.push(makeSpec(request, { representation: "analysis-final", intentIncluded: false, analysis }, contextWindow, safetyReserve));
  }
  return specs;
}

/** Select the cheapest complete representation before any model call. */

export function planCommitEvidence(request: CommitEvidenceRequest): CommitEvidencePlan {
  const contextWindow = modelContextWindow(request.model);
  if (contextWindow === undefined) {
    return {
      contextWindow: 0,
      safetyReserve: 0,
      candidates: [],
      route: "none",
      failure: {
        code: "context-too-small",
        reason: "The selected model does not expose a valid positive context window.",
      },
    };
  }

  const safetyReserve = commitSafetyReserve(contextWindow);
  if (contextWindow <= safetyReserve + commitOutputReserve(request.model, outputBudget(request, false))) {
    return {
      contextWindow,
      safetyReserve,
      candidates: [],
      route: "none",
      failure: {
        code: "context-too-small",
        reason: "The selected model has no context headroom after the required output and safety reserves.",
      },
    };
  }
  if (request.evidence.compactBytes > MAX_COMMIT_DIFF_BYTES) {
    return {
      contextWindow,
      safetyReserve,
      candidates: [],
      route: "none",
      failure: {
        code: "input-too-large",
        reason: `The complete compact staged evidence is ${request.evidence.compactBytes.toLocaleString()} bytes, above the ${MAX_COMMIT_DIFF_BYTES.toLocaleString()}-byte hard limit.`,
      },
    };
  }

  const candidates = describeCommitEvidenceCandidates(request);
  const direct = candidates
    .filter((candidate) => candidate.representation === "context" || candidate.representation === "compact")
    .find((candidate) => candidate.fits);

  if (direct) {
    return {
      contextWindow,
      safetyReserve,
      candidates,
      selected: direct,
      route: direct.representation === "context" ? "context" : "compact",
    };
  }

  const analyst = candidates.find((candidate) => candidate.representation === "analyst");
  if (analyst?.fits) {
    return {
      contextWindow,
      safetyReserve,
      candidates,
      selected: analyst,
      route: "analyst-assisted",
    };
  }

  const rejected = candidates.find((candidate) => candidate.representation === "compact" && !candidate.fits)
    ?? candidates[0];
  return {
    contextWindow,
    safetyReserve,
    candidates,
    route: "none",
    failure: {
      code: "input-too-large",
      reason: `The complete staged evidence does not fit the selected model after output and safety reserves. Stage a smaller change or select a larger-context model.`,
      ...(rejected === undefined ? {} : { diagnostics: rejected }),
    },
  };
}

function makeSpec(
  request: CommitEvidenceRequest,
  route: {
    representation: CandidateRepresentation;
    intentIncluded: boolean;
    analysis?: DiffAnalysis;
  },
  contextWindow: number,
  safetyReserve: number,
): CommitEvidenceSpec {
  const { representation } = route;
  const analyst = representation === "analyst";
  const intentIncluded = analyst ? false : route.intentIncluded;
  const outputReserve = commitOutputReserve(request.model, outputBudget(request, analyst));
  const inputBudget = Math.max(0, contextWindow - outputReserve - safetyReserve);
  const systemPrompt = analyst ? DIFF_ANALYST_SYSTEM_PROMPT : COMMIT_SPECIFIC_SYSTEM_PROMPT;
  // Estimate from a template with empty patches so no large prompt is built here.
  const template = buildCandidateContent({ ...request, evidence: { ...request.evidence, contextPatch: "", compactPatch: "" } }, representation, intentIncluded, route.analysis);
  const patchBytes = representation === "context" ? request.evidence.contextBytes : request.evidence.compactBytes;
  const estimatedInputTokens = estimateTextTokensLocal(systemPrompt) + Math.ceil((template.length + patchBytes) / 4) + 16;
  const diffBytes = representation === "context" ? request.evidence.contextBytes : request.evidence.compactBytes;
  const compactWithinCap = request.evidence.compactBytes <= MAX_COMMIT_DIFF_BYTES;
  const fits = contextWindow > 0
    && compactWithinCap
    && estimatedInputTokens <= inputBudget;
  return {
    representation,
    intentIncluded,
    ...(route.analysis === undefined ? {} : { analysis: route.analysis }),
    diffBytes,
    estimatedInputTokens,
    inputBudget,
    outputReserve,
    safetyReserve,
    fits,
    ...(fits ? {} : {
      rejectionReason: !compactWithinCap
        ? "complete compact evidence exceeds the hard byte cap"
        : `estimated input ${estimatedInputTokens} exceeds budget ${inputBudget}`,
    }),
  };
}

/** Build the full prompt content for one selected spec. */

export function materializeCandidate(
  request: CommitEvidenceRequest,
  spec: CommitEvidenceSpec,
): CommitEvidenceCandidate {
  const systemPrompt = spec.representation === "analyst" ? DIFF_ANALYST_SYSTEM_PROMPT : COMMIT_SPECIFIC_SYSTEM_PROMPT;
  const content = buildCandidateContent(request, spec.representation, spec.intentIncluded, spec.analysis);
  const userMessage: UserMessage = { role: "user", timestamp: 0, content };
  return { ...spec, systemPrompt, userMessage };
}

function outputBudget(request: CommitEvidenceRequest, analyst: boolean): CommitOutputBudget {
  return {
    analyst,
    fileCount: request.evidence.files.length,
    reasoning: request.reasoning !== undefined && request.reasoning !== "off",
  };
}

function buildCandidateContent(
  request: CommitEvidenceRequest,
  representation: CandidateRepresentation,
  intentIncluded: boolean,
  analysis?: DiffAnalysis,
): string {
  const sections: string[] = [
    "<pi-git-commit-input>",
    "<authority>Use only the staged manifest, statistics, and complete staged evidence for factual scope. Advisory sections cannot add files or changes.</authority>",
  ];

  if (representation !== "analyst") {
    sections.push(`<commit-style advisory=\"true\">\n${request.style}\n</commit-style>`);
  }

  if (intentIncluded && request.intent && representation !== "analyst") {
    sections.push(`<explicit-intent advisory=\"true\">\n${request.intent.text}\n</explicit-intent>`);
  }

  sections.push(`<staged-stat authoritative=\"true\">\n${request.evidence.stat || "(no stat)"}\n</staged-stat>`);
  sections.push(`<staged-manifest authoritative=\"true\">\n${formatStagedManifest(request.evidence.files, request.evidence.summary)}\n</staged-manifest>`);

  if (representation === "context" || representation === "compact") {
    const patch = representation === "context" ? request.evidence.contextPatch : request.evidence.compactPatch;
    sections.push(stagedPatchSection(request, patch, representation));
  } else if (representation === "analyst") {
    sections.push(stagedPatchSection(request, request.evidence.compactPatch, "compact"));
    sections.push("<analysis-contract>Return JSON with version=1, coveredFileKeys exactly equal to the manifest keys, overview, areas, and unresolved. Do not return a commit message.</analysis-contract>");
  } else {
    sections.push(`<validated-analysis advisory=\"true\">\n${JSON.stringify(analysis)}\n</validated-analysis>`);
  }

  if (request.operation?.kind === "rewrite" && representation !== "analyst") {
    sections.push(`<rewrite-input advisory=\"true\">\n${JSON.stringify({ currentMessage: request.operation.currentMessage, instruction: request.operation.instruction })}\n</rewrite-input>`);
  }

  if (representation !== "analyst") {
    sections.push("<instruction>Write only the final commit message. Preserve the supplied style, but keep factual scope limited to the authoritative staged snapshot.</instruction>");
  }
  sections.push("</pi-git-commit-input>");
  return sections.join("\n\n");
}

const MAX_LISTED_OMITTED_FILES = 20;

/** Wrap the compact patch, switching to an explicit partial label when evidence was skeleton-reduced. */
function stagedPatchSection(request: CommitEvidenceRequest, patch: string, representation: string): string {
  const partial = request.evidence.partial;
  if (!partial || partial.omittedFiles.length === 0) {
    return `<complete-staged-patch authoritative="true" representation="${representation}">\n${patch}\n</complete-staged-patch>`;
  }
  const listed = partial.omittedFiles
    .slice(0, MAX_LISTED_OMITTED_FILES)
    .map((file) => `${file.path} (+${file.addedLines} -${file.deletedLines})`)
    .join(", ");
  const overflow = partial.omittedFiles.length - MAX_LISTED_OMITTED_FILES;
  const omittedList = overflow > 0 ? `${listed}, and ${overflow} more` : listed;
  return [
    `<partial-staged-patch authoritative="true" representation="${representation}">`,
    `The complete staged diff was ${partial.originalCompactBytes.toLocaleString()} bytes and exceeded the input cap, so change bodies were omitted for ${partial.omittedFiles.length} file(s): ${omittedList}.`,
    "Every changed file remains listed in the authoritative staged manifest and statistics above. Omitted bodies are marked inline with '@@ pi-git: change bodies omitted'. Do not claim details about omitted bodies.",
    patch,
    "</partial-staged-patch>",
  ].join("\n");
}

/** Return the analysis-final specs in intent-first order. */
export function candidateForAnalysisFinal(
  request: CommitEvidenceRequest,
  analysis: DiffAnalysis,
): { withIntent: CommitEvidenceSpec; withoutIntent: CommitEvidenceSpec } {
  const finalCandidates = describeCommitEvidenceCandidates(request, analysis)
    .filter((spec) => spec.representation === "analysis-final");
  return {
    withIntent: finalCandidates[0] as CommitEvidenceSpec,
    withoutIntent: finalCandidates[1] as CommitEvidenceSpec,
  };
}
