"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConvex, useMutation, useQuery } from "@/client/react";
import { BackendError, WriteOutcomeUnknownError } from "@/client/backend";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { MachineCommand } from "@/lib/machine-protocol";
import { useSession } from "@/lib/session";
import { randomUUID } from "@/lib/uuid";
import { errorText } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function useMachine(conversationId: Id<"conversations">) {
  const { dashboardKey: key } = useSession(), client = useConvex();
  const state = useQuery(api.machines.state, { key, conversationId });
  const request = useMutation(api.machines.request);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lifetime = useRef<AbortController | null>(null);
  const pending = useRef(new Map<string, string>());
  const active = useRef(0);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, [conversationId]);
  const run = useCallback(async <T,>(command: MachineCommand, runnerId?: Id<"runners">): Promise<T> => {
    const signal = lifetime.current?.signal;
    const input = JSON.stringify(command), signature = JSON.stringify([conversationId, runnerId, input]);
    const requestId = pending.current.get(signature) ?? randomUUID();
    if (!pending.current.has(signature) && pending.current.size >= 32) throw new Error("Too many computer requests are awaiting acknowledgement. Reopen the panel to inspect the current state.");
    pending.current.set(signature, requestId);
    active.current++; setBusy(true); setError("");
    try {
      const args = { key, conversationId, input, requestId, ...(runnerId ? { runnerId } : {}) };
      let id: Id<"machineRequests">;
      try {
        try { id = await request(args); }
        catch (cause) { if (!(cause instanceof WriteOutcomeUnknownError)) throw cause; id = await request(args); }
      } catch (cause) {
        if (cause instanceof BackendError && !(cause instanceof WriteOutcomeUnknownError) && cause.status < 500) pending.current.delete(signature);
        throw cause;
      }
      const end = Date.now() + 130000;
      while (!signal?.aborted && Date.now() < end) {
        const result = await client.query(api.machines.result, { key, id });
        if (result?.status === "error") { pending.current.delete(signature); throw new Error(result.error ?? "The computer request failed."); }
        if (result?.status === "done") { pending.current.delete(signature); return JSON.parse(result.result ?? "null") as T; }
        await new Promise<void>((done, fail) => {
          if (signal?.aborted) { fail(new DOMException("Panel closed.", "AbortError")); return; }
          const abort = () => { clearTimeout(timer); fail(new DOMException("Panel closed.", "AbortError")); };
          const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); done(); }, 150);
          signal?.addEventListener("abort", abort, { once: true });
        });
      }
      throw new Error(signal?.aborted ? "Panel closed. A submitted operation may still finish." : "The computer has not acknowledged this operation. Retry checks the same request.");
    } catch (cause) { if (!signal?.aborted) setError(errorText(cause)); throw cause; }
    finally { active.current--; if (!signal?.aborted) setBusy(active.current > 0); }
  }, [client, conversationId, key, request]);
  return { state, run, busy, error, setError };
}
export type Machine = ReturnType<typeof useMachine>;

export function MachineHeader({ machine, project }: { machine: Machine; project?: { id: Id<"projects">; name: string } }) {
  return <div className="shrink-0 space-y-2 border-b p-3 text-xs">
    <p>{machine.state?.runner ? `${machine.state.runner.name} · ${machine.state.runner.online ? "Connected" : "Offline"}` : "No computer connected"}</p>
    {project && <WorkspaceSettings key={project.id} machine={machine} project={project} />}
    {machine.error && <p role="alert" className="whitespace-pre-wrap text-destructive">{machine.error}</p>}
  </div>;
}
function WorkspaceSettings({ machine, project }: { machine: Machine; project: { id: Id<"projects">; name: string } }) {
  const { dashboardKey: key } = useSession();
  const cancel = useMutation(api.machines.cancelWorkspace);
  const [path, setPath] = useState(""), [branch, setBranch] = useState(`perry/${project.id.slice(-8)}`), [base, setBase] = useState("HEAD");
  const [mode, setMode] = useState<"folder" | "worktree">("folder"), [runner, setRunner] = useState("");
  const workspace = machine.state?.workspace;
  return <details className="group">
    <summary className="cursor-pointer truncate">Workspace: {workspace?.path ?? `${project.name} · isolated project folder`}</summary>
    {machine.state?.workspaceRequest && <div className="mt-2 flex items-center gap-2"><span>Configuring workspace…</span>{machine.state.workspaceRequest.status === "queued" && <Button size="sm" variant="outline" onClick={() => void cancel({ key, conversationId: machine.state!.workspaceRequest!.conversationId }).catch(cause => machine.setError(errorText(cause)))}>Cancel pending change</Button>}</div>}
    <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); void machine.run({ kind: "workspace.setup", path, mode, branch, base }, (runner || machine.state?.runner?.id) as Id<"runners">).catch(() => {}); }}>
      <p className="text-muted-foreground">Use a folder on the selected computer, or create a separate worktree from a Git repository. Finish the project's running replies first.</p>
      <label className="block space-y-1"><span>Computer</span><Select value={runner || machine.state?.runner?.id || ""} onValueChange={value => setRunner(value ?? "")}><SelectTrigger className="w-full" aria-label="Workspace computer"><SelectValue /></SelectTrigger><SelectContent>{machine.state?.runners.map(runner => <SelectItem key={runner.id} value={runner.id} disabled={!runner.online}>{runner.name}</SelectItem>)}</SelectContent></Select></label>
      <label className="block space-y-1"><span>Workspace type</span><Select value={mode} onValueChange={value => setMode(value === "worktree" ? "worktree" : "folder")}><SelectTrigger className="w-full" aria-label="Workspace type"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="folder">Existing folder</SelectItem><SelectItem value="worktree">New Git worktree</SelectItem></SelectContent></Select></label>
      <label className="block space-y-1"><span>{mode === "worktree" ? "Repository path" : "Folder path"}</span><Input value={path} required placeholder="Absolute path on this computer" onChange={event => setPath(event.target.value)} /></label>
      {mode === "worktree" && <><label className="block space-y-1"><span>New branch</span><Input required value={branch} onChange={event => setBranch(event.target.value)} /></label><label className="block space-y-1"><span>Base reference</span><Input required value={base} onChange={event => setBase(event.target.value)} /></label></>}
      <Button type="submit" size="sm" disabled={machine.busy || !machine.state?.runners.some(item => item.id === (runner || machine.state?.runner?.id) && item.online)}>{machine.busy ? "Configuring…" : mode === "worktree" ? "Create worktree" : "Use folder"}</Button>
    </form>
  </details>;
}
