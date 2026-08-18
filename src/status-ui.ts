export const PI_GIT_STATUS_ID = "pi-git-quick-commit";

export type QuickCommitPhase =
  | "staging"
  | "drafting"
  | "validating"
  | "finalizing"
  | "committing";

export type CommitGenerationRoute = "context" | "compact" | "cached-session" | "analyst-assisted";

export interface StatusCallbacks {
  readonly setStatus: (value: string | undefined) => void;
  readonly notify: (message: string, level: "info" | "warning" | "error") => void;
}

const PHASE_LABELS: Record<QuickCommitPhase, string> = {
  staging: "Quick commit: staging changes",
  drafting: "Quick commit: drafting message",
  validating: "Quick commit: checking repository state",
  finalizing: "Quick commit: finalizing",
  committing: "Quick commit: committing",
};

/** Footer-only status surface for work that must not replace the main editor. */
export class QuickCommitStatus {
  private clearTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly callbacks: StatusCallbacks) {}

  route(route: CommitGenerationRoute): void {
    if (this.disposed) return;
    this.clearPendingTimer();
    const labels: Record<CommitGenerationRoute, string> = {
      context: "Quick commit: fresh diff",
      compact: "Quick commit: compact diff",
      "cached-session": "Quick commit: cached session",
      "analyst-assisted": "Quick commit: analyzing diff",
    };
    this.callbacks.setStatus(labels[route]);
  }

  phase(phase: QuickCommitPhase): void {
    if (this.disposed) return;
    this.clearPendingTimer();
    this.callbacks.setStatus(PHASE_LABELS[phase]);
  }

  checkingRepository(): void {
    if (this.disposed) return;
    this.clearPendingTimer();
    this.callbacks.setStatus("Quick commit: checking repository state");
  }

  success(subject: string): void {
    if (this.disposed) return;
    this.clearPendingTimer();
    this.callbacks.setStatus(`Quick commit:\n  ${subject}`);
    this.clearTimer = setTimeout(() => {
      this.clearTimer = undefined;
      if (!this.disposed) this.callbacks.setStatus(undefined);
    }, 4_000);
  }

  stale(): void {
    if (this.disposed) return;
    this.clearPendingTimer();
    this.callbacks.setStatus("Quick commit: stale snapshot");
  }

  failed(): void {
    if (this.disposed) return;
    this.clearPendingTimer();
    this.callbacks.setStatus("Quick commit: failed");
  }

  timedOut(): void {
    if (this.disposed) return;
    this.clearPendingTimer();
    this.callbacks.setStatus("Quick commit: timed out");
  }

  cancelled(): void {
    if (this.disposed) return;
    this.clearPendingTimer();
    this.callbacks.setStatus(undefined);
  }

  clear(): void {
    this.clearPendingTimer();
    this.callbacks.setStatus(undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearPendingTimer();
    this.callbacks.setStatus(undefined);
  }

  private clearPendingTimer(): void {
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = undefined;
    }
  }
}

export function phaseLabel(phase: QuickCommitPhase): string {
  return PHASE_LABELS[phase];
}
