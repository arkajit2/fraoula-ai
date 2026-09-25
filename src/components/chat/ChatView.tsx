import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { sendChatMessage } from "@/lib/chat.functions";
import { generateChatImage, signChatImages } from "@/lib/image.functions";
import { DEFAULT_IMAGE_MODEL_ID, DEFAULT_MODEL_ID, getModel } from "@/lib/pricing";
import { useFreeUsage, useSession } from "@/hooks/use-account";

import { ChatInput, type ComposerMode } from "./ChatInput";
import { ChatMessage, TypingIndicator, type ChatMessageData } from "./ChatMessage";
import { WelcomeScreen } from "./WelcomeScreen";

export function ChatView({ conversationId = null }: { conversationId?: string | null }) {
  const { user } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const send = useServerFn(sendChatMessage);
  const createImage = useServerFn(generateChatImage);
  const signImages = useServerFn(signChatImages);

  const [input, setInput] = useState("");
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [mode, setMode] = useState<ComposerMode>("chat");
  const [imageModelId, setImageModelId] = useState(DEFAULT_IMAGE_MODEL_ID);
  const [pending, setPending] = useState<ChatMessageData | null>(null);
  const [animatedId, setAnimatedId] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: messages = [] } = useQuery({
    queryKey: ["messages", conversationId],
    enabled: !!conversationId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("id, role, content, kind, image_url")
        .eq("conversation_id", conversationId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id,
        role: row.role as ChatMessageData["role"],
        content: row.content,
        kind: (row.kind ?? "text") as ChatMessageData["kind"],
        imagePath: row.image_url,
      })) satisfies ChatMessageData[];
    },
  });

  // Stored images live in a private bucket, so each render needs signed URLs.
  const imagePaths = useMemo(
    () => messages.map((m) => m.imagePath).filter((p): p is string => !!p),
    [messages],
  );

  const { data: signedUrls = {} } = useQuery({
    queryKey: ["image-urls", conversationId, imagePaths.join(",")],
    enabled: imagePaths.length > 0,
    staleTime: 30 * 60 * 1000,
    queryFn: () => signImages({ data: { paths: imagePaths } }),
  });

  const resolved = useMemo(
    () =>
      messages.map((m) =>
        m.imagePath ? { ...m, imageUrl: signedUrls[m.imagePath] ?? null } : m,
      ),
    [messages, signedUrls],
  );

  const invalidateAccount = () => {
    queryClient.invalidateQueries({ queryKey: ["conversations", user?.id] });
    queryClient.invalidateQueries({ queryKey: ["wallet", user?.id] });
    queryClient.invalidateQueries({ queryKey: ["free-usage", user?.id] });
  };

  const afterTurn = (result: { conversationId: string; assistantMessage: { id: string } }) => {
    setPending(null);
    setAnimatedId(result.assistantMessage.id);
    invalidateAccount();

    if (!conversationId) {
      navigate({ to: "/chat/$conversationId", params: { conversationId: result.conversationId } });
    } else {
      queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
    }
  };

  const onTurnError = (error: Error) => {
    setPending(null);
    queryClient.invalidateQueries({ queryKey: ["free-usage", user?.id] });
    toast.error(error.message || "Something went wrong. Please try again.");
  };

  const mutation = useMutation({
    mutationFn: (content: string) => send({ data: { conversationId, content, modelId } }),
    onSuccess: afterTurn,
    onError: onTurnError,
  });

  const imageMutation = useMutation({
    mutationFn: (prompt: string) => createImage({ data: { conversationId, prompt, imageModelId } }),
    onSuccess: afterTurn,
    onError: onTurnError,
  });

  const busy = mutation.isPending || imageMutation.isPending;

  const { data: freeUsage } = useFreeUsage(user?.id);
  const freeExhausted = !!freeUsage?.exhausted;

  // The free model is locked once the daily allowance runs out.
  useEffect(() => {
    if (freeExhausted && getModel(modelId)?.free) {
      setModelId("gemini-3-6-flash");
      toast.info(freeUsage?.reason ?? "");
    }
  }, [freeExhausted, modelId, freeUsage?.reason]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending, busy]);

  const handleSend = (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    setInput("");
    setPending({ id: "pending", role: "user", content });
    if (mode === "image") imageMutation.mutate(content);
    else mutation.mutate(content);
  };

  const isEmpty = resolved.length === 0 && !pending;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[850px] px-4 pb-8 pt-6 sm:px-6">
          {isEmpty ? (
            <WelcomeScreen onPick={(prompt) => setInput(prompt)} />
          ) : (
            <div className="space-y-6">
              {resolved.map((message) => (
                <ChatMessage key={message.id} message={message} animate={message.id === animatedId} />
              ))}
              {pending && <ChatMessage message={pending} />}
              {busy && <TypingIndicator />}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t bg-background">
        <div className="mx-auto w-full max-w-[850px] px-4 py-4 sm:px-6">
          <ChatInput
            value={input}
            onChange={setInput}
            onSend={() => handleSend()}
            disabled={busy}
            modelId={modelId}
            onModelChange={setModelId}
            autoFocus
            freeExhausted={freeExhausted}
            mode={mode}
            onModeChange={setMode}
            imageModelId={imageModelId}
            onImageModelChange={setImageModelId}
          />
        </div>
      </div>
    </div>
  );
}

