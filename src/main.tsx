import { getConvexUrl } from "@convex-dev/static-hosting";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/inter";
import App from "./App";
import "./index.css";

// When the build is served from Convex static hosting the deployment URL can be
// derived from the .convex.site hostname, so a missing env var is not fatal.
const convex = new ConvexReactClient(
  import.meta.env.VITE_CONVEX_URL ?? getConvexUrl(),
);

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root container");

createRoot(container).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);
