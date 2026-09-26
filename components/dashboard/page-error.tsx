"use client";

import { catchError, type ErrorInfo } from "next/error";
import { TriangleAlertIcon } from "lucide-react";
import { errorText } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { TopBar } from "./common";

/**
 * A query that fails throws while rendering. The usual cause is a key that no
 * longer matches, so that case offers to lock; otherwise the rest of the
 * dashboard keeps working around the page that failed.
 */
function PageErrorFallback({ onLock }: { onLock: () => void }, { error, reset }: ErrorInfo) {
  const message = errorText(error);
  const keyProblem = /dashboard key|DASHBOARD_KEY/i.test(message);
  const stale = /No (public )?(function|query|mutation|action) named/i.test(message);
  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-xl px-6 py-16" role="alert">
        <TriangleAlertIcon className="size-6 text-destructive" aria-hidden />
        <h1 className="mt-4 text-xl font-semibold tracking-tight">{keyProblem ? "That key was rejected" : "This page couldn't load"}</h1>
        <p className="mt-2 text-[15px] text-pretty text-muted-foreground">
          {keyProblem
            ? "The dashboard key in this browser doesn't match this Perry any more. Unlock again with the current key."
            : stale
              ? "Perry's server is running older code than this page. Restart Perry with perry update, then reload."
              : "Perry's server returned an error. Everything else still works."}
        </p>
        {!keyProblem && <pre className="mt-4 max-h-48 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">{message.slice(0, 1200)}</pre>}
        <div className="mt-6 flex gap-2">
          {keyProblem
            ? <Button onClick={onLock}>Unlock again</Button>
            : <Button onClick={() => reset()}>Try again</Button>}
          <Button variant="outline" onClick={() => window.location.reload()}>Reload</Button>
        </div>
      </main>
    </>
  );
}

export const PageErrorBoundary = catchError(PageErrorFallback);
