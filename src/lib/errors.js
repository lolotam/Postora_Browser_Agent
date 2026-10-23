// The answer to a request that failed. The message is the worker's own words;
// the code is the stable name of the problem, which the panel translates.

/** The failed answer of a request: the message and the code the panel reads. */
export function errorResponse(err) {
  return {
    ok: false,
    error: err?.message ?? String(err ?? 'Unknown error'),
    code: typeof err?.code === 'string' ? err.code : '',
  };
}
