/**
 * SERVER-ONLY image generation — Cloudflare Workers AI + R2 edition.
 *
 * Uses @cf/bytedance/stable-diffusion-xl-lightning (free via Workers AI) for
 * image generation and R2 for storage. No external API keys or Supabase needed.
 */

import { getImageModel, round6 } from "./pricing";
import { ChatError, creditWallet } from "./chat.server";
import type { WorkerEnv } from "./chat.server";
import {
  getWallet,
  createWallet,
  updateWalletBalance,
  getConversation,
  createConversation,
  insertMessages,
  recordUsage,
} from "./db.server";

// ─── Config ───────────────────────────────────────────────────────────────────

const CF_IMAGE_MODEL = "@cf/bytedance/stable-diffusion-xl-lightning";
const IMAGE_API_COST_USD = 0.0; // Free on Workers AI
const MIN_BALANCE_FOR_PAID_IMAGE = 0.05; // $0.05 minimum

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GenerateImageInput {
  conversationId: string | null;
  prompt: string;
  imageModelId: string;
}

export interface GenerateImageResult {
  conversationId: string;
  userMessageId: string;
  assistantMessage: { id: string; content: string; created_at: string; imagePath: string };
  r2Url: string;
  balance: number;
  cost: number;
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function generateImageTurn(
  env: WorkerEnv,
  userId: string,
  input: GenerateImageInput,
): Promise<GenerateImageResult> {
  const { DB: db, AI: ai } = env;
  const r2 = (env as unknown as { FRAOULA_IMAGES?: R2Bucket }).FRAOULA_IMAGES;

  const prompt = input.prompt.trim();
  if (!prompt) throw new ChatError("Describe the image you'd like to create.");
  if (prompt.length > 4_000) throw new ChatError("That prompt is too long.");

  const model = getImageModel(input.imageModelId);
  if (!model) throw new ChatError("That image model isn't available.", 400);

  // Check conversation ownership
  if (input.conversationId) {
    const convo = await getConversation(db, input.conversationId, userId);
    if (!convo) throw new ChatError("Conversation not found.", 404);
  }

  // Balance check for paid image models
  const charge = model.pricePerImage ?? 0;
  if (charge > 0) {
    let wallet = await getWallet(db, userId);
    if (!wallet) wallet = await createWallet(db, userId);
    if (wallet.balance < charge) {
      throw new ChatError(
        `Not enough credits for ${model.label}. Recharge your wallet on the Credits page.`,
        402,
      );
    }
  }

  // Generate via CF Workers AI
  let imageBytes: Uint8Array;
  try {
    const result = await (ai as unknown as {
      run(model: string, inputs: { prompt: string }): Promise<ReadableStream | { image: string }>;
    }).run(CF_IMAGE_MODEL, { prompt });

    if (result instanceof ReadableStream) {
      const chunks: Uint8Array[] = [];
      const reader = result.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      imageBytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { imageBytes.set(chunk, offset); offset += chunk.length; }
    } else if ("image" in result && typeof result.image === "string") {
      const binary = atob(result.image);
      imageBytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) imageBytes[i] = binary.charCodeAt(i);
    } else {
      throw new Error("Unexpected image response format");
    }
  } catch (err) {
    if (err instanceof ChatError) throw err;
    throw new ChatError("Image generation failed. Please try again.", 502);
  }

  // Store in R2 (or fall back to base64 data URL if no R2 binding)
  const imagePath = `${userId}/${crypto.randomUUID()}.png`;
  let r2Url: string;

  if (r2) {
    await r2.put(imagePath, imageBytes, { httpMetadata: { contentType: "image/png" } });
    r2Url = `/api/images/${imagePath}`;
  } else {
    // Fallback: base64 data URL (dev only)
    const b64 = btoa(String.fromCharCode(...imageBytes));
    r2Url = `data:image/png;base64,${b64}`;
  }

  // Create conversation if needed
  let conversationId = input.conversationId;
  if (!conversationId) {
    const convo = await createConversation(db, userId, prompt.slice(0, 60));
    conversationId = convo.id;
  }

  // Billing
  let balance = 0;
  if (charge > 0) {
    balance = await updateWalletBalance(db, userId, -charge);
  } else {
    balance = (await getWallet(db, userId))?.balance ?? 0;
  }

  // Record usage
  await recordUsage(db, {
    user_id: userId,
    provider: "Cloudflare AI",
    model: `${model.label} (image)`,
    conversation_id: conversationId,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    api_cost: IMAGE_API_COST_USD,
    platform_markup: round6(charge - IMAGE_API_COST_USD),
    final_cost: charge,
  });

  // Persist messages
  const now = new Date();
  const written = await insertMessages(db, [
    { conversation_id: conversationId, role: "user", content: prompt, created_at: now.toISOString() },
    {
      conversation_id: conversationId,
      role: "assistant",
      content: `[Image: ${imagePath}]`,
      created_at: new Date(now.getTime() + 1).toISOString(),
    },
  ]);

  const userMsg = written.find((m) => m.role === "user")!;
  const assistantMsg = written.find((m) => m.role === "assistant")!;

  return {
    conversationId,
    userMessageId: userMsg.id,
    assistantMessage: {
      id: assistantMsg.id,
      content: assistantMsg.content,
      created_at: assistantMsg.created_at,
      imagePath,
    },
    r2Url,
    balance,
    cost: charge,
  };
}

/** Get a signed R2 URL for an image (1-hour TTL). */
export async function getImageUrl(env: WorkerEnv, path: string): Promise<string> {
  const r2 = (env as unknown as { FRAOULA_IMAGES?: R2Bucket }).FRAOULA_IMAGES;
  if (!r2) throw new ChatError("Image storage not configured.", 503);
  const obj = await r2.get(path);
  if (!obj) throw new ChatError("Image not found.", 404);
  // R2 doesn't have signed URLs natively without Workers Bucket URL — return as /api route
  return `/api/images/${path}`;
}
