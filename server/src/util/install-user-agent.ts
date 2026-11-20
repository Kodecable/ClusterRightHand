/**
 * Imported first by main.ts so that the global fetch carries crhs's User-Agent before any other module
 * captures it (doc/design/architecture.md "Outbound requests").
 */
import { installUserAgent } from "./user-agent.ts";

installUserAgent();
