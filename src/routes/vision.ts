import { Router, Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import Groq from "groq-sdk";

export const visionRouter = Router();

const LANG_NAMES: Record<string, string> = {
  en: "English",    es: "Spanish",    fr: "French",     de: "German",
  it: "Italian",    pt: "Portuguese", nl: "Dutch",       pl: "Polish",
  cs: "Czech",      ru: "Russian",    ja: "Japanese",    zh: "Chinese",
  ko: "Korean",     ar: "Arabic",     hi: "Hindi",       tr: "Turkish",
  sv: "Swedish",    da: "Danish",     fi: "Finnish",     no: "Norwegian",
  el: "Greek",      he: "Hebrew",     th: "Thai",        vi: "Vietnamese",
  id: "Indonesian", ms: "Malay",      uk: "Ukrainian",   ro: "Romanian",
  hu: "Hungarian",
};
function langName(code: string): string { return LANG_NAMES[code] || code; }

function buildReaderPrompt(
  src: string,
  tgt: string,
  mode: "smart" | "fun",
  userQuestion?: string,
  yoloHints: Array<{ category: string; confidence: number }> = []
): string {
  const yoloCtx = yoloHints.length > 0
    ? `Object type hint (from local detector): "${yoloHints[0].category}" (${Math.round(yoloHints[0].confidence * 100)}% confidence). Use as a category hint only.\n`
    : "";

  const taskLine = userQuestion
    ? `The user asks: "${userQuestion}". Answer based only on what you can see.`
    : `Identify what you see. Focus on any text, logos, or labels visible in the image.`;

  const outputFields =
    `{"brand":"<brand name only (read from image), or null>",` +
    `"label":"<full product name in ${langName(src)}, include brand if visible>",` +
    `"translation":"<product name in ${langName(tgt)}>",` +
    (userQuestion ? `"answer":"<direct answer in ${langName(src)}, max 2 sentences>",` : "") +
    `"sentence":"<${userQuestion ? "concise answer in " + langName(tgt) : (mode === "fun" ? "fun one-liner in " + langName(tgt) : "one helpful sentence in " + langName(tgt))}>",` +
    `"price":"<retail price in USD if you know it, else null>"}`;

  return (
    yoloCtx +
    `\nYour task: ${taskLine}\n` +
    `Read ALL visible text on the product character by character — do not guess or infer.\n` +
    `For beverages (cans, bottles, pouches): the BRAND is usually the largest or most prominent text on the front; the LABEL is the full product name including flavor or variant.\n` +
    `Do not confuse flavor names with brand names.\n` +
    `Extract the EXACT spelling as printed — including capitalization, hyphens, and punctuation.\n` +
    `Do NOT describe what you know about the product — only report what is physically visible in the image.\n` +
    `Respond with ONLY this JSON (no markdown, no extra text):\n` +
    outputFields
  );
}

function parseJSON(raw: string): Record<string, any> {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON found in response`);
  return JSON.parse(match[0]);
}

interface VisionResult {
  brand: string | null;
  label: string;
  translation: string;
  sentence: string;
  answer?: string;
  price: string | null;
  provider: string;
  model: string;
}

async function analyzeWithGroq(
  imageBase64: string,
  mimeType: string,
  prompt: string
): Promise<{ result: VisionResult; provider: string; model: string } | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  try {
    const groq = new Groq({ apiKey: key });
    const resp = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${imageBase64}` },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
      max_tokens: 400,
      temperature: 0.2,
    });
    const raw = resp.choices[0]?.message?.content || "";
    const parsed = parseJSON(raw);
    return {
      result: {
        brand: parsed.brand || null,
        label: parsed.label || "",
        translation: parsed.translation || "",
        sentence: parsed.sentence || "",
        answer: parsed.answer || undefined,
        price: parsed.price || null,
        provider: "groq",
        model: "llama-4-scout-17b",
      },
      provider: "groq",
      model: "llama-4-scout-17b",
    };
  } catch (e: any) {
    console.warn("[CoreVision] Groq vision failed:", e?.message?.slice(0, 80));
    return null;
  }
}

async function analyzeWithClaude(
  imageBase64: string,
  mimeType: string,
  prompt: string
): Promise<{ result: VisionResult; provider: string; model: string } | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const client = new Anthropic({ apiKey: key });
    const supportedMimes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    const safeMime = supportedMimes.includes(mimeType) ? mimeType : "image/jpeg";
    const resp = await client.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: safeMime as any,
                data: imageBase64,
              },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    });
    const raw = (resp.content[0] as any)?.text || "";
    const parsed = parseJSON(raw);
    return {
      result: {
        brand: parsed.brand || null,
        label: parsed.label || "",
        translation: parsed.translation || "",
        sentence: parsed.sentence || "",
        answer: parsed.answer || undefined,
        price: parsed.price || null,
        provider: "anthropic",
        model: "claude-3-5-haiku-20241022",
      },
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
    };
  } catch (e: any) {
    console.warn("[CoreVision] Claude vision failed:", e?.message?.slice(0, 80));
    return null;
  }
}

async function analyzeWithOpenRouter(
  imageBase64: string,
  mimeType: string,
  prompt: string
): Promise<{ result: VisionResult; provider: string; model: string } | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const visionModels = [
    "meta-llama/llama-4-scout:free",
    "google/gemma-3-27b-it:free",
    "qwen/qwen2.5-vl-72b-instruct:free",
  ];
  for (const model of visionModels) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://junotalk.app",
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: `data:${mimeType};base64,${imageBase64}` },
                },
                { type: "text", text: prompt },
              ],
            },
          ],
          max_tokens: 400,
          temperature: 0.2,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) continue;
      const data = await resp.json() as any;
      const raw = data?.choices?.[0]?.message?.content || "";
      if (!raw) continue;
      const parsed = parseJSON(raw);
      return {
        result: {
          brand: parsed.brand || null,
          label: parsed.label || "",
          translation: parsed.translation || "",
          sentence: parsed.sentence || "",
          answer: parsed.answer || undefined,
          price: parsed.price || null,
          provider: "openrouter",
          model,
        },
        provider: "openrouter",
        model,
      };
    } catch {}
  }
  return null;
}

visionRouter.post("/vision", async (req: Request, res: Response) => {
  const {
    imageBase64,
    mimeType = "image/jpeg",
    sourceLang = "en",
    targetLang = "es",
    userQuestion,
    mode = "smart",
    yoloHints = [],
  } = req.body;

  if (!imageBase64) {
    return res.status(400).json({ error: "imageBase64 is required" });
  }

  const prompt = buildReaderPrompt(sourceLang, targetLang, mode, userQuestion, yoloHints);

  // Provider cascade: Groq (free, fast) → OpenRouter → Claude
  const attempt = await analyzeWithGroq(imageBase64, mimeType, prompt)
    ?? await analyzeWithOpenRouter(imageBase64, mimeType, prompt)
    ?? await analyzeWithClaude(imageBase64, mimeType, prompt);

  if (!attempt) {
    return res.status(503).json({ error: "No vision-capable model available in Intelligence Core" });
  }

  return res.json({
    ...attempt.result,
    sourceLang,
    targetLang,
    engine: "core",
  });
});
