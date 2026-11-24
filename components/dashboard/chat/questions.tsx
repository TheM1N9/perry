"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorText } from "@/lib/format";

export function NativeQuestions({ conversationId }: { conversationId: Id<"conversations"> }) {
  const { dashboardKey: key } = useSession();
  const requests = useQuery(api.questions.pending, { key, conversationId });
  return <>{requests?.map(request => <QuestionForm key={request._id} request={request} />)}</>;
}
function QuestionForm({ request }: { request: Doc<"userQuestions"> }) {
  const { dashboardKey: key } = useSession();
  const submit = useMutation(api.questions.answer);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <form className="mb-3 max-h-80 space-y-3 overflow-y-auto rounded-lg border p-3" data-native-questions onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError("");
    try { await submit({ key, id: request._id, answers: Object.fromEntries(request.questions.map(question => [question.id, other[question.id]?.trim() ? [other[question.id].trim()] : answers[question.id] ?? []])) }); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }}>
    {request.questions.map(question => <fieldset key={question.id} disabled={busy} className="space-y-2">
      <legend className="text-sm font-medium">{question.header}</legend><p className="text-sm">{question.question}</p>
      <div className="flex flex-wrap gap-2">{question.options.map(option => <Button type="button" key={option.label} variant={answers[question.id]?.includes(option.label) ? "secondary" : "outline"} size="sm" aria-pressed={answers[question.id]?.includes(option.label) ?? false} title={option.description} onClick={() => {
        setOther(current => ({ ...current, [question.id]: "" }));
        setAnswers(current => ({ ...current, [question.id]: question.multiple ? current[question.id]?.includes(option.label) ? current[question.id].filter(label => label !== option.label) : [...current[question.id] ?? [], option.label] : [option.label] }));
      }}>{option.label}</Button>)}</div>
      <label className="block text-xs text-muted-foreground" htmlFor={`${request._id}-${question.id}`}>Your answer{question.options.length ? " (or choose above)" : ""}</label>
      <Textarea id={`${request._id}-${question.id}`} rows={2} maxLength={4000} value={other[question.id] ?? ""} onChange={event => setOther(current => ({ ...current, [question.id]: event.target.value }))} />
    </fieldset>)}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button type="submit" size="sm" disabled={busy || request.questions.some(question => !other[question.id]?.trim() && !answers[question.id]?.length)}>{busy ? "Sending…" : "Continue"}</Button>
  </form>;
}
