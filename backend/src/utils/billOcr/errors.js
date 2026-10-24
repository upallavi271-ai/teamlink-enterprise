// A reading failure the pipeline understands. `code`: not-configured | unavailable | timeout | rate-limit | bad-output | refused | unreadable | budget.
// `message` is plain words and never holds a key or a provider internal.
class OcrError extends Error {
  constructor(message, code = 'unavailable', retryable = false) {
    super(message);
    this.name = 'OcrError';
    this.code = code;
    this.retryable = retryable;
  }
}
module.exports = { OcrError };
