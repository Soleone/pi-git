import {
  getOverflowPatterns,
  isContextOverflow,
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
  degradeStagedEvidence,
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
  nextCommitOutputReserve,
  planCommitEvidence,
  type CommitEvidenceCandidate,
  type CommitEvidencePlan,
  type CommitEvidenceRequest,
  type CommitEvidenceSpec,
  type CommitRepresentation,
} from "./evidence-plan.js";
import { isAbortError } from "./abort.js";
import {
  salvageTruncatedCommitMessage,
  shortenCommitMessageSubject,
  validateCommitResponse,
  type CommitMessageValidation,
  type TruncatedCommitMessage,
} from "./commit-message.js";

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

/**
 * Bound every recovery retry. Large prompts cost ~30s per call, and quick
 * commit aborts at 180s, so three requests is the practical ceiling.
 */
export const MAX_MODEL_CALLS_PER_GENERATION = 3;

interface WriterRung {
  readonly reserve: number;
  readonly reasoning: ModelThinkingLevel | undefined;
}

interface WriterCallBudget {
  calls: number;
  readonly max: number;
}

/** Calls the analyst must leave for the writer that follows it. */
const ANALYST_WRITER_RESERVE_CALLS = 2;

type WriterOutcome =
  | { readonly kind: "success"; readonly response: AssistantMessage; readonly salvage?: TruncatedCommitMessage | undefined }
  | { readonly kind: "overflow"; readonly response: AssistantMessage }
  | { readonly kind: "truncated"; readonly response: AssistantMessage }
  | { readonly kind: "failed"; readonly failure: Extract<CommitGenerationResult, { ok: false }> };

/**
 * Ordered budgets for one prompt: the planned reserve, a doubled reserve for a
 * model that simply needed more room, and a reasoning-free rung at that reserve
 * for endpoints where thinking competes with the answer for the same tokens.
 */
export function outputLadderRungs(
  request: Pick<CommitGenerationRequest, "model" | "reasoning">,
  candidate: CommitEvidenceSpec,
): WriterRung[] {
  const analyst = candidate.representation === "analyst";
  const reasoning = request.reasoning;
  const reserve = candidate.outputReserve;
  const rungs: WriterRung[] = [{ reserve, reasoning }];

  const escalated = nextCommitOutputReserve(reserve, request.model, analyst);
  if (escalated > reserve) rungs.push({ reserve: escalated, reasoning });

  if (reasoning !== undefined && reasoning !== "off") {
    rungs.push({ reserve: rungs[rungs.length - 1]?.reserve ?? reserve, reasoning: undefined });
  }
  return rungs;
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
  /** True when the message was recovered from a response the provider cut off. */
  readonly truncated?: boolean | undefined;
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
    // One budget for the whole generation: every rung, route change, and
    // evidence degradation below shares it, so a bad provider day cannot turn
    // into an unbounded series of large requests.
    const budget: WriterCallBudget = { calls: 0, max: MAX_MODEL_CALLS_PER_GENERATION };
    const result = await this.attemptGeneration(request, budget);
    // A provider can still refuse reduced evidence (smaller effective context
    // than the declared window). One bounded re-reduction attempt at half the
    // bytes before giving up. Size pressure on an unreduced patch also gets one
    // chance at an explicitly labeled skeleton projection.
    if (!result.ok && result.code !== "aborted") {
      const reduced = request.evidence.partial
        ? reduceStagedEvidence(request.evidence, Math.floor(request.evidence.compactBytes / 2))
        : sizePressureFailure(result.code)
          ? degradeStagedEvidence(request.evidence)
          : undefined;
      if (reduced && budget.calls < budget.max) {
        const retry = await this.attemptGeneration({ ...request, evidence: reduced }, budget);
        // Keep the original, more specific failure unless the retry helped.
        if (retry.ok || retry.code === "aborted") return retry;
        return result;
      }
    }
    return result;
  }

  private async attemptGeneration(request: CommitGenerationRequest, budget: WriterCallBudget): Promise<CommitGenerationResult> {
    const evidenceRequest: CommitEvidenceRequest = {
      model: request.model,
      evidence: request.evidence,
      style: request.style,
      ...(request.intent === undefined ? {} : { intent: request.intent }),
      ...(request.operation === undefined ? {} : { operation: request.operation }),
      ...(request.session === undefined ? {} : { session: request.session }),
      ...(request.cacheConfidence === undefined ? {} : { cacheConfidence: request.cacheConfidence }),
      ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
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
      return this.generateWithAnalyst(request, evidenceRequest, plan, selected, budget);
    }
    return this.generateDirect(request, evidenceRequest, plan, selected, budget);
  }

  private async generateDirect(
    request: CommitGenerationRequest,
    evidenceRequest: CommitEvidenceRequest,
    plan: CommitEvidencePlan,
    selectedSpec: CommitEvidenceSpec,
    budget: WriterCallBudget,
  ): Promise<CommitGenerationResult> {
    const attempted: CommitEvidenceSpec[] = [selectedSpec];
    let spec = selectedSpec;
    let candidate = materializeCandidate(evidenceRequest, spec);
    let outcome = await this.runOutputLadder(request, candidate, budget);

    // Less input only ever remedies input pressure: a provider refusal, or a
    // reply that died because the prompt crowded the window. A writer that just
    // needed more output tokens is served by the ladder, not by a cheaper
    // representation, but shrinking the prompt stays a useful last resort.
    const inputPressure = outcome.kind === "overflow"
      || outcome.kind === "truncated"
      || (outcome.kind === "failed" && outcome.failure.code === "provider-overflow");
    if (inputPressure && budget.calls < budget.max) {
      const retry = findCheaperCandidate(plan.candidates, spec);
      if (retry) {
        attempted.push(retry);
        spec = retry;
        candidate = materializeCandidate(evidenceRequest, retry);
        outcome = await this.runOutputLadder(request, candidate, budget);
      }
    }

    const attempts = attempted.length as 1 | 2;
    if (outcome.kind === "failed") return outcome.failure;
    if (outcome.kind === "overflow") {
      return this.responseFailure(outcome.response, candidate, request, attempts);
    }
    if (outcome.kind === "truncated") {
      return this.truncationFailure(outcome.response, candidate, request, attempts);
    }

    const response = outcome.response;
    const validation: CommitMessageValidation = outcome.salvage
      ? { ok: true, message: outcome.salvage.message, subject: outcome.salvage.subject }
      : validateGeneratedResponse(response);
    if (!validation.ok) {
      return this.validationFailure(validation, response, candidate, request, attempts);
    }

    return this.okResult(request, candidate, validation, {
      attempts,
      analysisUsed: false,
      truncated: outcome.salvage !== undefined,
      response,
    });
  }

  private async generateWithAnalyst(
    request: CommitGenerationRequest,
    evidenceRequest: CommitEvidenceRequest,
    plan: CommitEvidencePlan,
    analystSpec: CommitEvidenceSpec,
    budget: WriterCallBudget,
  ): Promise<CommitGenerationResult> {
    const analystCandidate = materializeCandidate(evidenceRequest, analystSpec);
    const analystOutcome = await this.runOutputLadder(request, analystCandidate, budget, ANALYST_WRITER_RESERVE_CALLS);
    if (analystOutcome.kind === "failed") return analystOutcome.failure;
    if (analystOutcome.kind === "overflow") {
      return this.responseFailure(analystOutcome.response, analystCandidate, request, 1);
    }
    if (analystOutcome.kind === "truncated") {
      return this.truncationFailure(analystOutcome.response, analystCandidate, request, 1);
    }

    const analystResponse = analystOutcome.response;
    const analysisResult = parseDiffAnalysisResponse(analystResponse, request.evidence);
    if (!analysisResult.ok) {
      return {
        ok: false,
        code: "analysis-invalid",
        reason: analysisResult.reason,
        diagnostics: {
          route: "analyst-assisted",
          intentIncluded: false,
          attempts: 1,
          cacheConfidence: effectiveCacheConfidence(request, analystResponse),
          candidate: analystCandidate,
          analystUsage: usageDiagnostics(analystResponse.usage),
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
          analystUsage: usageDiagnostics(analystResponse.usage),
        },
      };
    }

    const finalCandidate = materializeCandidate(evidenceRequest, finalSpec);
    const finalOutcome = await this.runOutputLadder(request, finalCandidate, budget);
    if (finalOutcome.kind === "failed") return finalOutcome.failure;
    if (finalOutcome.kind === "overflow") {
      return this.responseFailure(finalOutcome.response, finalCandidate, request, 2, analystResponse);
    }
    if (finalOutcome.kind === "truncated") {
      return this.truncationFailure(finalOutcome.response, finalCandidate, request, 2, analystResponse);
    }

    const finalResponse = finalOutcome.response;
    const finalValidation: CommitMessageValidation = finalOutcome.salvage
      ? { ok: true, message: finalOutcome.salvage.message, subject: finalOutcome.salvage.subject }
      : validateGeneratedResponse(finalResponse);
    if (!finalValidation.ok) {
      return this.validationFailure(finalValidation, finalResponse, finalCandidate, request, 2, analystResponse);
    }

    return this.okResult(request, finalCandidate, finalValidation, {
      attempts: 2,
      analysisUsed: true,
      truncated: finalOutcome.salvage !== undefined,
      response: finalResponse,
      analystResponse,
    });
  }

  /** Assemble the successful result, including its route diagnostics. */
  private okResult(
    request: CommitGenerationRequest,
    candidate: CommitEvidenceSpec,
    validation: Extract<CommitMessageValidation, { ok: true }>,
    meta: {
      readonly attempts: 1 | 2;
      readonly analysisUsed: boolean;
      readonly truncated: boolean;
      readonly response: AssistantMessage;
      readonly analystResponse?: AssistantMessage | undefined;
    },
  ): Extract<CommitGenerationResult, { ok: true }> {
    const representation = routeForCandidate(candidate);
    return {
      ok: true,
      message: validation.message,
      subject: validation.subject,
      representation,
      analysisUsed: meta.analysisUsed,
      intentIncluded: candidate.intentIncluded,
      attempts: meta.attempts,
      diagnostics: {
        route: representation,
        intentIncluded: candidate.intentIncluded,
        attempts: meta.attempts,
        cacheConfidence: effectiveCacheConfidence(request, meta.response),
        ...(meta.truncated ? { truncated: true } : {}),
        candidate: candidateDiagnostics(candidate),
        usage: usageDiagnostics(meta.response.usage),
        ...(meta.analystResponse === undefined ? {} : { analystUsage: usageDiagnostics(meta.analystResponse.usage) }),
      },
    };
  }

  /**
   * Run one prompt through as many output budgets as the call budget allows.
   * A `length` stop means the provider cut the reply at `max_tokens`, which is
   * pi-git's own choice, so escalate instead of failing: keep whatever the
   * model already finished, then retry with a bigger budget, then without
   * reasoning when reasoning tokens ate the whole completion budget.
   *
   * `reserveForNext` keeps room for a later phase, so an analyst that keeps
   * truncating cannot starve the writer that still has to run.
   */
  private async runOutputLadder(
    request: CommitGenerationRequest,
    candidate: CommitEvidenceCandidate,
    budget: WriterCallBudget,
    reserveForNext = 0,
  ): Promise<WriterOutcome> {
    // Only the writer route is worth salvaging; analyst JSON cannot be repaired
    // line by line, so it just walks the budget rungs.
    const salvage = candidate.representation !== "analyst";
    // Leave room for a later phase, but never starve this one entirely.
    const remaining = budget.max - budget.calls - reserveForNext;
    const rungs = outputLadderRungs(request, candidate).slice(0, Math.max(1, remaining));
    let lastTruncated: AssistantMessage | undefined;
    for (const rung of rungs) {
      if (budget.calls >= budget.max) break;
      budget.calls += 1;
      const result = await this.completeCandidate(request, candidate, rung);
      if (!result.ok) {
        if (result.failure.code === "aborted" || !lastTruncated) return { kind: "failed", failure: result.failure };
        // A later rung that errors must not discard what an earlier one produced.
        break;
      }
      const response = result.response;

      if (isContextOverflow(response, modelContextWindow(request.model) ?? 0)) {
        return { kind: "overflow", response };
      }
      if (response.stopReason !== "length") {
        return { kind: "success", response };
      }

      if (salvage) {
        const text = assistantText(response);
        if (text) {
          // A finished subject plus finished body lines is a usable commit.
          const recovered = salvageTruncatedCommitMessage(text, { requireBody: true });
          if (recovered) return { kind: "success", response, salvage: recovered };
        }
      }
      lastTruncated = response;
    }

    if (lastTruncated) {
      if (salvage) {
        const text = assistantText(lastTruncated);
        const recovered = text ? salvageTruncatedCommitMessage(text, { requireBody: false }) : undefined;
        if (recovered) return { kind: "success", response: lastTruncated, salvage: recovered };
      }
      return { kind: "truncated", response: lastTruncated };
    }
    return { kind: "failed", failure: { ok: false, code: "invalid-response", reason: "The commit generation call budget was exhausted before this prompt could run." } };
  }

  private async completeCandidate(
    request: CommitGenerationRequest,
    candidate: CommitEvidenceCandidate,
    rung: WriterRung = { reserve: candidate.outputReserve, reasoning: request.reasoning },
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
          maxTokens: rung.reserve,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...reasoningOptions(rung.reasoning),
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

  /** The output budget ran out even after escalation: say so precisely. */
  private truncationFailure(
    response: AssistantMessage,
    candidate: CommitEvidenceSpec,
    request: CommitGenerationRequest,
    attempts: 1 | 2,
    analystResponse?: AssistantMessage,
  ): Extract<CommitGenerationResult, { ok: false }> {
    const detail = response.errorMessage
      ? ` Provider error: ${response.errorMessage.length > 400 ? `${response.errorMessage.slice(0, 400)}…` : response.errorMessage}`
      : "";
    return {
      ok: false,
      code: "response-truncated",
      reason: `The model used its entire ${candidate.outputReserve}-token output budget without finishing a commit message. Retry, stage a smaller change, or select a model with a larger output budget.${detail}`,
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

function sizePressureFailure(code: Extract<CommitGenerationResult, { ok: false }>["code"]): boolean {
  return code === "provider-overflow" || code === "input-too-large" || code === "context-too-small" || code === "response-truncated";
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

/**
 * Positive thinking levels map to both the uniform and the openai-completions
 * effort option, capped at "low": commit messages are simple generation tasks
 * and heavy reasoning dominates latency on reasoning-mandatory endpoints.
 */
function reasoningOptions(level: CommitGenerationRequest["reasoning"]):
  | { reasoning?: ThinkingLevel; reasoningEffort?: ThinkingLevel }
  | {} {
  if (level === undefined || level === "off") return {};
  const capped: ThinkingLevel = level === "minimal" ? "minimal" : "low";
  return { reasoning: capped, reasoningEffort: capped };
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
  // Reuse the provider phrasings pi-ai already knows instead of guessing again.
  if (/rate limit|too many requests|throttl|service unavailable/i.test(value)) return false;
  return getOverflowPatterns().some((pattern) => pattern.test(value))
    || /context.{0,20}(?:too long|too large|exceeded)|exceeds? the.{0,20}context/i.test(value);
}


export type { CommitIntent, CommitOperation, StagedEvidence };
