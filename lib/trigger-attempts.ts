// Single source of truth for the Trigger.dev retry ceiling, shared by
// trigger.config.ts and every task wrapper. Tasks need it to tell a
// retryable attempt from the last one: a NON-final attempt's failure puts
// the lifecycle row back in its queue state (pending/uploaded) instead of
// "failed", because Trigger is about to run the next attempt — surfacing
// "failed" between attempts showed users a terminal error for work that
// succeeded seconds later (staging 2026-08-25, extract attempt 1 schema
// miss → attempt 2 clean). Only the final attempt's failure is real.
export const TASK_MAX_ATTEMPTS = 3;

export function isFinalAttempt(attemptNumber: number): boolean {
  return attemptNumber >= TASK_MAX_ATTEMPTS;
}
