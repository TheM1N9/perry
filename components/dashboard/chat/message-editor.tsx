"use client";

import { useRef, useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { errorText } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Attachment } from "./attachments";
import { Composer, ComposerNote, MAX_BYTES, MAX_FILES } from "./composer";
import type { ChatMessage } from "./message";

export type MessageEdit = { text: string; attachmentIds: Id<"chatAttachments">[]; requestId: string };
export type UploadedAttachment = Attachment & { id: Id<"chatAttachments"> };

/** Keep the opened revision and successful uploads until Save succeeds or the owner cancels. */
export function MessageEditor({ message, assistant, waiting, onClose, onStop, onUpload, onSave }: {
  message: ChatMessage;
  assistant: string;
  waiting: boolean;
  onClose: () => void;
  onStop: () => Promise<unknown>;
  onUpload: (file: File, requestId: string, uploadId: string) => Promise<UploadedAttachment>;
  onSave: (edit: MessageEdit) => Promise<void>;
}) {
  const [text, setText] = useState(message.text);
  const [retained, setRetained] = useState(message.attachments);
  const [files, setFiles] = useState<File[]>([]);
  const [requestId] = useState(() => crypto.randomUUID());
  const [uploading, setUploading] = useState<{ index: number; total: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const uploaded = useRef(new Map<File, UploadedAttachment>());
  const uploadIds = useRef(new Map<File, string>());
  const input = useRef<HTMLTextAreaElement>(null);

  function addFiles(added: File[]) {
    if (saving) return;
    const valid = added.filter((file) => file.size > 0 && file.size <= MAX_BYTES);
    const room = Math.max(0, MAX_FILES - retained.length - files.length);
    setError(valid.length !== added.length ? "Attachments must be between 1 byte and 50 MB." : valid.length > room ? "A message can have up to 10 files." : "");
    setFiles((current) => [...current, ...valid.slice(0, room)]);
  }

  async function save() {
    if (saving || waiting || (!text.trim() && !files.length && !retained.some((item) => !item.removed))) return;
    setSaving(true); setError("");
    try {
      const attachmentIds = retained.flatMap((item) => item.id ? [item.id] : []);
      for (const [index, file] of files.entries()) {
        let attachment = uploaded.current.get(file);
        if (!attachment) {
          setUploading({ index: index + 1, total: files.length });
          const uploadId = uploadIds.current.get(file) ?? crypto.randomUUID();
          uploadIds.current.set(file, uploadId);
          attachment = await onUpload(file, requestId, uploadId);
          uploaded.current.set(file, attachment);
        }
        attachmentIds.push(attachment.id);
      }
      setUploading(null);
      await onSave({ text, attachmentIds, requestId });
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setUploading(null); setSaving(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" initialFocus={input} showCloseButton={!saving}>
      <DialogHeader>
        <DialogTitle>Edit your message</DialogTitle>
        <DialogDescription>Saving replaces this message and the replies after it.</DialogDescription>
      </DialogHeader>
      {waiting && <div className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
        <p role="status">Finish or stop the current reply before saving. Your edit stays here.</p>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void onStop().catch((cause) => setError(errorText(cause)))}>Stop reply</Button>
      </div>}
      {!text.trim() && !files.length && !retained.some((item) => !item.removed) && <p role="status" className="text-sm text-muted-foreground">Keep some text or a file to save. Cancel to use the chat’s Delete action.</p>}
      {error && <ComposerNote tone="error" onDismiss={() => setError("")}>{error}</ComposerNote>}
      <Composer ref={input} assistant={assistant} draft={text} onDraftChange={setText} onSubmit={() => void save()}
        waiting={waiting} busy={saving} uploading={uploading} files={files} onAddFiles={addFiles}
        onRemoveFile={(file) => { if (!saving) setFiles((current) => current.filter((item) => item !== file)); }}
        suggestions={[]} completing={null}
        editing={{ attachments: retained, onRemove: (file) => { if (!saving) setRetained((current) => current.filter((item) => item !== file)); }, onCancel: () => { if (!saving) onClose(); } }} />
    </DialogContent>
  </Dialog>;
}
