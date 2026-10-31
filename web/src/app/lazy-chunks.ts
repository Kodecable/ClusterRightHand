/**
 * The lazy route chunks that the startup path may prefetch, shared with the
 * router so a path change is made once. Importing this module has no side
 * effects; the dynamic `import()` calls are cached by the module map, so the
 * router's `lazyRouteComponent` and the startup prefetch share a request.
 */
export const sessionsLayoutChunk = () => import("@/features/sessions/sessions-layout");
export const sessionsIndexPageChunk = () => import("@/features/sessions/sessions-index-page");
export const sessionPageChunk = () => import("@/features/sessions/pages");
