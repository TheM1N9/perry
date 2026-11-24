"use client";

import { useEffect, useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import type { GitStatus } from "@/lib/machine-protocol";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MachineHeader, useMachine } from "./machine";

export function GitSurface({ conversationId, project }: { conversationId: Id<"conversations">; project?: { id: Id<"projects">; name: string } }) {
  const machine = useMachine(conversationId);
  const [status, setStatus] = useState<GitStatus>(), [diff, setDiff] = useState("");
  const [selection, setSelection] = useState<{ path: string; staged: boolean }>(), [message, setMessage] = useState("");
  const refresh = () => machine.run<GitStatus>({ kind: "git.status" }).then(setStatus);
  useEffect(() => { setStatus(undefined); setSelection(undefined); setDiff(""); }, [machine.state?.runner?.id, machine.state?.workspace?.path]);
  return <section className="flex min-h-0 flex-1 flex-col" data-surface="git" aria-label="Git review">
    <MachineHeader machine={machine} project={project} />
    <div className="flex shrink-0 items-center gap-2 border-b p-3 text-sm"><span className="min-w-0 flex-1 truncate">{status?.branch ?? "Review changes"}</span><Button variant="outline" size="sm" disabled={machine.busy || !machine.state?.runner?.online} onClick={() => void refresh().catch(() => {})}>{machine.busy ? "Working…" : "Refresh"}</Button></div>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
      {!status && <p className="text-sm text-muted-foreground">Refresh to inspect this workspace's repository. Use Workspace above to bind a folder or create a worktree.</p>}
      {status && <><p className="break-all font-mono text-xs text-muted-foreground">{status.root}</p>
        {!status.files.length && <p className="text-sm text-muted-foreground">Working tree clean.</p>}
        <ul className="space-y-1" aria-label="Changed files">{status.files.map(file => <li key={file.path} className="flex items-center gap-1 rounded border p-2 text-xs">
          <span className="shrink-0 font-mono">{file.index}{file.working}</span><span className="min-w-0 flex-1 break-all">{file.path}</span>
          <Button size="xs" variant="ghost" disabled={machine.busy} onClick={() => { const staged = file.index !== " " && file.index !== "?"; setSelection({ path: file.path, staged }); void machine.run<{ diff: string }>({ kind: "git.diff", file: file.path, staged }).then(result => setDiff(result.diff)).catch(() => {}); }}>Diff</Button>
          {file.working !== " " && <Button size="xs" variant="outline" disabled={machine.busy} onClick={() => void machine.run({ kind: "git.stage", files: [file.path] }).then(refresh).catch(() => {})}>Stage</Button>}
          {file.index !== " " && file.index !== "?" && <Button size="xs" variant="ghost" disabled={machine.busy} onClick={() => void machine.run({ kind: "git.unstage", files: [file.path] }).then(refresh).catch(() => {})}>Unstage</Button>}
        </li>)}</ul>
        {selection && <div className="space-y-2"><div className="flex flex-wrap items-center gap-2 text-xs"><span className="min-w-0 flex-1 break-all">{selection.path}</span><Button size="xs" variant="outline" disabled={machine.busy} onClick={() => { const staged = !selection.staged; setSelection({ ...selection, staged }); void machine.run<{ diff: string }>({ kind: "git.diff", file: selection.path, staged }).then(result => setDiff(result.diff)).catch(() => {}); }}>{selection.staged ? "Show unstaged" : "Show staged"}</Button></div><pre className="max-h-96 overflow-auto rounded bg-muted p-3 font-mono text-xs" aria-label="File diff">{diff}</pre></div>}
        <form className="space-y-2 border-t pt-3" onSubmit={event => { event.preventDefault(); void machine.run({ kind: "git.commit", message }).then(() => { setMessage(""); setDiff(""); setSelection(undefined); return refresh(); }).catch(() => {}); }}>
          <label htmlFor={`commit-${conversationId}`} className="text-sm font-medium">Commit staged changes</label><Textarea id={`commit-${conversationId}`} rows={3} maxLength={8000} required value={message} onChange={event => setMessage(event.target.value)} placeholder="Describe the change" />
          <Button type="submit" size="sm" disabled={machine.busy || !message.trim() || !status.files.some(file => file.index !== " " && file.index !== "?")}>Commit</Button>
        </form>
      </>}
    </div>
  </section>;
}
