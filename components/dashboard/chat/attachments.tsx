"use client";

import { ExpandIcon, FileIcon, FileXIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { previewOf } from "@/convex/lib/library";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { FilePreview } from "@/components/ui/file-preview";
import { bytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AudioPlayer, VideoPlayer } from "@/components/ui/media-player";

/** A file in a message; `removed` once it was deleted from the Library, with no address. */
export type Attachment = { id?: Id<"chatAttachments">; url: string; fileName: string; contentType: string; removed?: true };

/** What a message carries: pictures and players inline, anything else as a file to open. */
export function AttachmentList({ attachments, align = "start" }: { attachments: Attachment[]; align?: "start" | "end" }) {
  const [preview, setPreview] = useState<Attachment | null>(null);
  if (!attachments.length) return null;
  return (
    <>
    <div className={cn("mt-2 flex flex-wrap gap-2", align === "end" && "justify-end")}>
      {attachments.map((attachment, index) => {
        if (attachment.removed) {
          return (
            <span key={`removed-${index}-${attachment.fileName}`} data-removed
              className="flex max-w-64 items-center gap-2 rounded-xl border border-dashed px-3 py-2 text-sm text-muted-foreground">
              <FileXIcon className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{attachment.fileName}</span>
              <span className="shrink-0 text-xs">removed</span>
            </span>
          );
        }
        if (attachment.contentType.startsWith("image/")) {
          return (
            <button type="button" key={attachment.url} onClick={() => setPreview(attachment)} aria-label={`Preview ${attachment.fileName}`}
              className="block overflow-hidden rounded-xl border bg-muted">
              <img src={attachment.url} alt={attachment.fileName} loading="lazy" className="max-h-64 max-w-full object-cover sm:max-w-sm" />
            </button>
          );
        }
        if (attachment.contentType.startsWith("video/")) {
          return <div key={attachment.url} className="w-full max-w-full sm:max-w-md">
            <VideoPlayer src={attachment.url} name={attachment.fileName} download={attachment.url} className="max-h-72" />
            <button type="button" className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setPreview(attachment)} aria-label={`Preview ${attachment.fileName}`}><ExpandIcon className="size-3" />Preview</button>
          </div>;
        }
        if (attachment.contentType.startsWith("audio/")) {
          return <div key={attachment.url} className="w-full sm:w-80">
            <AudioPlayer src={attachment.url} name={attachment.fileName} download={attachment.url} />
            <button type="button" className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setPreview(attachment)} aria-label={`Preview ${attachment.fileName}`}><ExpandIcon className="size-3" />Preview</button>
          </div>;
        }
        return (
          <button type="button" key={attachment.url} onClick={() => setPreview(attachment)} aria-label={`Preview ${attachment.fileName}`}
            className="flex max-w-64 items-center gap-2 rounded-xl border bg-background px-3 py-2 text-sm hover:bg-muted">
            <FileIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{attachment.fileName}</span>
          </button>
        );
      })}
    </div>
    <Dialog open={preview !== null} onOpenChange={(open) => { if (!open) setPreview(null); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        {preview && <>
          <DialogTitle className="pr-8 break-words">{preview.fileName}</DialogTitle>
          <DialogDescription className="sr-only">File preview</DialogDescription>
          <FilePreview key={preview.url} item={{ name: preview.fileName, url: preview.url.startsWith("/api/media/") ? `${preview.url}?preview=1` : preview.url, preview: previewOf(preview.contentType, preview.fileName), download: preview.url }} />
          <a href={preview.url.startsWith("/api/media/") ? `${preview.url}?download=1` : preview.url} download className="link">Download {preview.fileName}</a>
        </>}
      </DialogContent>
    </Dialog>
    </>
  );
}

/** Files picked for the next message, with previews and a way to take each back out. */
export function PickedFiles({ files, onRemove, disabled }: { files: File[]; onRemove: (file: File) => void; disabled?: boolean }) {
  const [previews, setPreviews] = useState<Map<File, string>>(new Map());
  useEffect(() => {
    const next = new Map(files.filter((file) => /^(image|video)\//.test(file.type)).map((file) => [file, URL.createObjectURL(file)]));
    setPreviews(next);
    return () => next.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  if (!files.length) return null;
  return (
    <ul aria-label="Attached files" className="flex gap-2 overflow-x-auto px-3 pt-3">
      {files.map((file, index) => {
        const url = previews.get(file);
        return (
          <li key={`${index}-${file.name}-${file.lastModified}`} title={`${file.name} · ${bytes(file.size)}`}
            className="group/file relative size-16 shrink-0 overflow-hidden rounded-lg border bg-muted">
            {url && file.type.startsWith("image/") ? <img src={url} alt={file.name} className="size-full object-cover" />
              : url ? <video src={url} muted playsInline preload="metadata" aria-label={file.name} className="size-full object-cover" />
              : (
                <span className="flex size-full flex-col justify-end p-1.5 text-2xs leading-tight">
                  <FileIcon className="mb-auto size-4 text-muted-foreground" />
                  <span className="truncate font-medium">{file.name}</span>
                  <span className="text-muted-foreground">{bytes(file.size)}</span>
                </span>
              )}
            <button type="button" aria-label={`Remove ${file.name}`} disabled={disabled} onClick={() => onRemove(file)}
              className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-foreground/80 text-background opacity-90 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring disabled:hidden">
              <XIcon className="size-3" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
