import { exposeDeploymentQuery } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";

/**
 * Which build of the frontend this deployment is currently serving.
 *
 * The static-hosting component tracks it; re-exporting its query here is what
 * makes it reachable from the browser, so an already-open tab can notice that a
 * newer bundle has been uploaded (see `src/components/UpdateNotice.tsx`).
 *
 * The one function that takes no credentials, on purpose: it returns deployment
 * metadata rather than board data, and the update notice has to work on the login
 * screen too — a tab left open across a deploy should be told to reload whether
 * or not anyone is signed in on it.
 */
export const { getCurrentDeployment } = exposeDeploymentQuery(
  components.staticHosting,
);
