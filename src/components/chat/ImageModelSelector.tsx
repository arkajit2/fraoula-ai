import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IMAGE_MODELS } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/** Picks which model renders the image. Prices stay out of the chat surface. */
export function ImageModelSelector({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const selected = IMAGE_MODELS.find((m) => m.id === value) ?? IMAGE_MODELS[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
      >
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70">Image</span>
        <span className="text-foreground">{selected?.label}</span>
        <ChevronDown className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 rounded-xl">
        {IMAGE_MODELS.map((model) => (
          <DropdownMenuItem
            key={model.id}
            onSelect={() => onChange(model.id)}
            className="flex cursor-pointer items-start gap-2 rounded-lg py-2"
          >
            <Check className={cn("mt-0.5 h-4 w-4", model.id === value ? "opacity-100" : "opacity-0")} />
            <span className="flex-1">
              <span className="block text-sm font-medium">{model.label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{model.description}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
