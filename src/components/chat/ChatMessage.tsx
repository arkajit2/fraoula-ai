import { useEffect, useState } from "react";
import { Download, ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";

export interface ChatMessageData {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** "image" messages render the generated picture instead of markdown. */
  kind?: "text" | "image" | null;
  /** Storage path of the generated image, resolved to a signed URL for display. */
  imagePath?: string | null;
  imageUrl?: string | null;
}

function useTypewriter(text: string, enabled: boolean) {
  const [shown, setShown] = useState(enabled ? "" : text);

  useEffect(() => {
    if (!enabled) {
      setShown(text);
      return;
    }
    let index = 0;
    const step = Math.max(2, Math.round(text.length / 220));
    const timer = setInterval(() => {
      index += step;
      setShown(text.slice(0, index));
      if (index >= text.length) clearInterval(timer);
    }, 16);
    return () => clearInterval(timer);
  }, [text, enabled]);

  return shown;
}

export function ChatMessage({ message, animate = false }: { message: ChatMessageData; animate?: boolean }) {
  const isUser = message.role === "user";
  const isImage = message.kind === "image";
  const content = useTypewriter(message.content, animate && !isUser && !isImage);

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-muted px-4 py-3 text-[15px] leading-7">
          {message.content}
        </div>
      </div>
    );
  }

  if (isImage) {
    return (
      <div className="flex justify-start">
        <figure className="w-full max-w-[512px]">
          {message.imageUrl ? (
            <img
              src={message.imageUrl}
              alt={message.content}
              loading="lazy"
              className="w-full rounded-2xl border bg-muted object-cover"
            />
          ) : (
            <div className="flex aspect-square w-full items-center justify-center rounded-2xl border bg-muted text-muted-foreground">
              <ImageOff className="h-5 w-5" />
            </div>
          )}
          <figcaption className="mt-2 flex items-start justify-between gap-3">
            <span className="text-xs text-muted-foreground">{message.content}</span>
            {message.imageUrl && (
              <a
                href={message.imageUrl}
                download
                target="_blank"
                rel="noreferrer"
                aria-label="Download image"
                className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
              >
                <Download className="h-3.5 w-3.5" />
                Save
              </a>
            )}
          </figcaption>
        </figure>
      </div>
    );
  }

  return (
    <div className={cn("flex justify-start")}>
      <div className="w-full max-w-full">
        <Markdown content={content} />
      </div>
    </div>
  );
}


export function TypingIndicator() {
  return (
    <div className="flex items-center gap-1.5 py-2" aria-label="Assistant is typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/50"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}
