export const CODES = Object.freeze({
  BROWSER_UNAVAILABLE: "EGO_BROWSER_UNAVAILABLE",
  CDP_CHANNEL_UNAVAILABLE: "EGO_CDP_CHANNEL_UNAVAILABLE",
  CDP_SEND_FAILED: "EGO_CDP_SEND_FAILED",
  INVALID_ARGUMENT: "EGO_INVALID_ARGUMENT",
  INVALID_RESULT_PAYLOAD: "EGO_INVALID_RESULT_PAYLOAD",
  OPERATION_FAILED: "EGO_OPERATION_FAILED",
  PROFILE_NOT_FOUND: "EGO_PROFILE_NOT_FOUND",
  RESULT_CONVERSION_FAILED: "EGO_RESULT_CONVERSION_FAILED",
  SNAPSHOT_FAILED: "EGO_SNAPSHOT_FAILED",
  TASK_HOST_DISCONNECTED: "EGO_TASK_HOST_DISCONNECTED",
  TASK_SPACE_INACTIVE: "EGO_TASK_SPACE_INACTIVE",
  TASK_SPACE_NOT_FOUND: "EGO_TASK_SPACE_NOT_FOUND",
  TASK_SPACE_NOT_SELECTED: "EGO_TASK_SPACE_NOT_SELECTED",
  TASK_SPACE_UNAVAILABLE: "EGO_TASK_SPACE_UNAVAILABLE",
  TASK_SPACE_USER_IN_CONTROL: "EGO_TASK_SPACE_USER_IN_CONTROL",
  TASK_SPACE_NAME_IN_USE: "EGO_TASK_SPACE_NAME_IN_USE",
  WEB_CONTENTS_UNAVAILABLE: "EGO_WEB_CONTENTS_UNAVAILABLE",
});

/** Error carried across the daemon socket as `{ error, error_code }`. */
export class EgoError extends Error {
  constructor(message, errorCode = CODES.OPERATION_FAILED) {
    super(message);
    this.error_code = errorCode;
  }

  toResult() {
    return { error: this.message, error_code: this.error_code };
  }
}

export function toErrorResult(error) {
  if (error instanceof EgoError) return error.toResult();
  return {
    error: error?.message || String(error),
    error_code: error?.error_code || CODES.OPERATION_FAILED,
  };
}
