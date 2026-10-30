"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Artifact } from "@/convex/interactive";
import { bridgeSchema, migrateValues, tableRows, validValue, type Definition, type Input as InputDefinition, type Values } from "@/lib/interactive";
import { sandboxDocument } from "@/lib/interactive-sandbox";
import { useDashboardKey } from "@/lib/session";
import { ArrowUp, CheckIcon, ChevronRight, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { RadioGroup, RadioGroupCard } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";

const same = (a: Values, b: Values) => JSON.stringify(a) === JSON.stringify(b);

function Control({ scope, input, value, onChange }: { scope: string; input: InputDefinition; value: Values[string]; onChange: (value: Values[string]) => void }) {
  const id = `interactive-${scope}-${input.id}`;
  return <label className="grid min-w-0 content-start gap-2 text-sm" htmlFor={id}>
    <span className="font-medium">{input.label}{input.kind === "number" && input.unit ? ` (${input.unit})` : ""}</span>
    {input.kind === "select" ? <Select value={String(value)} items={input.options.map((option) => ({ value: option, label: option }))} onValueChange={(next) => { if (typeof next === "string") onChange(next); }}>
      <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>{input.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
    </Select>
      : input.kind === "boolean" ? <Checkbox id={id} checked={Boolean(value)} onCheckedChange={onChange} />
      : <Input id={id} type={input.kind === "number" ? "number" : input.kind} value={String(value)}
        {...(input.kind === "number" ? { min: input.min, max: input.max, step: input.step } : { maxLength: 2000 })}
        onChange={(e) => { const next = input.kind === "number" ? e.target.valueAsNumber : e.target.value; if (validValue(input, next)) onChange(next); }} />}
  </label>;
}

function Sandbox({ artifact, values, onChange }: { artifact: Artifact; values: Values; onChange: (id: string, value: Values[string]) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [identity] = useState(() => ({ id: artifact.id, revision: artifact.revision, nonce: crypto.randomUUID().replace(/-/g, "") }));
  const [status, setStatus] = useState("Rendering");
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const [attempt, setAttempt] = useState(0);
  const [document, setDocument] = useState("");
  const report = useMutation(api.interactive.report);
  const key = useDashboardKey();
  useEffect(() => {
    if (artifact.definition.view.kind === "sandbox") setDocument(sandboxDocument(artifact.definition.view, identity, window.location.origin));
  }, [artifact.definition.view, identity, attempt]);
  const send = () => frame.current?.contentWindow?.postMessage({ ...identity, type: "perry:state", values: valuesRef.current }, "*");
  useEffect(() => {
    let received = 0;
    let windowAt = Date.now();
    const timeout = setTimeout(() => setStatus("Rendering failed"), 5000);
    const listener = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      if (Date.now() - windowAt > 1000) { windowAt = Date.now(); received = 0; }
      if (++received > 20) return;
      const message = event.data;
      if (!message || typeof message !== "object" || !("id" in message) || message.id !== identity.id || !("revision" in message) || message.revision !== identity.revision || !("nonce" in message) || message.nonce !== identity.nonce || !("type" in message)) return;
      if (message.type === "perry:mounted") send();
      else if (message.type === "perry:ready") { clearTimeout(timeout); setStatus("Ready"); void report({ key, id: artifact.id, conversationId: artifact.conversationId, event: "ready" }).catch(() => {}); }
      else if (message.type === "perry:error") { clearTimeout(timeout); setStatus("Rendering failed"); void report({ key, id: artifact.id, conversationId: artifact.conversationId, event: "error" }).catch(() => {}); }
      else {
        const parsed = bridgeSchema.safeParse(message);
        if (!parsed.success) return;
        const input = artifact.definition.inputs.find((input) => input.id === parsed.data.input);
        if (input && validValue(input, parsed.data.value)) onChange(input.id, parsed.data.value);
      }
    };
    window.addEventListener("message", listener);
    return () => { clearTimeout(timeout); window.removeEventListener("message", listener); };
  }, [identity, artifact, onChange, attempt, key, report]);
  useEffect(() => { const timer = setTimeout(send, 150); return () => clearTimeout(timer); }, [values]);
  return <div className="space-y-2">
    <p className="text-xs text-muted-foreground" role="status">{status}</p>
    {document && status !== "Rendering failed" && <iframe key={attempt} ref={frame} title={artifact.definition.title} srcDoc={document} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" className="h-96 w-full rounded-md border bg-white" />}
    {status === "Rendering failed" && <Button type="button" variant="outline" size="sm" onClick={() => { setStatus("Rendering"); setAttempt((n) => n + 1); }}>Retry rendering</Button>}
  </div>;
}

function NativeView({ definition, values }: { definition: Definition; values: Values }) {
  const rows = tableRows(definition, values);
  const columns = definition.view.kind === "calculator" ? ["Option", "Total", "Unit"] : definition.view.kind === "sandbox" || definition.view.kind === "question" ? [] : definition.view.columns;
  const filter = typeof values.filter === "string" ? values.filter.toLocaleLowerCase() : "";
  const shown = filter ? rows.filter((row) => row.some((cell) => String(cell ?? "").toLocaleLowerCase().includes(filter))) : rows;
  const max = Math.max(1, ...shown.map((row) => typeof row[1] === "number" ? Math.abs(row[1]) : 0));
  return <div className="overflow-x-auto">
    <Table><TableCaption className="sr-only">{definition.title}</TableCaption>
      <TableHeader><TableRow>{columns.map((column, i) => <TableHead className="text-xs text-muted-foreground" key={i} scope="col">{column}</TableHead>)}</TableRow></TableHeader>
      <TableBody>{shown.map((row, i) => <TableRow key={i}>{row.map((cell, j) => <TableCell className="py-2.5 tabular-nums" key={j}>{cell === null ? "Missing" : typeof cell === "number" ? cell.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(cell)}
        {definition.view.kind === "chart" && j === 1 && typeof cell === "number" && <span aria-hidden className="mt-1 block h-2 rounded bg-primary/60" style={{ width: `${Math.abs(cell) / max * 100}%` }} />}
      </TableCell>)}</TableRow>)}</TableBody>
    </Table>
    {!shown.length && <p className="py-3 text-sm text-muted-foreground">No data matches. Missing data has not been estimated.</p>}
  </div>;
}

function download(artifact: Artifact, values: Values, format: "json" | "csv") {
  const def = artifact.definition;
  const columns = def.view.kind === "calculator" ? ["Option", "Total", "Unit"] : def.view.kind === "sandbox" || def.view.kind === "question" ? [] : def.view.columns;
  const csvCell = (value: unknown) => {
    const text = String(value ?? "");
    const safe = typeof value === "string" && /^\s*[=+@-]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const content = format === "json" ? JSON.stringify({ ...artifact, values }, null, 2) : [columns, ...tableRows(def, values)].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([content], { type: format === "json" ? "application/json" : "text/csv" }));
  const link = window.document.createElement("a"); link.href = url; link.download = `interactive-${artifact.id}.${format}`; link.click(); URL.revokeObjectURL(url);
}

function Answer({ artifact }: { artifact: Artifact }) {
  const key = useDashboardKey();
  const save = useMutation(api.interactive.save);
  const followup = useMutation(api.interactive.followup);
  const answer = useMutation(api.interactive.answer);
  const report = useMutation(api.interactive.report);
  const [base, setBase] = useState(artifact);
  const [values, setValues] = useState(artifact.values);
  const [notice, setNotice] = useState("Saved draft");
  const [conflict, setConflict] = useState(false);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const saving = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const currentValues = useRef(values); currentValues.current = values;
  const dirty = !same(base.values, values);
  useEffect(() => {
    void report({ key, id: artifact.id, conversationId: artifact.conversationId, event: "restored" }).catch(() => {});
    if (artifact.definition.view.kind !== "sandbox") void report({ key, id: artifact.id, conversationId: artifact.conversationId, event: "ready" }).catch(() => {});
  }, [artifact.id, artifact.conversationId, key, report]);
  useEffect(() => {
    if (artifact.revision === base.revision || saving.current) return;
    if (dirty) { setConflict(true); setNotice("Another tab or follow-up saved a newer revision. Your inputs are preserved below."); }
    else { setBase(artifact); setValues(artifact.values); }
  }, [artifact, base.revision, dirty]);
  async function persist(operation: "save" | "reset" | "undo") {
    if (saving.current || conflict || sending || base.lifecycle === "answered") return;
    saving.current = true; setSaveBusy(true); setNotice("Saving draft…");
    const sent = values;
    try {
      const result = await save({ key, id: base.id, conversationId: base.conversationId, expectedRevision: base.revision, requestId: crypto.randomUUID(), operation, values: JSON.stringify(sent) });
      if (!result.ok) { setConflict(true); setNotice("Revision conflict. Your inputs are preserved; load the latest draft or explicitly keep yours."); }
      else { setBase(result.artifact); if (operation !== "save" || same(currentValues.current, sent)) setValues(result.artifact.values); setNotice("Saved draft"); }
    } catch (error) { setNotice(`Save failed: ${error instanceof Error ? error.message : String(error)}. Your inputs are still here.`); }
    finally { saving.current = false; setSaveBusy(false); }
  }
  useEffect(() => {
    if (!dirty || conflict || saving.current || sending || base.lifecycle === "answered") return;
    saveTimer.current = setTimeout(() => void persist("save"), 650);
    return () => clearTimeout(saveTimer.current);
  }, [values, base.revision, base.lifecycle, dirty, conflict, sending]);
  const change = useCallback((id: string, value: Values[string]) => setValues((previous) => ({ ...previous, [id]: value })), []);
  const def = base.definition;
  if (def.view.kind === "question") {
    const hasAnswer = def.inputs.some((input) => typeof values[input.id] !== "string" || String(values[input.id]).trim());
    return <article id={`interactive-${artifact.id}`} aria-label={`Question: ${def.title}`} data-interactive={artifact.id} data-revision={base.revision} className="min-w-0 space-y-4 rounded-xl border bg-card p-4 sm:p-5">
      <div><h3 className="font-semibold">{def.title}</h3><p className="mt-1 text-sm whitespace-pre-wrap text-muted-foreground">{def.summary}</p></div>
      {base.lifecycle === "answered" ? <>
        <dl className="space-y-3 text-sm">{def.inputs.filter((input) => String(values[input.id]).trim()).map((input) => <div key={input.id}><dt className="text-muted-foreground">{input.label}</dt><dd className="mt-1 whitespace-pre-wrap">{String(values[input.id])}</dd></div>)}</dl>
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><CheckIcon className="size-4" aria-hidden />Answer sent</p>
      </> : <form className="space-y-4" onSubmit={async (event) => {
        event.preventDefault();
        if (!hasAnswer || sending || saving.current || conflict) return;
        clearTimeout(saveTimer.current);
        setSending(true); setNotice("Sending answer…");
        try {
          const result = await answer({ key, id: base.id, conversationId: base.conversationId, expectedRevision: base.revision, values: JSON.stringify(values) });
          setBase(result); setValues(result.values); setNotice("Answer sent");
        } catch (error) { setNotice(`Answer failed: ${error instanceof Error ? error.message : String(error)}. Your answer is still here.`); }
        finally { setSending(false); }
      }}>
        <fieldset disabled={sending || conflict} className="grid min-w-0 gap-4 [&_[data-slot=input]]:min-h-11">
          {def.inputs.map((input) => input.kind === "select" ? <div key={input.id} className="space-y-2">
            <p id={`question-${artifact.id}-${input.id}`} className="text-sm font-medium">{input.label}</p>
            <RadioGroup aria-labelledby={`question-${artifact.id}-${input.id}`} value={String(values[input.id])} onValueChange={(value) => { if (typeof value === "string") change(input.id, value); }} className="sm:grid-cols-2">
              {input.options.map((option) => <RadioGroupCard key={option} value={option} className="min-h-11 items-center px-3 py-2 text-sm"><span>{option}</span></RadioGroupCard>)}
            </RadioGroup>
          </div> : <Control key={input.id} scope={artifact.id} input={input} value={values[input.id]} onChange={(value) => change(input.id, value)} />)}
        </fieldset>
        <p className={`text-xs ${conflict || notice.includes("failed") ? "text-destructive" : "text-muted-foreground"}`} role={conflict || notice.includes("failed") ? "alert" : "status"}>{notice}</p>
        {conflict && <Button type="button" variant="outline" size="sm" onClick={() => { setBase(artifact); setValues(artifact.values); setConflict(false); setNotice("Loaded latest question"); }}>Load latest question</Button>}
        <Button type="submit" className="min-h-11" disabled={!hasAnswer || sending || saveBusy || conflict} aria-busy={sending || undefined}>{sending && <Spinner />}{sending ? "Sending…" : "Send answer"}</Button>
      </form>}
    </article>;
  }
  return <article id={`interactive-${artifact.id}`} aria-label={`Interactive answer: ${def.title}`} data-interactive={artifact.id} data-revision={base.revision} className="min-w-0 space-y-4 rounded-xl border bg-card p-4 sm:p-5">
    <div><h3 className="font-semibold">{def.title}</h3><p className="mt-1 text-sm whitespace-pre-wrap text-muted-foreground">{def.summary}</p></div>
    <div className="grid gap-3 sm:grid-cols-2">{def.inputs.map((input) => <Control key={input.id} scope={artifact.id} input={input} value={values[input.id]} onChange={(value) => change(input.id, value)} />)}</div>
    {def.view.kind === "sandbox" ? <Sandbox key={`${base.revision}`} artifact={base} values={values} onChange={change} /> : <NativeView definition={def} values={values} />}
    <div className="space-y-2 text-xs text-muted-foreground" data-provenance>
      <p>{def.provenance.kind === "illustrative" ? "Illustrative example" : def.provenance.kind === "owner" ? "Owner-provided inputs" : "Retrieved data snapshot"} · {def.provenance.period || "Period not specified"} · {def.provenance.units || "Units not specified"}</p>
      {def.provenance.missing.map((line, i) => <p key={`m${i}`} className="text-foreground">Missing: {line}</p>)}
      <Collapsible>
        <CollapsibleTrigger render={<Button size="xs" variant="ghost" className="group -ml-2 text-muted-foreground" />}>
          <ChevronRight className="transition-transform group-data-panel-open:rotate-90" />Sources & assumptions
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-2">
          {def.provenance.sources.map((source, i) => <p key={i}>{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer" className="link">{source.label}</a> : source.label}{source.fetchedAt ? ` · fetched ${source.fetchedAt}` : ""}</p>)}
          {def.provenance.assumptions.map((line, i) => <p key={`a${i}`}>Assumption: {line}</p>)}
          <p>Inputs save as drafts. Account changes require separate approval in chat.</p>
        </CollapsibleContent>
      </Collapsible>
    </div>
    <div className="flex items-center justify-between gap-3 border-t pt-3">
      <p className={`text-xs ${conflict || notice.includes("failed") ? "text-destructive" : "text-muted-foreground"}`} role="status">{notice}</p>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${def.title}`} />}><MoreHorizontal /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem disabled={conflict || saveBusy} onClick={() => void persist("save")}>Save draft</DropdownMenuItem>
          <DropdownMenuItem disabled={conflict || saveBusy} onClick={() => void persist("reset")}>Reset</DropdownMenuItem>
          <DropdownMenuItem disabled={conflict || saveBusy || !base.canUndo} onClick={() => void persist("undo")}>Undo</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => download(base, values, "json")}>Export JSON</DropdownMenuItem>
          {def.view.kind !== "sandbox" && <DropdownMenuItem onClick={() => download(base, values, "csv")}>Export CSV</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {conflict && <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={() => { setBase(artifact); setValues(artifact.values); setConflict(false); setNotice("Loaded latest draft"); }}>Load latest draft</Button>
      <Button size="sm" variant="outline" onClick={() => { setBase(artifact); setValues(migrateValues(artifact.definition, base.definition, values)); setConflict(false); setNotice("Keeping your inputs on the latest draft"); }}>Keep my inputs</Button>
    </div>}
    <form className="flex items-center gap-2" onSubmit={async (event) => {
      event.preventDefault(); if (!question.trim() || dirty || conflict || sending) return;
      setSending(true);
      try { await followup({ key, id: base.id, conversationId: base.conversationId, expectedRevision: base.revision, requestId: crypto.randomUUID(), text: question }); setQuestion(""); setNotice("Follow-up requested in this chat"); }
      catch (error) { setNotice(`Follow-up failed: ${error instanceof Error ? error.message : String(error)}`); }
      finally { setSending(false); }
    }}>
      <Input className="min-w-0 flex-1" aria-label={`Revise ${def.title}`} placeholder="Ask Perry to revise this answer…" maxLength={1000} value={question} onChange={(e) => setQuestion(e.target.value)} />
      <Button type="submit" size="icon" aria-label="Ask Perry" disabled={dirty || conflict || saveBusy || sending || !question.trim()}><ArrowUp /></Button>
    </form>
  </article>;
}

export function InteractiveAnswers({ conversationId }: { conversationId: Id<"conversations"> }) {
  const key = useDashboardKey();
  const artifacts = useQuery(api.interactive.list, { key, conversationId });
  return artifacts?.length ? <section aria-label="Interactive answers" className="space-y-4">{artifacts.map((artifact) => <Answer key={artifact.id} artifact={artifact} />)}</section> : null;
}
