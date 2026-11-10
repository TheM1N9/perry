import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { turnErrorCopy, type TurnFailure } from "@/lib/turn-errors";

/** Used inside the chat's client boundary. Retry is supplied for this turn's
 * saved user message; it must never silently target a newer message.
 */
export function TurnError({ errorCode, error, onRetry, busy = false }: TurnFailure & {
  onRetry?: () => void;
  busy?: boolean;
}) {
  const copy = turnErrorCopy(errorCode);
  return (
    <Alert variant="destructive" data-turn-error-code={errorCode ?? "engine_failed"}>
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription className="min-w-0">
        <p>{copy.guidance}</p>
        {error && <details className="mt-2">
          <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2">Details</summary>
          <p className="mt-2 whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]">{error.slice(0, 2000)}</p>
        </details>}
        {onRetry && <Button className="mt-3 min-h-11" size="sm" variant="outline" disabled={busy} onClick={onRetry}>
          <RefreshCwIcon aria-hidden="true" />Try again
        </Button>}
      </AlertDescription>
    </Alert>
  );
}
