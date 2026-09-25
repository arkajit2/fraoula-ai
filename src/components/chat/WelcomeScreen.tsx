const SUGGESTIONS = ["Ask anything", "Research", "Write", "Explain"];

export function WelcomeScreen({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex min-h-[45vh] flex-col items-center justify-center text-center">
      <h1 className="font-display text-3xl tracking-tight text-foreground sm:text-4xl">
        What do you want to know?
      </h1>
      <div className="mt-8 flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((label) => (
          <button
            key={label}
            type="button"
            onClick={() => onPick(`${label}: `)}
            className="rounded-full border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
