import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";

// The static site owns the root URL so the board is reachable at
// https://<deployment>.convex.site/. Any app-owned HTTP route we add later
// lives under /api and therefore never collides with a static asset path.
const app = defineApp({ httpPrefix: "/api" });
app.use(staticHosting, { httpPrefix: "/" });

export default app;
