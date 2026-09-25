/**
 * SERVER-ONLY image generation.
 *
 * Mirrors the chat turn: nothing is persisted and nothing is charged until the
 * provider has returned a real image. Images are stored in a private bucket and
 * only ever reach the browser through short-lived signed URLs.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  MIN_IMAGE_PRICE,
  getImageModel,
  round6,
  type ImageModelConfig,
} from "./pricing";
import { IMAGE_API_COSTS, IMAGE_ENDPOINT, PROVIDERS } from "./pricing.server";
import { ChatError, settleCharge } from "./chat.server";
import { enforceRateLimit } from "./rate-limit.server";
import { log } from "./logging.server";
import { recordUsage } from "./usage.server";

type Client = SupabaseClient<Database>;

const CONFIG = {
  bucket: "chat-images",
  minBalanceUsd: MIN_IMAGE_PRICE,
  maxPromptLength: 4_000,
  titleLength: 60,
  timeoutMs: 180_000,
  signedUrlSeconds: 60 * 60,
} as const;

export interface GenerateImageInput {
  conversationId: string | null;
  prompt: string;
  imageModelId: string;
}

export interface GenerateImageResult {
  conversationId: string;
  userMessageId: string;
  assistantMessage: { id: string; content: string; created_at: string; imagePath: string };
  signedUrl: string;
  balance: number;
  cost: number;
}

interface ImageResponse {
  data?: { b64_json?: string }[];
  error?: { message?: string; code?: string };
}

/**
 * Request body differs per model family: OpenAI image models take `prompt`,
 * Gemini image models take chat `messages` plus `modalities`.
 */
function buildBody(model: ImageModelConfig, prompt: string): Record<string, unknown> {
  if (model.wire === "gemini") {
    return {
      model: model.remoteModel,
      messages: [{ role: "user", content: prompt }],
      modalities: ["image", "text"],
    };
  }
  return {
    model: model.remoteModel,
    prompt,
    size: model.size,
    quality: model.quality,
    n: 1,
  };
}

/** Calls the gateway and returns the raw PNG bytes. */
async function generatePng(model: ImageModelConfig, prompt: string): Promise<Uint8Array> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new ChatError("Image generation isn't available right now.", 503);

  let response: Response;
  try {
    response = await fetch(IMAGE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildBody(model, prompt)),
      signal: AbortSignal.timeout(CONFIG.timeoutMs),
    });

  } catch {
    throw new ChatError("The image took too long to generate. Please try again.", 504);
  }

  if (response.status === 429) {
    throw new ChatError("Image generation is busy right now. Please try again in a moment.", 429);
  }
  if (response.status === 402) {
    throw new ChatError("AI service credits are exhausted. Please contact support.", 402);
  }

  let json: ImageResponse;
  try {
    json = (await response.json()) as ImageResponse;
  } catch {
    throw new ChatError("The image service returned an unreadable response. Please try again.", 502);
  }

  const code = json.error?.code ?? "";
  if (code === "content_policy_violation" || code === "moderation_blocked") {
    throw new ChatError(
      "That prompt was rejected by the safety filter. Try describing the image differently.",
      400,
    );
  }
  if (!response.ok || json.error) {
    throw new ChatError("The image couldn't be generated. Please try a different prompt.", 502);
  }

  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new ChatError("The image service returned no image. Please try again.", 502);

  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Handles one image turn end to end: generate, store, persist, charge. */
export async function generateImageTurn(
  supabase: Client,
  userId: string,
  input: GenerateImageInput,
  meta: { requestId: string; endpoint: string },
): Promise<GenerateImageResult> {
  const ctx = { ...meta, userId };

  const prompt = input.prompt.trim();
  if (!prompt) throw new ChatError("Describe the image you'd like to create.");
  if (prompt.length > CONFIG.maxPromptLength) throw new ChatError("That prompt is too long.");

  // The client only sends an id — the model, its wire format and its price are
  // all resolved here so a tampered request can't pick a cheaper price.
  const model = getImageModel(input.imageModelId);
  if (!model) throw new ChatError("That image model isn't available.", 400);
  const apiCost = IMAGE_API_COSTS[model.id] ?? model.pricePerImage / 2;

  await enforceRateLimit(userId, "chatBurst");
  await enforceRateLimit(userId, "chat");

  if (input.conversationId) {
    const { data: owned } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", input.conversationId)
      .maybeSingle();
    if (!owned) throw new ChatError("Conversation not found.", 404);
  }

  // Image generation is premium only — it never touches the free allowance.
  const { data: wallet } = await supabaseAdmin
    .from("wallets")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();
  if (!wallet || Number(wallet.balance) < model.pricePerImage) {
    throw new ChatError(
      `Not enough credits to generate an image with ${model.label}. Please recharge your wallet on the Credits page.`,
      402,
    );
  }



  const startedAt = Date.now();
  const bytes = await generatePng(model, prompt);
  log.info("image.latency", { ...ctx, model: model.id, latencyMs: Date.now() - startedAt });


  const path = `${userId}/${crypto.randomUUID()}.png`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from(CONFIG.bucket)
    .upload(path, bytes, { contentType: "image/png", upsert: false });
  if (uploadError) {
    log.error("image.upload", ctx, uploadError.message);
    throw new ChatError("Couldn't save the generated image. Please try again.", 500);
  }

  let conversationId = input.conversationId;
  if (!conversationId) {
    const { data, error } = await supabase
      .from("conversations")
      .insert({ user_id: userId, title: prompt.slice(0, CONFIG.titleLength) })
      .select("id")
      .single();
    if (error) throw new ChatError("Couldn't start the conversation. Please try again.", 500);
    conversationId = data.id;
  }

  // Billed and ledgered before the transcript is written: the image already
  // exists, so its usage record must survive a failed message write or the
  // user deleting the chat mid-generation.
  const charge = model.pricePerImage;
  const balance = await settleCharge(userId, charge, ctx);

  await recordUsage(
    {
      user_id: userId,
      provider: PROVIDERS[model.provider].label,
      model: `${model.label} (image)`,
      conversation_id: conversationId,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      cache_read_tokens: 0,
      api_cost: apiCost,
      platform_markup: round6(charge - apiCost),
      final_cost: charge,
    },
    ctx,
  );

  const askedAt = new Date();
  const answeredAt = new Date(askedAt.getTime() + 1);

  const { data: written, error: writeError } = await supabase
    .from("messages")
    .insert([
      {
        conversation_id: conversationId,
        role: "user",
        content: prompt,
        kind: "text",
        created_at: askedAt.toISOString(),
      },
      {
        conversation_id: conversationId,
        role: "assistant",
        content: prompt,
        kind: "image",
        image_url: path,
        created_at: answeredAt.toISOString(),
      },
    ])
    .select("id, role, content, created_at, image_url");
  if (writeError || !written || written.length !== 2) {
    throw new ChatError("Couldn't save the image. Please try again.", 500);
  }

  const userMessage = written.find((m) => m.role === "user")!;
  const assistantRow = written.find((m) => m.role === "assistant")!;

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);


  const signedUrl = await signImagePath(path);

  return {
    conversationId,
    userMessageId: userMessage.id,
    assistantMessage: {
      id: assistantRow.id,
      content: assistantRow.content,
      created_at: assistantRow.created_at,
      imagePath: path,
    },
    signedUrl,
    balance,
    cost: charge,
  };
}

/** Short-lived read URL for one stored image. */
export async function signImagePath(path: string): Promise<string> {
  const { data, error } = await supabaseAdmin.storage
    .from(CONFIG.bucket)
    .createSignedUrl(path, CONFIG.signedUrlSeconds);
  if (error || !data?.signedUrl) throw new ChatError("Couldn't load the image.", 500);
  return data.signedUrl;
}

/** Signs several paths at once, skipping any that don't belong to the caller. */
export async function signImagePathsForUser(
  userId: string,
  paths: string[],
): Promise<Record<string, string>> {
  const owned = paths.filter((p) => p.startsWith(`${userId}/`));
  if (owned.length === 0) return {};

  const { data, error } = await supabaseAdmin.storage
    .from(CONFIG.bucket)
    .createSignedUrls(owned, CONFIG.signedUrlSeconds);
  if (error || !data) return {};

  const result: Record<string, string> = {};
  for (const entry of data) {
    if (entry.path && entry.signedUrl) result[entry.path] = entry.signedUrl;
  }
  return result;
}
