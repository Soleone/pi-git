import {
  isContextOverflow,
  isRecoverableLength,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type ModelThinkingLevel,
  type ThinkingLevel,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  cacheConfidenceFromUsage,
  MAX_ANALYSIS_BYTES,
  reduceStagedEvidence,
  type CacheConfidence,
  type CommitIntent,
  type CommitOperation,
  type DiffAnalysis,
  type DiffAnalysisArea,
  type StagedEvidence,
} from "./commit-evidence.js";
import {
  candidateForAnalysisFinal,
  materializeCandidate,
  modelContextWindow,
  planCommitEvidence,
  type CommitEvidenceCandidate,
  type CommitEvidencePlan,
  type CommitEvidenceRequest,
  type CommitEvidenceSpec,
  type CommitRepresentation,
} from "./evidence-plan.js";
import { isAbortError } from "./abort.js";
import { shortenCommitMessageSubject, validateCommitResponse, type CommitMessageValidation } from "./commit-message.js";

export interface CommitModelClient {
  complete(
    model: Model<Api>,
    context: { systemPrompt?: string; messages: Message[]; tools: [] },
    options: {
      signal?: AbortSignal;
      maxTokens: number;
      reasoning?: ThinkingLevel;
      /** API-level effort for openai-completions providers (e.g. OpenRouter reasoning-mandatory endpoints). */
      reasoningEffort?: ThinkingLevel;
    },
  ): Promise<AssistantMessage>;
}

export interface CommitGenerationRequest extends CommitEvidenceRequest {
  readonly signal?: AbortSignal | undefined;
  readonly cacheConfidence?: CacheConfidence | undefined;
  /** Session thinking level; endpoints that mandate reasoning reject requests without it. */
  readonly reasoning?: ModelThinkingLevel | undefined;
}

export interface CommitUsageDiagnostics {
  readonly input?: number | undefined;
  readonly output?: number | undefined;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly cost?: Usage["cost"] | undefined;
}

export interface CommitGenerationDiagnostics {
  readonly route: CommitRepresentation;
  readonly intentIncluded: boolean;
  readonly attempts: 1 | 2;
  readonly cacheConfidence: CacheConfidence;
  readonly candidate: Pick<CommitEvidenceSpec, "representation" | "estimatedInputTokens" | "inputBudget" | "outputReserve" | "safetyReserve" | "diffBytes" | "intentIncluded">;
  readonly usage?: CommitUsageDiagnostics | undefined;
  readonly analystUsage?: CommitUsageDiagnostics | undefined;
}

export type CommitGenerationResult =
  | {
      readonly ok: true;
      readonly message: string;
      readonly subject: string;
      readonly representation: CommitRepresentation;
      readonly analysisUsed: boolean;
      readonly intentIncluded: boolean;
      readonly attempts: 1 | 2;
      readonly diagnostics: CommitGenerationDiagnostics;
    }
  | {
      readonly ok: false;
      readonly code:
        | "context-too-small"
        | "input-too-large"
        | "provider-overflow"
        | "analysis-invalid"
        | "response-truncated"
        | "invalid-response"
        | "aborted";
      readonly reason: string;
      readonly diagnostics?: Omit<Partial<CommitGenerationDiagnostics>, "candidate"> & {
        readonly candidate?: CommitEvidenceSpec | undefined;
      };
    };

export class CommitMessageGenerator {
  constructor(private readonly client: CommitModelClient) {}

  async generate(request: CommitGenerationRequest): Promise<CommitGenerationResult> {
    const result = await this.attemptGeneration(request);
    // A provider can still refuse reduced evidence (smaller effective context
    // than the declared window). One bounded re-reduction attempt at half the
    // bytes before giving up.
    if (!result.ok && result.code !== "aborted" && request.evidence.partial) {
      const reduced = reduceStagedEvidence(request.evidence, Math.floor(request.evidence.compactBytes / 2));
      if (reduced) {
        return this.attemptGeneration({ ...request, evidence: reduced });
      }
    }
    return result;
  }

  private async attemptGeneration(request: CommitGenerationRequest): Promise<CommitGenerationResult> {
    const evidenceRequest: CommitEvidenceRequest = {
      model: request.model,
      evidence: request.evidence,
      style: request.style,
      ...(request.intent === undefined ? {} : { intent: request.intent }),
      ...(request.operation === undefined ? {} : { operation: request.operation }),
      ...(request.session === undefined ? {} : { session: request.session }),
      ...(request.cacheConfidence === undefined ? {} : { cacheConfidence: request.cacheConfidence }),
    };
    const plan = planCommitEvidence(evidenceRequest);
    if (plan.failure) {
      return {
        ok: false,
        code: plan.failure.code,
        reason: plan.failure.reason,
        ...(plan.failure.diagnostics === undefined ? {} : { diagnostics: { candidate: plan.failure.diagnostics } }),
      };
    }

    const selected = plan.selected;
    if (!selected) {
      return { ok: false, code: "input-too-large", reason: "No complete commit evidence candidate was available." };
    }

    const route = routeForCandidate(selected);
    if (route === "analyst-assisted") {
      return this.generateWithAnalyst(request, evidenceRequest, plan, selected);
    }
    return this.generateDirect(request, evidenceRequest, plan, selected);
  }

  private async generateDirect(
    request: CommitGenerationRequest,
    evidenceRequest: CommitEvidenceRequest,
    plan: CommitEvidencePlan,
    selectedSpec: CommitEvidenceSpec,
  ): Promise<CommitGenerationResult> {
    const attempted: CommitEvidenceSpec[] = [selectedSpec];
    let candidate = materializeCandidate(evidenceRequest, selectedSpec);
    let responseResult = await this.completeCandidate(request, candidate);

    const retry = findCheaperCandidate(plan.candidates, selectedSpec);
    if (
      (!responseResult.ok && responseResult.failure.code === "provider-overflow")
      || (responseResult.ok && shouldUseCheaperRetry(responseResult.response, plan.contextWindow, candidate.outputReserve))
    ) {
      if (retry) {
        attempted.push(retry);
        candidate = materializeCandidate(evidenceRequest, retry);
        responseResult = await this.completeCandidate(request, candidate);
      }
    }

    if (!responseResult.ok) return responseResult.failure;
    const response = responseResult.response;
    const attempts = attempted.length as 1 | 2;
    if (shouldUseCheaperRetry(response, plan.contextWindow, candidate.outputReserve)) {
      return this.responseFailure(response, candidate, request, attempts);
    }

    const validation = validateGeneratedResponse(response);
    if (!validation.ok) {
      return this.validationFailure(validation, response, candidate, request, attempts);
    }

    const representation = routeForCandidate(candidate);
    return {
      ok: true,
      message: validation.message,
      subject: validation.subject,
      representation,
      analysisUsed: false,
      intentIncluded: candidate.intentIncluded,
      attempts,
      diagnostics: {
        route: representation,
        intentIncluded: candidate.intentIncluded,
        attempts,
        cacheConfidence: effectiveCacheConfidence(request, response),
        candidate: candidateDiagnostics(candidate),
        usage: usageDiagnostics(response.usage),
      },
    };
  }

  private async generateWithAnalyst(
    request: CommitGenerationRequest,
    evidenceRequest: CommitEvidenceRequest,
    plan: CommitEvidencePlan,
    analystSpec: CommitEvidenceSpec,
  ): Promise<CommitGenerationResult> {
    const analystCandidate = materializeCandidate(evidenceRequest, analystSpec);
    const analystResult = await this.completeCandidate(request, analystCandidate);
    if (!analystResult.ok) return analystResult.failure;
    if (shouldUseCheaperRetry(analystResult.response, plan.contextWindow, analystCandidate.outputReserve)) {
      return this.responseFailure(analystResult.response, analystCandidate, request, 1);
    }

    const analysisResult = parseDiffAnalysisResponse(analystResult.response, request.evidence);
    if (!analysisResult.ok) {
      return {
        ok: false,
        code: "analysis-invalid",
        reason: analysisResult.reason,
        diagnostics: {
          route: "analyst-assisted",
          intentIncluded: false,
          attempts: 1,
          cacheConfidence: effectiveCacheConfidence(request, analystResult.response),
          candidate: analystCandidate,
          analystUsage: usageDiagnostics(analystResult.response.usage),
        },
      };
    }

    const finalCandidates = candidateForAnalysisFinal(evidenceRequest, analysisResult.analysis);
    const finalSpec = finalCandidates.withIntent.fits
      ? finalCandidates.withIntent
      : finalCandidates.withoutIntent.fits
        ? finalCandidates.withoutIntent
        : undefined;
    if (!finalSpec) {
      return {
        ok: false,
        code: "input-too-large",
        reason: "The validated analysis and final commit prompt do not fit the selected model. Stage a smaller change or select a larger-context model.",
        diagnostics: {
          route: "analyst-assisted",
          intentIncluded: false,
          attempts: 1,
          cacheConfidence: request.cacheConfidence ?? "unknown",
          candidate: finalCandidates.withoutIntent,
          analystUsage: usageDiagnostics(analystResult.response.usage),
        },
      };
    }

    const finalCandidate = materializeCandidate(evidenceRequest, finalSpec);
    const finalResult = await this.completeCandidate(request, finalCandidate);
    if (!finalResult.ok) return finalResult.failure;
    if (shouldUseCheaperRetry(finalResult.response, plan.contextWindow, finalCandidate.outputReserve)) {
      return this.responseFailure(finalResult.response, finalCandidate, request, 2);
    }

    const validation = validateGeneratedResponse(finalResult.response);
    if (!validation.ok) {
      return this.validationFailure(validation, finalResult.response, finalCandidate, request, 2, analystResult.response);
    }

    return {
      ok: true,
      message: validation.message,
      subject: validation.subject,
      representation: "analyst-assisted",
      analysisUsed: true,
      intentIncluded: finalCandidate.intentIncluded,
      attempts: 2,
      diagnostics: {
        route: "analyst-assisted",
        intentIncluded: finalCandidate.intentIncluded,
        attempts: 2,
        cacheConfidence: effectiveCacheConfidence(request, finalResult.response),
        candidate: candidateDiagnostics(finalCandidate),
        usage: usageDiagnostics(finalResult.response.usage),
        analystUsage: usageDiagnostics(analystResult.response.usage),
      },
    };
  }

  private async completeCandidate(
    request: CommitGenerationRequest,
    candidate: CommitEvidenceCandidate,
  ): Promise<
    | { readonly ok: true; readonly response: AssistantMessage }
    | { readonly ok: false; readonly failure: Extract<CommitGenerationResult, { ok: false }> }
  > {
    if (request.signal?.aborted) {
      return { ok: false, failure: { ok: false, code: "aborted", reason: "Commit message generation was cancelled." } };
    }
    try {
      const response = await this.client.complete(
        request.model,
        { systemPrompt: candidate.systemPrompt, messages: [...(candidate.contextMessages ?? [candidate.userMessage])], tools: [] },
        {
          maxTokens: candidate.outputReserve,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...reasoningOptions(request.reasoning),
        },
      );
      return { ok: true, response };
    } catch (error: unknown) {
      if (request.signal?.aborted || isAbortError(error)) {
        return { ok: false, failure: { ok: false, code: "aborted", reason: "Commit message generation was cancelled." } };
      }
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        failure: {
          ok: false,
          code: isOverflowError(reason) ? "provider-overflow" : "invalid-response",
          reason: `Commit message model request failed: ${reason}`,
          diagnostics: { candidate },
        },
      };
    }
  }

  private responseFailure(
    response: AssistantMessage,
    candidate: CommitEvidenceSpec,
    request: CommitGenerationRequest,
    attempts: 1 | 2,
    analystResponse?: AssistantMessage,
  ): Extract<CommitGenerationResult, { ok: false }> {
    const overflow = isContextOverflow(response, modelContextWindow(request.model) ?? 0);
    const detail = response.errorMessage
      ? ` Provider error: ${response.errorMessage.length > 400 ? `${response.errorMessage.slice(0, 400)}…` : response.errorMessage}`
      : "";
    return {
      ok: false,
      code: overflow ? "provider-overflow" : "response-truncated",
      reason: overflow
        ? `The provider reported that the commit evidence exceeded its context window. Stage a smaller change or select a larger-context model.${detail}`
        : `The commit message response was truncated before a complete message was produced.${detail}`,
      diagnostics: {
        route: routeForCandidate(candidate),
        intentIncluded: candidate.intentIncluded,
        attempts,
        cacheConfidence: effectiveCacheConfidence(request, response),
        candidate,
        usage: usageDiagnostics(response.usage),
        ...(analystResponse === undefined ? {} : { analystUsage: usageDiagnostics(analystResponse.usage) }),
      },
    };
  }

  private validationFailure(
    validation: Exclude<CommitMessageValidation, { ok: true }>,
    response: AssistantMessage,
    candidate: CommitEvidenceSpec,
    request: CommitGenerationRequest,
    attempts: 1 | 2,
    analystResponse?: AssistantMessage,
  ): Extract<CommitGenerationResult, { ok: false }> {
    return {
      ok: false,
      code: response.stopReason === "length" ? "response-truncated" : "invalid-response",
      reason: validation.reason,
      diagnostics: {
        route: routeForCandidate(candidate),
        intentIncluded: candidate.intentIncluded,
        attempts,
        cacheConfidence: effectiveCacheConfidence(request, response),
        candidate,
        usage: usageDiagnostics(response.usage),
        ...(analystResponse === undefined ? {} : { analystUsage: usageDiagnostics(analystResponse.usage) }),
      },
    };
  }
}

export async function generateCommitMessage(
  client: CommitModelClient,
  request: CommitGenerationRequest,
): Promise<CommitGenerationResult> {
  return new CommitMessageGenerator(client).generate(request);
}

function findCheaperCandidate(
  candidates: readonly CommitEvidenceSpec[],
  selected: CommitEvidenceSpec,
): CommitEvidenceSpec | undefined {
  const selectedIndex = candidates.indexOf(selected);
  return candidates.slice(selectedIndex + 1).find((candidate) =>
    candidate.fits
    && candidate.representation !== "analyst"
    && candidate.representation !== "analysis-final"
    && candidate.estimatedInputTokens < selected.estimatedInputTokens
    && (!candidate.intentIncluded || !selected.intentIncluded),
  );
}

function shouldUseCheaperRetry(response: AssistantMessage, contextWindow: number, desiredMaxOutput: number): boolean {
  return isContextOverflow(response, contextWindow) || isRecoverableLength(response, desiredMaxOutput);
}

function effectiveCacheConfidence(request: CommitGenerationRequest, response: AssistantMessage): CacheConfidence {
  const actual = cacheConfidenceFromUsage(response.usage);
  return actual === "unknown" ? request.cacheConfidence ?? "unknown" : actual;
}

function routeForCandidate(candidate: CommitEvidenceSpec): CommitRepresentation {
  if (candidate.representation === "analyst" || candidate.representation === "analysis-final") return "analyst-assisted";
  return candidate.representation;
}

function candidateDiagnostics(candidate: CommitEvidenceSpec): CommitGenerationDiagnostics["candidate"] {
  return {
    representation: candidate.representation,
    estimatedInputTokens: candidate.estimatedInputTokens,
    inputBudget: candidate.inputBudget,
    outputReserve: candidate.outputReserve,
    safetyReserve: candidate.safetyReserve,
    diffBytes: candidate.diffBytes,
    intentIncluded: candidate.intentIncluded,
  };
}

/** Positive thinking levels map to both the uniform and the openai-completions effort option. */
function reasoningOptions(level: CommitGenerationRequest["reasoning"]):
  | { reasoning?: ThinkingLevel; reasoningEffort?: ThinkingLevel }
  | {} {
  if (level === undefined || level === "off") return {};
  return { reasoning: level, reasoningEffort: level };
}

function usageDiagnostics(usage: Usage | undefined): CommitUsageDiagnostics | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  return {
    input: finiteNumber(usage.input),
    output: finiteNumber(usage.output),
    cacheRead: finiteNumber(usage.cacheRead),
    cacheWrite: finiteNumber(usage.cacheWrite),
    totalTokens: finiteNumber(usage.totalTokens),
    cost: usage.cost,
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export type ParsedDiffAnalysis =
  | { readonly ok: true; readonly analysis: DiffAnalysis }
  | { readonly ok: false; readonly reason: string };

/** Validate analyst JSON and exact manifest coverage before it reaches synthesis. */
export function parseDiffAnalysisResponse(response: AssistantMessage, evidence: StagedEvidence): ParsedDiffAnalysis {
  if (response.stopReason !== "stop") return { ok: false, reason: `Analyst stopped with ${response.stopReason}, not stop.` };
  const text = assistantText(response);
  if (text === undefined) return { ok: false, reason: "The analyst returned no plain-text JSON." };
  if (Buffer.byteLength(text, "utf8") > MAX_ANALYSIS_BYTES) return { ok: false, reason: "The analyst response exceeds the bounded analysis size." };
  if (text.includes("\0") || text.trimStart().startsWith("```") || text.trimEnd().endsWith("```")) {
    return { ok: false, reason: "The analyst response must be raw JSON without fences or NUL bytes." };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "The analyst response is not valid JSON." };
  }
  if (!isRecord(value)) return { ok: false, reason: "The analyst response must be a JSON object." };

  const keys = Object.keys(value);
  if (keys.some((key) => !["version", "coveredFileKeys", "overview", "areas", "unresolved"].includes(key))) {
    return { ok: false, reason: "The analyst response contains unknown fields." };
  }
  if (value.version !== 1) return { ok: false, reason: "The analyst response has an unsupported version." };
  if (!Array.isArray(value.coveredFileKeys) || !value.coveredFileKeys.every((key): key is string => typeof key === "string")) {
    return { ok: false, reason: "The analyst coveredFileKeys field is invalid." };
  }
  if (new Set(value.coveredFileKeys).size !== value.coveredFileKeys.length) {
    return { ok: false, reason: "The analyst coveredFileKeys field contains duplicates." };
  }
  const expectedKeys = evidence.files.map((file) => file.key);
  if (!sameStringSet(value.coveredFileKeys, expectedKeys)) {
    return { ok: false, reason: "The analyst did not cover exactly the staged manifest paths." };
  }
  if (typeof value.overview !== "string" || !value.overview.trim()) return { ok: false, reason: "The analyst overview is empty." };
  if (typeof value.areas !== "object" || !Array.isArray(value.areas)) return { ok: false, reason: "The analyst areas field is invalid." };
  if (typeof value.unresolved !== "object" || !Array.isArray(value.unresolved) || !value.unresolved.every((item): item is string => typeof item === "string")) {
    return { ok: false, reason: "The analyst unresolved field is invalid." };
  }

  const allowed = new Set(expectedKeys);
  const areas: DiffAnalysisArea[] = [];
  const areaPaths = new Set<string>();
  for (const area of value.areas) {
    if (!isRecord(area) || Object.keys(area).some((key) => !["paths", "summary"].includes(key))) {
      return { ok: false, reason: "The analyst contains an invalid area." };
    }
    if (!Array.isArray(area.paths) || !area.paths.every((path): path is string => typeof path === "string" && allowed.has(path))) {
      return { ok: false, reason: "The analyst area references an unknown manifest path." };
    }
    if (area.paths.length === 0 || typeof area.summary !== "string" || !area.summary.trim()) {
      return { ok: false, reason: "The analyst contains an empty area." };
    }
    for (const path of area.paths) {
      if (areaPaths.has(path)) return { ok: false, reason: "The analyst assigns a manifest path to more than one area." };
      areaPaths.add(path);
    }
    areas.push({ paths: [...area.paths], summary: area.summary });
  }
  if (!sameStringSet([...areaPaths], expectedKeys)) {
    return { ok: false, reason: "The analyst areas do not cover every manifest path exactly once." };
  }

  const unresolved = [...value.unresolved];
  const allText = JSON.stringify({ overview: value.overview, areas, unresolved });
  if (containsAuthorizationLanguage(allText)) {
    return { ok: false, reason: "The analyst response contains authorization or commit-message language." };
  }
  if (Buffer.byteLength(allText, "utf8") > MAX_ANALYSIS_BYTES) return { ok: false, reason: "The validated analysis exceeds the bounded size." };

  return {
    ok: true,
    analysis: {
      version: 1,
      coveredFileKeys: [...value.coveredFileKeys],
      overview: value.overview,
      areas,
      unresolved,
    },
  };
}

function validateGeneratedResponse(response: AssistantMessage): CommitMessageValidation {
  const validation = validateCommitResponse(response);
  if (validation.ok || validation.code !== "subject-too-large") return validation;

  const text = assistantText(response);
  if (text === undefined) return validation;
  const shortened = shortenCommitMessageSubject(text);
  if (shortened === text) return validation;

  // The model contract asks for this already. Keep the strict validator for
  // callers that need to inspect raw output, but make generation resilient when
  // a model ignores the byte limit.
  return validateCommitResponse({
    ...response,
    content: [{ type: "text", text: shortened }],
  });
}

function assistantText(response: AssistantMessage): string | undefined {
  const parts: string[] = [];
  for (const part of response.content) {
    if (part.type === "toolCall") return undefined;
    if (part.type === "text") parts.push(part.text);
  }
  const text = parts.join("\n").trim();
  return text || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const right = new Set(b);
  return a.every((value) => right.has(value));
}

function containsAuthorizationLanguage(value: string): boolean {
  return /\b(?:commit message|authorize|authorized|authorization|approve|approved|approving|commit this)\b/i.test(value);
}

function isOverflowError(value: string): boolean {
  return /context|prompt.{0,20}(?:too long|too large)|token.{0,20}(?:limit|length)|exceed/i.test(value);
}


export type { CommitIntent, CommitOperation, StagedEvidence };
