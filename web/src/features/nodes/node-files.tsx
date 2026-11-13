import { useState } from "react";
import { FileManager } from "@/components/file-manager";
import { useNodeFileSource } from "./api";

/** The node page's Files tab: the shared file manager with list, stat, download and image preview. */
export function NodeFiles({ nodeId, nodeName }: { nodeId: string; nodeName: string }) {
	const [path, setPath] = useState("");
	const source = useNodeFileSource(nodeId);
	return (
		<FileManager source={source} path={path} onPathChange={setPath} rootLabel={nodeName} testId="node-file-manager" />
	);
}
