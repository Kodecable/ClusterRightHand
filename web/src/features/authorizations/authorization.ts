/**
 * Signing recipes of a waiting authorization, re-exported from `lib/authorization.ts` for this feature's
 * callers (the shared decision card imports the `lib/` module directly).
 */
export { grantCommand, sshKeygenRecipe } from "@/lib/authorization";
