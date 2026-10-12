"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Artifact } from "@/convex/interactive";
import { bridgeSchema, migrateValues, tableRows, validValue, type Definition, type Input, type Values } from "@/lib/interactive";
import { sandboxDocument } from "@/lib/interactive-sandbox";
import { useDashboardKey } from "@/lib/session";
import { Button } from "@/components/ui/button";

const same = (a: Values, b: Values) => JSON.stringify(a) === JSON.stringify(b);
const fieldClass = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";

function Control({ scope, input, value, onChange }: { scope: string; input: Input; value: Values[string]; onChange: (value: Values[string]) => void }) {
  const id = `interactive-${scope}-${input.id}`;
  return <label className="grid min-w-0 gap-1 text-sm" htmlFor={id}>
    <span>{input.label}{input.kind === "number" && input.unit ? ` (${input.unit})` : ""}</span>
    {input.kind === "select" ? <select id={id} className={fieldClass} value={String(value)} onChange={(e) => onChange(e.target.value)}>{input.options.map((option) => <option key={option}>{option}</option>)}</select>
      : input.kind === "boolean" ? <input id={id} className="size-5" type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
      : <input id={id} className={fieldClass} type={input.kind === "number" ? "number" : input.kind} value={String(value)}
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
  const columns = definition.view.kind === "calculator" ? ["Option", "Total", "Unit"] : definition.view.kind === "sandbox" ? [] : definition.view.columns;
  const filter = typeof values.filter === "string" ? values.filter.toLocaleLowerCase() : "";
  const shown = filter ? rows.filter((row) => row.some((cell) => String(cell ?? "").toLocaleLowerCase().includes(filter))) : rows;
  const max = Math.max(1, ...shown.map((row) => typeof row[1] === "number" ? Math.abs(row[1]) : 0));
  return <div className="overflow-x-auto">
    <table className="w-full text-left text-sm"><caption className="sr-only">{definition.title}</caption>
      <thead><tr>{columns.map((column, i) => <th className="border-b px-2 py-2 font-medium" key={i} scope="col">{column}</th>)}</tr></thead>
      <tbody>{shown.map((row, i) => <tr key={i}>{row.map((cell, j) => <td className="border-b px-2 py-2" key={j}>{cell === null ? "Missing" : typeof cell === "number" ? cell.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(cell)}
        {definition.view.kind === "chart" && j === 1 && typeof cell === "number" && <span aria-hidden className="mt-1 block h-2 rounded bg-primary/60" style={{ width: `${Math.abs(cell) / max * 100}%` }} />}
      </td>)}</tr>)}</tbody>
    </table>
    {!shown.length && <p className="py-3 text-sm text-muted-foreground">No data matches. Missing data has not been estimated.</p>}
  </div>;
}

function download(artifact: Artifact, values: Values, format: "json" | "csv") {
  const def = artifact.definition;
  const columns = def.view.kind === "calculator" ? ["Option", "Total", "Unit"] : def.view.kind === "sandbox" ? [] : def.view.columns;
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
  const report = useMutation(api.interactive.report);
  const [base, setBase] = useState(artifact);
  const [values, setValues] = useState(artifact.values);
  const [notice, setNotice] = useState("Saved draft");
  const [conflict, setConflict] = useState(false);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const saving = useRef(false);
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
    if (saving.current || conflict) return;
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
    if (!dirty || conflict || saving.current) return;
    const timer = setTimeout(() => void persist("save"), 650);
    return () => clearTimeout(timer);
  }, [values, base.revision, dirty, conflict]);
  const change = useCallback((id: string, value: Values[string]) => setValues((previous) => ({ ...previous, [id]: value })), []);
  const def = base.definition;
  return <article id={`interactive-${artifact.id}`} aria-label={`Interactive answer: ${def.title}`} data-interactive={artifact.id} data-revision={base.revision} className="min-w-0 space-y-4 rounded-xl border p-4">
    <div><h3 className="font-semibold">{def.title}</h3><p className="mt-1 text-sm whitespace-pre-wrap">{def.summary}</p></div>
    <div className="grid gap-3 sm:grid-cols-2">{def.inputs.map((input) => <Control key={input.id} scope={artifact.id} input={input} value={values[input.id]} onChange={(value) => change(input.id, value)} />)}</div>
    {def.view.kind === "sandbox" ? <Sandbox key={`${base.revision}`} artifact={base} values={values} onChange={change} /> : <NativeView definition={def} values={values} />}
    <div className="space-y-1 text-xs text-muted-foreground" data-provenance>
      <p>{def.provenance.kind === "illustrative" ? "Illustrative example" : def.provenance.kind === "owner" ? "Owner-provided inputs" : "Retrieved data snapshot"} · {def.provenance.period || "Period not specified"} · {def.provenance.units || "Units not specified"}</p>
      {def.provenance.sources.map((source, i) => <p key={i}>{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer" className="underline">{source.label}</a> : source.label}{source.fetchedAt ? ` · fetched ${source.fetchedAt}` : ""}</p>)}
      {def.provenance.assumptions.map((line, i) => <p key={`a${i}`}>Assumption: {line}</p>)}
      {def.provenance.missing.map((line, i) => <p key={`m${i}`}>Missing: {line}</p>)}
      <p>Local exploration and saved drafts. Account changes require separate approval in chat.</p>
    </div>
    <p className="text-xs" role="status">{notice}</p>
    {conflict && <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={() => { setBase(artifact); setValues(artifact.values); setConflict(false); setNotice("Loaded latest draft"); }}>Load latest draft</Button>
      <Button size="sm" variant="outline" onClick={() => { setBase(artifact); setValues(migrateValues(artifact.definition, base.definition, values)); setConflict(false); setNotice("Keeping your inputs on the latest draft"); }}>Keep my inputs</Button>
    </div>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={conflict || saveBusy} onClick={() => void persist("save")}>Save draft</Button>
      <Button type="button" size="sm" variant="ghost" disabled={conflict || saveBusy} onClick={() => void persist("reset")}>Reset</Button>
      <Button type="button" size="sm" variant="ghost" disabled={conflict || saveBusy || !base.canUndo} onClick={() => void persist("undo")}>Undo</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => download(base, values, "json")}>Export JSON</Button>
      {def.view.kind !== "sandbox" && <Button type="button" size="sm" variant="ghost" onClick={() => download(base, values, "csv")}>Export CSV</Button>}
    </div>
    <form className="flex flex-wrap gap-2" onSubmit={async (event) => {
      event.preventDefault(); if (!question.trim() || dirty || conflict || sending) return;
      setSending(true);
      try { await followup({ key, id: base.id, conversationId: base.conversationId, expectedRevision: base.revision, requestId: crypto.randomUUID(), text: question }); setQuestion(""); setNotice("Follow-up requested in this chat"); }
      catch (error) { setNotice(`Follow-up failed: ${error instanceof Error ? error.message : String(error)}`); }
      finally { setSending(false); }
    }}>
      <input className={`${fieldClass} min-w-0 flex-1`} aria-label={`Revise ${def.title}`} placeholder="Ask Perry to revise this answer…" maxLength={1000} value={question} onChange={(e) => setQuestion(e.target.value)} />
      <Button type="submit" size="sm" variant="outline" disabled={dirty || conflict || saveBusy || sending || !question.trim()}>Ask Perry</Button>
    </form>
  </article>;
}

export function InteractiveAnswers({ conversationId }: { conversationId: Id<"conversations"> }) {
  const key = useDashboardKey();
  const artifacts = useQuery(api.interactive.list, { key, conversationId });
  return artifacts?.length ? <section aria-label="Interactive answers" className="space-y-4">{artifacts.map((artifact) => <Answer key={artifact.id} artifact={artifact} />)}</section> : null;
}
