import { Router, Request, Response } from "express";
import Groq from "groq-sdk";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

export const chatRouter = Router();

type Message = { role: "system" | "user" | "assistant"; content: string };

interface ChatBody {
  message?: string;
  messages?: Message[];
  systemPrompt?: string;
  language?: string;
  task?: string;
  temperature?: number;
  maxTokens?: number;
  sessionId?: string;
}

interface TranslateBody {
  text: string;
  targetLang: string;
  sourceLang?: string;
  systemPrompt?: string;
}

async function inferGroq(
  messages: Message[],
  maxTokens: number,
  temperature: number
): Promise<{ text: string; model: string; tokens: number }> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not configured");
  const client = new Groq({ apiKey: key });
  const models = [
    "llama-3.3-70b-versatile",
    "llama-3.1-70b-versatile",
    "llama3-70b-8192",
    "mixtral-8x7b-32768",
  ];
  let last: Error = new Error("no models tried");
  for (const model of models) {
    try {
      const resp = await client.chat.completions.create({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
      });
      const text = resp.choices[0]?.message?.content?.trim();
      if (!text) throw new Error("empty response");
      return { text, model, tokens: resp.usage?.total_tokens ?? 0 };
    } catch (e: any) {
      last = e;
    }
  }
  throw last;
}

async function inferOpenRouter(
  messages: Message[],
  maxTokens: number,
  temperature: number
): Promise<{ text: string; model: string; tokens: number }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not configured");
  const client = new OpenAI({ apiKey: key, baseURL: "https://openrouter.ai/api/v1" });
  const models = [
    "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemma-3-27b-it:free",
    "mistralai/mistral-7b-instruct:free",
    "qwen/qwen3-30b-a3b:free",
  ];
  let last: Error = new Error("no models tried");
  for (const model of models) {
    try {
      const resp = await client.chat.completions.create({ model, messages, max_tokens: maxTokens, temperature });
      const text = resp.choices[0]?.message?.content?.trim();
      if (!text) throw new Error("empty response");
      return { text, model, tokens: resp.usage?.total_tokens ?? 0 };
    } catch (e: any) {
      last = e;
    }
  }
  throw last;
}

async function inferAnthropic(
  messages: Message[],
  systemContent: string,
  maxTokens: number,
  temperature: number
): Promise<{ text: string; model: string; tokens: number }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured");
  const client = new Anthropic({ apiKey: key });
  const userMessages = messages.filter((m) => m.role !== "system") as Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  const resp = await client.messages.create({
    model: "claude-3-5-haiku-20241022",
    max_tokens: maxTokens,
    temperature,
    system: systemContent,
    messages: userMessages,
  });
  const text = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
  if (!text) throw new Error("empty response from Anthropic");
  return {
    text,
    model: "claude-3-5-haiku-20241022",
    tokens: resp.usage.input_tokens + resp.usage.output_tokens,
  };
}

async function runInference(
  messages: Message[],
  maxTokens: number,
  temperature: number
): Promise<{ text: string; provider: string; model: string; tokens: number }> {
  const systemContent = messages.find((m) => m.role === "system")?.content ?? "";
  const errors: string[] = [];

  try {
    const r = await inferGroq(messages, maxTokens, temperature);
    return { ...r, provider: "groq" };
  } catch (e: any) {
    errors.push(`groq: ${e.message}`);
    console.warn("[JunoCore] Groq failed:", e.message);
  }

  try {
    const r = await inferOpenRouter(messages, maxTokens, temperature);
    return { ...r, provider: "openrouter" };
  } catch (e: any) {
    errors.push(`openrouter: ${e.message}`);
    console.warn("[JunoCore] OpenRouter failed:", e.message);
  }

  try {
    const r = await inferAnthropic(messages, systemContent, maxTokens, temperature);
    return { ...r, provider: "anthropic" };
  } catch (e: any) {
    errors.push(`anthropic: ${e.message}`);
    console.warn("[JunoCore] Anthropic failed:", e.message);
  }

  throw new Error(`All providers failed: ${errors.join(" | ")}`);
}

chatRouter.post("/chat", async (req: Request, res: Response) => {
  const {
    message,
    messages,
    systemPrompt = "You are Juno, a helpful and empathetic multilingual AI assistant. Be concise and natural.",
    language = "en",
    temperature = 0.7,
    maxTokens = 1024,
  } = req.body as ChatBody;

  if (!message && (!messages || messages.length === 0)) {
    return res.status(400).json({ error: "message or messages is required" });
  }

  let builtMessages: Message[] = messages ?? [];
  if (builtMessages.length === 0) {
    builtMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: message! },
    ];
  } else if (!builtMessages.some((m) => m.role === "system")) {
    builtMessages = [{ role: "system", content: systemPrompt }, ...builtMessages];
  }

  try {
    const result = await runInference(builtMessages, maxTokens, temperature);
    return res.json({
      reply: result.text,
      provider: result.provider,
      model: result.model,
      tokens: result.tokens,
      language,
    });
  } catch (err: any) {
    console.error("[JunoCore/chat] inference error:", err.message);
    return res.status(502).json({ error: "Inference failed", detail: err.message });
  }
});

chatRouter.post("/translate", async (req: Request, res: Response) => {
  const { text, targetLang, sourceLang = "auto", systemPrompt } = req.body as TranslateBody;

  if (!text || !targetLang) {
    return res.status(400).json({ error: "text and targetLang are required" });
  }

  const sys =
    systemPrompt ??
    `You are a world-class interpreter. Translate naturally and idiomatically — how a native speaker would say it in real conversation. Output ONLY the translated text, nothing else.`;

  const from = sourceLang === "auto" ? "the source language" : sourceLang;
  const userMsg = `Translate from ${from} to ${targetLang}:\n\n${text}`;

  const messages: Message[] = [
    { role: "system", content: sys },
    { role: "user", content: userMsg },
  ];

  try {
    const result = await runInference(messages, 512, 0.1);
    return res.json({
      translatedText: result.text,
      provider: result.provider,
      model: result.model,
      sourceLang,
      targetLang,
    });
  } catch (err: any) {
    console.error("[JunoCore/translate] inference error:", err.message);
    return res.status(502).json({ error: "Translation failed", detail: err.message });
  }
});
