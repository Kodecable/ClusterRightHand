/**
 * Terminals (doc/design/pty.md): the wire types of the terminal routes and WebSocket.
 *
 * A terminal is a long-lived interactive shell on a crha node, reached through crhs. It is memory-only
 * on both sides; only its audit events are stored.
 */

import type { z } from "zod";
import type {
	PtyApprovalItemSchema,
	PtyApprovalSchema,
	PtyAuthorizationResponseSchema,
	PtyCreateBodySchema,
	PtyListResponseSchema,
	PtyResizeBodySchema,
	PtySizeSchema,
	PtyStateSchema,
	PtyViewerSchema,
	PtyViewSchema,
} from "./schemas/pty.ts";

export type PtySize = z.infer<typeof PtySizeSchema>;
export type PtyState = z.infer<typeof PtyStateSchema>;
export type PtyViewer = z.infer<typeof PtyViewerSchema>;
export type PtyApproval = z.infer<typeof PtyApprovalSchema>;
export type PtyApprovalItem = z.infer<typeof PtyApprovalItemSchema>;
export type PtyView = z.infer<typeof PtyViewSchema>;
export type PtyListResponse = z.infer<typeof PtyListResponseSchema>;
export type PtyCreateBody = z.infer<typeof PtyCreateBodySchema>;
export type PtyResizeBody = z.infer<typeof PtyResizeBodySchema>;
export type PtyAuthorizationResponse = z.infer<typeof PtyAuthorizationResponseSchema>;

/**
 * The JSON text frames of `GET /api/ptys/:id/attach`, server to client. The first frame is always
 * `snapshot`; binary frames are terminal output bytes. `state` carries the changes a viewer must
 * apply: the size after any resize and the current viewer list.
 */
export type PtyAttachServerFrame =
	| { type: "snapshot"; data: string; rows: number; cols: number }
	| { type: "state"; rows: number; cols: number; title: string; viewers: PtyViewer[]; state: PtyState }
	| { type: "exited"; exitCode: number; reason: "exited" | "helper_lost" }
	| { type: "closed"; reason: string }
	| { type: "error"; message: string };

/** The JSON text frames a viewer sends; binary frames are input bytes. */
export type PtyAttachClientFrame = { type: "resize"; rows: number; cols: number };
