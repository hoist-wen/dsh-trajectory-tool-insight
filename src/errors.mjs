/**
 * One diagnosable failure raised by this plugin's own layers.
 *
 * The RPC handler turns it into a `ConnectionRpcFailure` carrying `code`, so
 * the browser can distinguish "no model configured" from "the model failed"
 * without parsing an English message.
 */
export class ToolInsightError extends Error {
  /**
   * @param code - stable machine-readable failure code.
   * @param message - human-readable explanation.
   * @param details - extra JSON-safe context for the caller.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ToolInsightError'
    this.code = code
    this.details = details
  }
}
