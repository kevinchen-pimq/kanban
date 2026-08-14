import { exposeDeploymentQuery } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";

/**
 * Which build of the frontend this deployment is currently serving.
 *
 * The static-hosting component tracks it; re-exporting its query here is what
 * makes it reachable from the browser, so an already-open tab can notice that a
 * newer bundle has been uploaded (see `src/components/UpdateNotice.tsx`).
 *
 * A public query, not a write: it only reads the component's own deployment
 * record, so the board still has exactly one public mutation.
 */
export const { getCurrentDeployment } = exposeDeploymentQuery(
  components.staticHosting,
);
