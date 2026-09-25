import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const generateImageSchema = z.object({
  conversationId: z.string().uuid().nullable(),
  prompt: z
    .string()
    .trim()
    .min(1, "Describe the image you'd like to create.")
    .max(4_000, "That prompt is too long."),
  imageModelId: z.string().min(1).max(60),
});

const signImagesSchema = z.object({
  paths: z.array(z.string().min(1).max(300)).max(200),
});

export const generateChatImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => generateImageSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { generateImageTurn } = await import("./image.server");
    const { ChatError } = await import("./chat.server");
    const { RateLimitError } = await import("./rate-limit.server");
    const { log, newRequestId } = await import("./logging.server");

    const meta = { requestId: newRequestId(), endpoint: "image.generate" };

    try {
      return await generateImageTurn(context.supabase, context.userId, data, meta);
    } catch (error) {
      if (error instanceof ChatError) throw new Error(error.message);
      if (error instanceof RateLimitError) throw new Error(error.message);
      log.error(
        "server.exception",
        { ...meta, userId: context.userId },
        error instanceof Error ? error.message : String(error),
      );
      throw new Error(`Something went wrong. Please try again. (ref ${meta.requestId.slice(0, 8)})`);
    }
  });

export const signChatImages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => signImagesSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { signImagePathsForUser } = await import("./image.server");
    return signImagePathsForUser(context.userId, data.paths);
  });
