"use client";

import { FileIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { bytes } from "@/lib/format";
import { cn } from "@/lib/utils";

export type Attachment = { url: string; fileName: string; contentType: string };

/** What a message carries: pictures and players inline, anything else as a file to open. */
export function AttachmentList({ attachments, align = "start" }: { attachments: Attachment[]; align?: "start" | "end" }) {
  if (!attachments.length) return null;
  return (
    <div className={cn("mt-2 flex flex-wrap gap-2", align === "end" && "justify-end")}>
      {attachments.map((attachment) => {
        if (attachment.contentType.startsWith("image/")) {
          return (
            <a key={attachment.url} href={attachment.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${attachment.fileName}`}
              className="block overflow-hidden rounded-xl border bg-muted">
              <img src={attachment.url} alt={attachment.fileName} loading="lazy" className="max-h-64 max-w-full object-cover sm:max-w-sm" />
            </a>
          );
        }
        if (attachment.contentType.startsWith("video/")) {
          return <video key={attachment.url} controls preload="metadata" src={attachment.url} aria-label={attachment.fileName} className="max-h-72 max-w-full rounded-xl border sm:max-w-md" />;
        }
        if (attachment.contentType.startsWith("audio/")) {
          return <audio key={attachment.url} controls src={attachment.url} aria-label={attachment.fileName} className="max-w-full" />;
        }
        return (
          <a key={attachment.url} href={attachment.url} target="_blank" rel="noopener noreferrer"
            className="flex max-w-64 items-center gap-2 rounded-xl border bg-background px-3 py-2 text-sm hover:bg-muted">
            <FileIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{attachment.fileName}</span>
          </a>
        );
      })}
    </div>
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
                <span className="flex size-full flex-col justify-end p-1.5 text-[10px] leading-tight">
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
