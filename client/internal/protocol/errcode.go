package protocol

// Error codes carried on the wire: the code of a command's error response (RemoteError.Code)
// and the error_code of a task that ended with an error outcome (Error.Code). See
// doc/design/protocol.md for which command and outcome uses which code. The authorization codes of
// task.start (authorization_*, already_accepted) are authz.Result values.
const (
	// Command errors.
	CodeInternalError      = "internal_error"
	CodeUnsupportedCommand = "unsupported_command"
	CodeInvalidSpec        = "invalid_spec"
	CodeUnsupportedKind    = "unsupported_kind"
	CodeUnknownTask        = "unknown_task"
	CodeAlreadyAccepted    = "already_accepted"
	CodeAlreadyDecided     = "already_decided"
	CodeLocalNotTrusted    = "local_not_trusted"

	// Privileged mode availability.
	CodePrivilegedUnsupported = "privileged_unsupported"
	CodePrivilegedUnavailable = "privileged_unavailable"
	CodeHelperLost            = "helper_lost"

	// Task input.
	CodeInputIncomplete = "input_incomplete"
	CodeInputMismatch   = "input_mismatch"
	CodeInputTooLarge   = "input_too_large"
	CodeInputOutOfOrder = "input_out_of_order"

	// Task outcomes decided by the executor.
	CodeIOError     = "io_error"
	CodeNotFound    = "not_found"
	CodeSpawnFailed = "spawn_failed"
	CodeCancelled   = "cancelled"
	CodeTimeout     = "timeout"

	// File task outcomes.
	CodePermissionDenied  = "permission_denied"
	CodeIsDirectory       = "is_directory"
	CodeNotADirectory     = "not_a_directory"
	CodeNotRegularFile    = "not_regular_file"
	CodeSymlinkNotAllowed = "symlink_not_allowed"
	CodeExists            = "exists"
	CodeTooLarge          = "too_large"
	CodeEditNoMatch       = "edit_no_match"
	CodeEditAmbiguous     = "edit_ambiguous"
	CodeEditOverlap       = "edit_overlap"
	CodeEditNoChange      = "edit_no_change"
)
