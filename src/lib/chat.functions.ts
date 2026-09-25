import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/** Every input is validated at the boundary; nothing downstream trusts the client. */
const sendMessageSchema = z.object({
  conversationId: z.string().uuid().nullable(),
  content: z.string().trim().min(1, "Message cannot be empty.").max(20_000, "Message is too long."),
  modelId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Unknown model."),
});

export const sendChatMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => sendMessageSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { sendMessage, ChatError } = await import("./chat.server");
    const { RateLimitError } = await import("./rate-limit.server");
    const { log, newRequestId } = await import("./logging.server");

    const meta = { requestId: newRequestId(), endpoint: "chat.sendMessage" };

    try {
      return await sendMessage(context.supabase, context.userId, data, meta);
    } catch (error) {
      if (error instanceof ChatError) throw new Error(error.message);
      if (error instanceof RateLimitError) {
        log.warn("ratelimit.violation", { ...meta, userId: context.userId });
        throw new Error(error.message);
      }
      // Internal details are logged, never returned.
      log.error(
        "server.exception",
        { ...meta, userId: context.userId },
        error instanceof Error ? error.message : String(error),
      );
      throw new Error(`Something went wrong. Please try again. (ref ${meta.requestId.slice(0, 8)})`);
    }
  });
