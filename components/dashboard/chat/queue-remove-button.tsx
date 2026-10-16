"use client";

import { useState } from "react";
import { XIcon } from "lucide-react";
import { useMutation } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useSession } from "@/lib/session";
import { errorText } from "@/lib/format";
import { Button } from "@/components/ui/button";

export type QueuedMessage = { id: Id<"codexTurns">; conversationId: Id<"conversations"> };

/** Always visible, keyboard reachable, with local feedback for a lost claim race. */
export function QueueRemoveButton({ queued }: { queued: QueuedMessage }) {
  const { dashboardKey } = useSession();
  const remove = useMutation(api.queue.remove);
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState("");
  async function removeMessage() {
    setRemoving(true);
    setNotice("");
    try {
      if (!await remove({ key: dashboardKey, ...queued })) setNotice("This message has already started or left the queue.");
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setRemoving(false);
    }
  }
  return (
    <div className="mt-1 flex flex-col items-end gap-1" data-queue-message={queued.id}>
      <Button type="button" variant="ghost" size="sm" className="min-h-11 gap-1 text-muted-foreground" disabled={removing}
        aria-label="Remove this queued message" onClick={() => void removeMessage()}>
        <XIcon aria-hidden="true" />{removing ? "Removing…" : "Remove from queue"}
      </Button>
      {notice && <p role="status" className="max-w-80 text-sm text-muted-foreground">{notice}</p>}
    </div>
  );
}
