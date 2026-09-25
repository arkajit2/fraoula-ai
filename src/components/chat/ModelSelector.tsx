import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AVAILABLE_MODELS, canUseModel, planRequiredForModel } from "@/lib/pricing";
import { useSession } from "@/hooks/use-account";
import { useSubscription } from "@/hooks/use-subscription";
import { cn } from "@/lib/utils";

export function ModelSelector({
  value,
  onChange,
  disabled,
  freeExhausted,
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** When the daily free allowance is used up, the free model is not selectable. */
  freeExhausted?: boolean;
}) {
  const { user } = useSession();
  const { data: subscription } = useSubscription(user?.id);
  const selected = AVAILABLE_MODELS.find((m) => m.id === value) ?? AVAILABLE_MODELS[0];


  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
      >
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70">Model</span>
        <span className="text-foreground">{selected?.label}</span>
        <ChevronDown className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 rounded-xl">
        {AVAILABLE_MODELS.map((model) => {
          const planRequired = !canUseModel(model.id, subscription?.plan_id ?? null);
          const locked = (model.free && freeExhausted) || planRequired;
          return (
          <DropdownMenuItem
            key={model.id}
            disabled={locked}
            onSelect={() => !locked && onChange(model.id)}
            className="flex cursor-pointer items-start gap-2 rounded-lg py-2"
          >
            <Check className={cn("mt-0.5 h-4 w-4", model.id === value ? "opacity-100" : "opacity-0")} />
            <span className="flex-1">
              <span className="flex items-center gap-2 text-sm font-medium">
                {model.label}
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                    model.free
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {model.free ? "Free" : "Premium"}
                </span>
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {planRequired
                  ? `Included with ${planRequiredForModel(model.id)?.name ?? "a plan"}`
                  : model.free
                    ? locked
                      ? "Daily free limit reached"
                      : "No credits used · daily limit applies"
                    : "Uses wallet credits"}
              </span>


            </span>
          </DropdownMenuItem>
          );
        })}

      </DropdownMenuContent>
    </DropdownMenu>
  );
}
