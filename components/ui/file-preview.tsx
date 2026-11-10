"use client";

import { FileIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { previewOf } from "@/convex/lib/library";
import { Markdown } from "@/components/dashboard/chat/markdown";
import { AudioPlayer, VideoPlayer } from "./media-player";
import { Spinner } from "./spinner";

const TEXT_LIMIT = 200_000;

export function FilePreview({ item }: { item: { name: string; url: string; preview: ReturnType<typeof previewOf>; download?: string } }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (item.preview !== "text" && item.preview !== "markdown") return;
    let current = true;
    fetch(item.url).then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .then((body) => { if (current) setText(body.length > TEXT_LIMIT ? `${body.slice(0, TEXT_LIMIT)}\n…` : body); }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [item.preview, item.url]);
  const none = (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl bg-muted/50 py-16 text-muted-foreground">
      <FileIcon className="size-8" aria-hidden />
      <p className="text-sm">No preview for this kind of file.</p>
    </div>
  );
  switch (item.preview) {
    case "image":
      // eslint-disable-next-line @next/next/no-img-element -- a file on this computer, served by /api/media
      return <img src={item.url} alt={item.name} className="mx-auto max-h-[70vh] max-w-full rounded-xl object-contain" />;
    case "video": return <VideoPlayer src={item.url} name={item.name} download={item.download ?? item.url} className="max-h-[70vh]" />;
    case "audio": return <AudioPlayer src={item.url} name={item.name} download={item.download ?? item.url} className="max-w-lg" />;
    case "pdf": return <iframe src={item.url} title={item.name} className="h-[70vh] w-full rounded-xl border" />;
    case "markdown":
    case "text":
      if (failed) return none;
      if (text === null) return <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Spinner />Loading…</p>;
      return item.preview === "markdown"
        ? <article className="max-h-[70vh] overflow-auto rounded-xl bg-muted/40 px-5 py-4" data-text-preview><Markdown text={text} /></article>
        : <pre className="max-h-[70vh] overflow-auto rounded-xl bg-muted/40 px-5 py-4 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]" data-text-preview>{text}</pre>;
    default: return none;
  }
}
