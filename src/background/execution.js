import { LIMITS } from '../shared/constants.js';
import { ApiError, toPlainError } from '../shared/logger.js';
import { classifyDiagnosticError } from '../shared/diagnostics.js';

/** One budget spans retries, splits and protocol fallbacks of a logical batch. */
export function createExecution(signal, runtime, usage = { input: 0, output: 0 }) {
  let knownUsage = false;
  let unknownUsage = false;
  let observedResponses = 0;
  let failure = null;
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(LIMITS.BATCH_DEADLINE_MS)]);
  return {
    signal: boundedSignal,
    get cancelled() { return signal.aborted; },
    attempt(depth = 0, reason = 'initial', retryError = null) {
      boundedSignal.throwIfAborted();
      if (runtime.translateRequestCount >= LIMITS.BATCH_MAX_ATTEMPTS) {
        throw new ApiError('本批请求预算已用尽', { status: 0 });
      }
      runtime.translateRequestCount++;
      if (depth) runtime.splitRetryCount++;
      // Count actual dispatches only: cancelling a backoff adds no phantom retry.
      const cause = retryError && reason !== 'json-format-fallback'
        ? `retry:${classifyDiagnosticError(retryError.message, retryError.status)}` : reason;
      runtime.requestReasons ||= {};
      runtime.requestReasons[cause] = (runtime.requestReasons[cause] || 0) + 1;
    },
    observeUsage(value) {
      observedResponses++;
      if (!value) { unknownUsage = true; return; }
      knownUsage = true;
      const input = Number(value.prompt_tokens ?? value.input_tokens);
      const output = Number(value.completion_tokens ?? value.output_tokens);
      if (!Number.isFinite(input) || !Number.isFinite(output)) unknownUsage = true;
      usage.input += Number.isFinite(input) ? Math.max(0, input) : 0;
      usage.output += Number.isFinite(output) ? Math.max(0, output) : 0;
    },
    fail(error) { failure ||= toPlainError(error); },
    get failure() { return failure; },
    get usage() { return knownUsage ? { ...usage } : null; },
    get usageIncomplete() { return unknownUsage || observedResponses < runtime.translateRequestCount; }
  };
}
