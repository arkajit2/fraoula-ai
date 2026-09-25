import { useEffect, useRef } from "react";
import { ArrowUp, Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ModelSelector } from "./ModelSelector";
import { ImageModelSelector } from "./ImageModelSelector";

export type ComposerMode = "chat" | "image";

export function ChatInput({
  value,
  onChange,
  onSend,
  disabled,
  modelId,
  onModelChange,
  autoFocus,
  freeExhausted,
  mode,
  onModeChange,
  imageModelId,
  onImageModelChange,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  modelId: string;
  onModelChange: (id: string) => void;
  autoFocus?: boolean;
  /** Daily free allowance used up — the free model is locked until it resets. */
  freeExhausted?: boolean;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  imageModelId: string;
  onImageModelChange: (id: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const isImage = mode === "image";

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  return (
    <div className="rounded-3xl border bg-card p-2 shadow-sm transition-shadow focus-within:shadow-md">
      <textarea
        ref={ref}
        rows={1}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!disabled) onSend();
          }
        }}
        placeholder={isImage ? "Describe an image..." : "Ask anything..."}
        className="max-h-60 w-full resize-none bg-transparent px-3 py-2.5 text-[15px] leading-7 outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center justify-between gap-2 px-1 pt-1">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            aria-pressed={isImage}
            aria-label="Generate an image"
            onClick={() => onModeChange(isImage ? "chat" : "image")}
            disabled={disabled}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
              isImage
                ? "border-primary bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            <ImageIcon className="h-3.5 w-3.5" />
            Image
          </button>

          {isImage ? (
            <ImageModelSelector
              value={imageModelId}
              onChange={onImageModelChange}
              disabled={disabled}
            />
          ) : (
            <ModelSelector
              value={modelId}
              onChange={onModelChange}
              disabled={disabled}
              freeExhausted={freeExhausted}
            />
          )}
        </div>

        <button
          type="button"
          aria-label={isImage ? "Generate image" : "Send message"}
          onClick={onSend}
          disabled={disabled || !value.trim()}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-30"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

