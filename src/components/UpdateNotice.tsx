import { useDeploymentUpdates } from "@convex-dev/static-hosting/react";
import { RefreshCw, X } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { api } from "../../convex/_generated/api";

/**
 * Tells the reader when a newer build of the board has been deployed.
 *
 * The board is a page people leave open all week, so without this they keep
 * looking at whichever bundle they loaded on Monday. `useDeploymentUpdates`
 * subscribes to the static-hosting component's deployment record through
 * `staticHosting:getCurrentDeployment`; it remembers the id seen on first paint
 * and only reports an update once that id changes, so a fresh load is never
 * announced as an update.
 *
 * Rolled by hand rather than using the component's `UpdateBanner`: that one
 * carries its own inline styles and English copy. This one looks like the rest
 * of the board and floats over the top of the matrix — positioned against
 * `<main>`, so it needs no knowledge of the header's height, and it stays clear
 * of the drag staging tray at the bottom of the viewport.
 */
export function UpdateNotice() {
  const { updateAvailable, reload, dismiss, setupError } = useDeploymentUpdates(
    api.staticHosting.getCurrentDeployment,
  );

  // Only happens when the query is missing from the deployment, i.e. the backend
  // was not pushed. Silence would leave the board quietly never updating.
  useEffect(() => {
    if (setupError) console.warn(setupError);
  }, [setupError]);

  if (!updateAvailable) return null;

  return (
    <div
      role="status"
      className="absolute top-7 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-indigo-200 bg-white/95 py-2 pr-2 pl-4 shadow-lg backdrop-blur"
    >
      <span className="text-xs font-semibold text-slate-700">
        看板有新版本
      </span>
      <Button
        size="sm"
        onClick={reload}
        className="h-7 gap-1.5 rounded-full bg-indigo-600 px-3 text-xs hover:bg-indigo-700"
      >
        <RefreshCw className="size-3" aria-hidden />
        重新載入
      </Button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="關閉這個提示"
        title="關閉這個提示"
        className="rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
