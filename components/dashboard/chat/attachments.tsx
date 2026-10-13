"use client";

import { ExpandIcon, FileIcon, FileXIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { previewOf } from "@/convex/lib/library";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { FilePreview } from "@/components/ui/file-preview";
import { bytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AudioPlayer, VideoPlayer } from "@/components/ui/media-player";

/** A file in a message; `removed` once it was deleted from the Library, with no address. */
export type Attachment = { id?: Id<"chatAttachments">; url: string; fileName: string; contentType: string; removed?: true };

/** What a message carries: pictures and players inline, anything else as a file to open. */
export function AttachmentList({ attachments, align = "start", compact = false }: { attachments: Attachment[]; align?: "start" | "end"; compact?: boolean }) {
  const [preview, setPreview] = useState<Attachment | null>(null);
  if (!attachments.length) return null;
  return (
    <>
    <div className={cn("flex flex-wrap gap-2", !compact && "mt-2", align === "end" && "justify-end")}>
      {attachments.map((attachment, index) => {
        if (compact) {
          return <Button type="button" key={attachment.id ?? index} variant="ghost" onClick={() => setPreview(attachment)} disabled={attachment.removed}
            aria-label={`Preview ${attachment.fileName}`} title={attachment.fileName}
            className="size-16 overflow-hidden rounded-lg border bg-muted p-0 hover:bg-muted">
            {!attachment.removed && attachment.contentType.startsWith("image/") ? <img src={attachment.url} alt={attachment.fileName} className="size-full object-cover" />
              : <span className="flex size-full flex-col justify-end gap-1 p-1.5 text-left text-2xs leading-tight"><FileIcon className="mb-auto size-4 text-muted-foreground" /><span className="max-w-full truncate">{attachment.fileName}</span></span>}
          </Button>;
        }
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
            <Button type="button" variant="ghost" key={attachment.url} onClick={() => setPreview(attachment)} aria-label={`Preview ${attachment.fileName}`}
              className="block h-auto overflow-hidden rounded-xl bg-muted p-0 hover:bg-muted focus-visible:ring-2">
              <img src={attachment.url} alt={attachment.fileName} loading="lazy" className="max-h-64 max-w-full object-cover sm:max-w-sm" />
            </Button>
          );
        }
        if (attachment.contentType.startsWith("video/")) {
          return <div key={attachment.url} className="w-full max-w-full sm:max-w-md">
            <VideoPlayer src={attachment.url} name={attachment.fileName} download={attachment.url} className="max-h-72" />
            <Button type="button" variant="ghost" size="xs" className="mt-1 text-muted-foreground" onClick={() => setPreview(attachment)} aria-label={`Preview ${attachment.fileName}`}><ExpandIcon className="size-3" />Preview</Button>
          </div>;
        }
        if (attachment.contentType.startsWith("audio/")) {
          return <div key={attachment.url} className="w-full sm:w-80">
            <AudioPlayer src={attachment.url} name={attachment.fileName} download={attachment.url} />
            <Button type="button" variant="ghost" size="xs" className="mt-1 text-muted-foreground" onClick={() => setPreview(attachment)} aria-label={`Preview ${attachment.fileName}`}><ExpandIcon className="size-3" />Preview</Button>
          </div>;
        }
        return (
          <Button type="button" variant="ghost" key={attachment.url} onClick={() => setPreview(attachment)} aria-label={`Preview ${attachment.fileName}`}
            className="h-auto max-w-64 justify-start gap-2 rounded-lg bg-muted px-3 py-2">
            <FileIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{attachment.fileName}</span>
          </Button>
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
export function PickedFiles({ files, onRemove, disabled, className }: { files: File[]; onRemove: (file: File) => void; disabled?: boolean; className?: string }) {
  const [previews, setPreviews] = useState<Map<File, string>>(new Map());
  useEffect(() => {
    const next = new Map(files.filter((file) => /^(image|video)\//.test(file.type)).map((file) => [file, URL.createObjectURL(file)]));
    setPreviews(next);
    return () => next.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  if (!files.length) return null;
  return (
    <ul aria-label="Attached files" className={cn("flex gap-2 overflow-x-auto px-3 pt-3", className)}>
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
            <Button type="button" variant="secondary" size="icon-xs" aria-label={`Remove ${file.name}`} disabled={disabled} onClick={() => onRemove(file)}
              className="absolute top-1 right-1 size-5 rounded-full bg-background/90 shadow-sm disabled:hidden">
              <XIcon className="size-3" />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
