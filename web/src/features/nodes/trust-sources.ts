import { useMemo } from "react";
import { useCredentials } from "@/features/credentials/api";
import { useCrhsKey } from "./api";
import type { TrustKeySource } from "./trust-editor";

/** Sources the trust editor can build a snippet for: crhs's key and the user's own credentials. */
export function useTrustSources(): TrustKeySource[] {
	const crhsKey = useCrhsKey();
	const credentials = useCredentials();
	return useMemo(() => {
		const sources: TrustKeySource[] = [];
		if (crhsKey.data) sources.push({ kind: "crhs", authorizedKey: crhsKey.data.authorizedKey });
		for (const credential of credentials.data ?? []) {
			if (credential.kind === "ssh") {
				sources.push({ kind: "ssh", name: credential.name, publicKey: credential.publicKey });
			} else {
				sources.push({
					kind: "webauthn",
					name: credential.name,
					rpId: credential.rpId ?? "",
					origins: credential.origins,
					credentialId: credential.credentialId ?? "",
					publicKey: credential.publicKey,
				});
			}
		}
		return sources;
	}, [crhsKey.data, credentials.data]);
}
