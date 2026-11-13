import { useCallback, useRef, useState } from "react";
import { errorMessage } from "@/lib/api/client";

/** What one file of an upload queue is doing. */
export type UploadStatus = "pending" | "running" | "done" | "failed" | "canceled";

export interface QueuedUpload {
	/** Stable within the session; the dialog keys its failure list by it. */
	id: number;
	file: File;
	status: UploadStatus;
	/** Bytes sent so far; the file's whole size once it is done or failed. */
	loaded: number;
	/** The server's message when the file failed. */
	error?: string;
}

export interface UploadFailure {
	id: number;
	file: File;
	error: string;
}

/**
 * One file's upload, supplied by the source: report progress and honor the signal
 * (doc/design/webui.md "Shared components"). The queue owns the sequencing; the source owns the transport
 * (an XHR, so upload progress exists).
 */
export type UploadFile = (file: File, onProgress: (loaded: number) => void, signal: AbortSignal) => Promise<void>;

export interface UploadQueue {
	entries: QueuedUpload[];
	/** Files uploaded successfully. */
	done: number;
	failures: UploadFailure[];
	totalFiles: number;
	totalBytes: number;
	/** Bytes the queue has processed; a finished file counts its whole size. */
	loadedBytes: number;
	/** Bytes per second over the whole run. */
	speed: number;
	/** Seconds left at the current speed; undefined until the speed is known. */
	eta: number | undefined;
	running: boolean;
	start: (files: File[]) => void;
	cancel: () => void;
	/** Forgets the finished batch; only called once the queue is not running. */
	clear: () => void;
}

function processedBytes(entries: QueuedUpload[]): number {
	let total = 0;
	for (const entry of entries) {
		total += entry.status === "pending" || entry.status === "running" ? entry.loaded : entry.file.size;
	}
	return total;
}

/**
 * Sequential uploads for any source: the caller hands in the per-file upload, and the queue tracks the
 * byte totals, the current speed and the remaining time. A file that fails is recorded and skipped so
 * the rest continue; cancel aborts the file in flight and stops every file after it. The session
 * composer and node file management reuse the hook with their own upload and UI.
 */
export function useUploadQueue(upload: UploadFile): UploadQueue {
	const [entries, setEntries] = useState<QueuedUpload[]>([]);
	const [running, setRunning] = useState(false);
	const [speed, setSpeed] = useState(0);
	const entriesRef = useRef<QueuedUpload[]>([]);
	const controllerRef = useRef<AbortController | null>(null);
	const canceledRef = useRef(false);
	const startedAtRef = useRef(0);
	const nextIdRef = useRef(0);

	const publish = useCallback((next: QueuedUpload[]) => {
		entriesRef.current = next;
		setEntries(next);
	}, []);

	const update = useCallback(
		(index: number, patch: Partial<QueuedUpload>) => {
			publish(entriesRef.current.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)));
		},
		[publish],
	);

	const sampleSpeed = useCallback(() => {
		const elapsed = (Date.now() - startedAtRef.current) / 1000;
		setSpeed(elapsed > 0 ? processedBytes(entriesRef.current) / elapsed : 0);
	}, []);

	const run = useCallback(
		async (uploadFile: UploadFile, queue: QueuedUpload[]) => {
			for (let index = 0; index < queue.length; index++) {
				if (canceledRef.current) break;
				const entry = queue[index];
				if (entry === undefined) break;
				const controller = new AbortController();
				controllerRef.current = controller;
				update(index, { status: "running" });
				try {
					await uploadFile(
						entry.file,
						(loaded) => {
							update(index, { loaded });
							sampleSpeed();
						},
						controller.signal,
					);
					update(index, { status: "done", loaded: entry.file.size });
				} catch (err) {
					update(
						index,
						controller.signal.aborted ? { status: "canceled" } : { status: "failed", error: errorMessage(err) },
					);
				}
				sampleSpeed();
			}
			controllerRef.current = null;
			if (canceledRef.current) {
				publish(
					entriesRef.current.map((entry) =>
						entry.status === "pending" ? { ...entry, status: "canceled" as const } : entry,
					),
				);
			}
			setRunning(false);
		},
		[publish, sampleSpeed, update],
	);

	const start = useCallback(
		(files: File[]) => {
			canceledRef.current = false;
			startedAtRef.current = Date.now();
			const queue = files.map(
				(file): QueuedUpload => ({
					id: nextIdRef.current++,
					file,
					status: "pending",
					loaded: 0,
				}),
			);
			publish(queue);
			setSpeed(0);
			setRunning(true);
			void run(upload, queue);
		},
		[publish, run, upload],
	);

	const cancel = useCallback(() => {
		canceledRef.current = true;
		controllerRef.current?.abort();
	}, []);

	const clear = useCallback(() => {
		if (running) return;
		publish([]);
		setSpeed(0);
	}, [publish, running]);

	const done = entries.filter((entry) => entry.status === "done").length;
	const totalBytes = entries.reduce((total, entry) => total + entry.file.size, 0);
	const loadedBytes = processedBytes(entries);
	const eta = running && speed > 0 ? Math.max(0, (totalBytes - loadedBytes) / speed) : undefined;

	return {
		entries,
		done,
		failures: entries.flatMap((entry) =>
			entry.status === "failed" && entry.error !== undefined
				? [{ id: entry.id, file: entry.file, error: entry.error }]
				: [],
		),
		totalFiles: entries.length,
		totalBytes,
		loadedBytes,
		speed,
		eta,
		running,
		start,
		cancel,
		clear,
	};
}
