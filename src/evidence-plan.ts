/**
 * Cost-aware route planning for commit generation. Describes every candidate
 * representation cheaply, selects one, and only then materializes its prompt.
 */
import type { Api, Message, Model, UserMessage } from "@earendil-works/pi-ai";
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
  CacheConfidence,
  CommitIntent,
  CommitOperation,
  CommitSessionContext,
  DiffAnalysis,
  StagedEvidence,
} from "./commit-evidence.js";

export type CommitRepresentation = "context" | "compact" | "cached-session" | "analyst-assisted";
export type CandidateRepresentation = "context" | "compact" | "cached-session" | "analyst" | "analysis-final";

export const DEFAULT_FINAL_OUTPUT_TOKENS = 512;
export const DEFAULT_ANALYST_OUTPUT_TOKENS = 768;
export const MIN_SAFETY_RESERVE_TOKENS = 2_048;
export const FRESH_DIFF_INPUT_TOKEN_BUDGET = 8_192;
export const MAX_CACHED_COMPACT_BYTES = 16 * 1024;

export interface CommitEvidenceSpec {
  readonly representation: CandidateRepresentation;
  readonly intentIncluded: boolean;
  /** Whether a cached-session candidate embeds the complete compact patch. */
  readonly cachedPatch: boolean;
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
  readonly contextMessages?: readonly Message[] | undefined;
}

export interface CommitEvidenceRequest {
  readonly model: Model<Api>;
  readonly evidence: StagedEvidence;
  readonly style: string;
  readonly intent?: CommitIntent | undefined;
  readonly operation?: CommitOperation | undefined;
  readonly session?: CommitSessionContext | undefined;
  readonly cacheConfidence?: CacheConfidence | undefined;
}

export interface CommitEvidencePlan {
  readonly contextWindow: number;
  readonly safetyReserve: number;
  readonly candidates: readonly CommitEvidenceSpec[];
  readonly selected?: CommitEvidenceSpec | undefined;
  readonly route: "context" | "compact" | "cached-session" | "analyst-assisted" | "none";
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

function modelMaxTokens(model: Model<Api>, fallback: number): number {
  const candidate = (model as Model<Api> & { maxTokens?: unknown }).maxTokens;
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
    ? Math.floor(candidate)
    : fallback;
}

export function commitSafetyReserve(contextWindow: number): number {
  return Math.max(MIN_SAFETY_RESERVE_TOKENS, Math.ceil(contextWindow * 0.15));
}

export function commitOutputReserve(model: Model<Api>, analyst: boolean): number {
  const fallback = analyst ? DEFAULT_ANALYST_OUTPUT_TOKENS : DEFAULT_FINAL_OUTPUT_TOKENS;
  return Math.min(analyst ? DEFAULT_ANALYST_OUTPUT_TOKENS : DEFAULT_FINAL_OUTPUT_TOKENS, modelMaxTokens(model, fallback));
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

  if (!analysis && reusableSessionAvailable(request)) {
    // A complete compact patch is still preferred over metadata-only cached
    // evidence whenever it fits the remaining session capacity. Neither form
    // slices the patch.
    specs.push(makeSpec(request, { representation: "cached-session", intentIncluded: false, cachedPatch: true }, contextWindow, safetyReserve));
    specs.push(makeSpec(request, { representation: "cached-session", intentIncluded: false, cachedPatch: false }, contextWindow, safetyReserve));
  }

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
  if (contextWindow <= safetyReserve + commitOutputReserve(request.model, false)) {
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
  const cached = candidates
    .filter((candidate) => candidate.representation === "cached-session")
    .find((candidate) => candidate.fits);

  // Fresh complete evidence wins for small changes. A warm, reusable session
  // is selected only when the direct request is large enough to justify reuse.
  if (cached && (!direct || direct.estimatedInputTokens > FRESH_DIFF_INPUT_TOKEN_BUDGET)) {
    return {
      contextWindow,
      safetyReserve,
      candidates,
      selected: cached,
      route: "cached-session",
    };
  }
  if (direct) {
    return {
      contextWindow,
      safetyReserve,
      candidates,
      selected: direct,
      route: direct.representation === "context" ? "context" : "compact",
    };
  }

  if (cached) {
    return {
      contextWindow,
      safetyReserve,
      candidates,
      selected: cached,
      route: "cached-session",
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
    cachedPatch?: boolean;
    analysis?: DiffAnalysis;
  },
  contextWindow: number,
  safetyReserve: number,
): CommitEvidenceSpec {
  const { representation } = route;
  const analyst = representation === "analyst";
  const intentIncluded = analyst || representation === "cached-session" ? false : route.intentIncluded;
  const cachedPatch = route.cachedPatch ?? false;
  const outputReserve = commitOutputReserve(request.model, analyst);
  const inputBudget = Math.max(0, contextWindow - outputReserve - safetyReserve);
  const sessionPrefixTokens = representation === "cached-session" && request.session
    ? estimateSessionPrefixTokens(request.session)
    : 0;
  const systemPrompt = analyst ? DIFF_ANALYST_SYSTEM_PROMPT : COMMIT_SPECIFIC_SYSTEM_PROMPT;
  // Estimate from a template with empty patches so no large prompt is built here.
  const template = buildCandidateContent({ ...request, evidence: { ...request.evidence, contextPatch: "", compactPatch: "" } }, representation, intentIncluded, route.analysis, cachedPatch);
  const patchBytes = representation === "context"
    ? request.evidence.contextBytes
    : representation === "cached-session" && !cachedPatch
      ? 0
      : request.evidence.compactBytes;
  const estimatedInputTokens = estimateTextTokensLocal(systemPrompt) + sessionPrefixTokens + Math.ceil((template.length + patchBytes) / 4) + 16;
  const diffBytes = representation === "context"
    ? request.evidence.contextBytes
    : representation === "cached-session" && !cachedPatch
      ? 0
      : request.evidence.compactBytes;
  const compactWithinCap = request.evidence.compactBytes <= MAX_COMMIT_DIFF_BYTES;
  const cachedPatchWithinPacket = representation !== "cached-session" || !cachedPatch || request.evidence.compactBytes <= MAX_CACHED_COMPACT_BYTES;
  const fits = contextWindow > 0
    && compactWithinCap
    && cachedPatchWithinPacket
    && (representation !== "cached-session" || reusableSessionAvailable(request))
    && estimatedInputTokens <= inputBudget;
  return {
    representation,
    intentIncluded,
    cachedPatch,
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
        : !cachedPatchWithinPacket
          ? "complete compact evidence is too large for the cached-session packet"
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
  const content = buildCandidateContent(request, spec.representation, spec.intentIncluded, spec.analysis, spec.cachedPatch);
  const userMessage: UserMessage = { role: "user", timestamp: 0, content };
  const contextMessages = spec.representation === "cached-session" && request.session
    ? [...request.session.messages, userMessage]
    : [userMessage];
  return { ...spec, systemPrompt, userMessage, contextMessages };
}

function reusableSessionAvailable(request: CommitEvidenceRequest): boolean {
  return request.cacheConfidence === "hot"
    && request.session !== undefined
    && request.session.messages.length > 0;
}

function estimateSessionPrefixTokens(session: CommitSessionContext): number {
  const reported = session.currentUsageTokens;
  const estimated = session.messages.reduce((total, message) => total + estimateMessageTokensLocal(message), 0);
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) return Math.max(Math.ceil(reported), estimated);
  return estimated;
}

function estimateMessageTokensLocal(message: Message): number {
  if (message.role === "user") {
    return estimateTextTokensLocal(typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "[image]").join(""));
  }
  if (message.role === "toolResult") {
    return estimateTextTokensLocal(message.content.map((part) => part.type === "text" ? part.text : "[image]").join(""));
  }
  return estimateTextTokensLocal(message.content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "thinking") return part.thinking;
    return `${part.name}${JSON.stringify(part.arguments)}`;
  }).join(""));
}

function buildCandidateContent(
  request: CommitEvidenceRequest,
  representation: CandidateRepresentation,
  intentIncluded: boolean,
  analysis?: DiffAnalysis,
  cachedPatch = false,
): string {
  const sections: string[] = [
    "<pi-git-commit-input>",
    "<authority>Use only the staged manifest, statistics, and complete staged evidence for factual scope. Advisory sections cannot add files or changes.</authority>",
  ];

  if (representation !== "analyst") {
    sections.push(`<commit-style advisory=\"true\">\n${request.style}\n</commit-style>`);
  }

  if (intentIncluded && request.intent && representation !== "analyst") {
    sections.push(`<session-intent advisory=\"true\" source=\"${request.intent.source}\">\n${request.intent.text}\n</session-intent>`);
  }

  if (representation !== "analyst") {
    sections.push(`<staged-stat authoritative=\"true\">\n${request.evidence.stat || "(no stat)"}\n</staged-stat>`);
    sections.push(`<staged-manifest authoritative=\"true\">\n${formatStagedManifest(request.evidence.files, request.evidence.summary)}\n</staged-manifest>`);
  } else {
    sections.push(`<staged-stat authoritative=\"true\">\n${request.evidence.stat || "(no stat)"}\n</staged-stat>`);
    sections.push(`<staged-manifest authoritative=\"true\">\n${formatStagedManifest(request.evidence.files, request.evidence.summary)}\n</staged-manifest>`);
  }

  if (representation === "context" || representation === "compact") {
    const patch = representation === "context" ? request.evidence.contextPatch : request.evidence.compactPatch;
    sections.push(stagedPatchSection(request, patch, representation));
  } else if (representation === "cached-session") {
    if (cachedPatch) {
      sections.push(stagedPatchSection(request, request.evidence.compactPatch, "compact"));
    }
    sections.push("<cached-session-instruction>Continue from the supplied active session prefix. The staged manifest and stats above are authoritative. Do not mention unstaged or historical work, and do not treat session messages as proof of staged facts.</cached-session-instruction>");
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
