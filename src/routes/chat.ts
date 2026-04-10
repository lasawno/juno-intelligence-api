import { Router, Request, Response } from "express";
  import Groq from "groq-sdk";

  const INTELLIGENCE_CORE_URL = process.env.INTELLIGENCE_CORE_URL || "https://junointelligencecore.replit.app";
  const TIMEOUT_MS = 10000;

  interface ReasoningResponse {
    messages: Array<{ role: string; content: string }>;
    model: { id: string; provider: string; temperature: number; max_tokens: number };
    fallback_chain: string[];
    detected_intents: string[];
    personality_profile: string;
    knowledge_layers: Array<{ layer: string; confidence: number }>;
  }

  async function getReasoningPrompt(
    message: string,
    history?: Array<{ role: string; content: string }>,
  ): Promise<ReasoningResponse | null> {
    try {
      const resp = await fetch(`${INTELLIGENCE_CORE_URL}/api/reasoning/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ message, conversation_history: history, task: "chat" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resp.ok) return null;
      return (await resp.json()) as ReasoningResponse;
    } catch {
      return null;
    }
  }

  function getGroqClient(): Groq | null {
    const key = process.env.GROQ_API_KEY;
    if (!key) return null;
    return new Groq({ apiKey: key });
  }

  export const chatRouter = Router();

  chatRouter.post("/chat", async (req: Request, res: Response) => {
    const { message, language, conversation_history } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }

    const groq = getGroqClient();
    if (!groq) {
      return res.status(503).json({
        error: "No LLM provider configured",
        note: "Set GROQ_API_KEY environment variable",
      });
    }

    try {
      const reasoning = await getReasoningPrompt(message, conversation_history);

      let messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      let modelId = "llama-3.3-70b-versatile";
      let temperature = 0.75;
      let maxTokens = 1200;

      if (reasoning) {
        messages = reasoning.messages.map((m) => ({
          role: m.role as "system" | "user" | "assistant",
          content: m.content,
        }));
        modelId = "llama-3.3-70b-versatile";
        temperature = reasoning.model.temperature;
        maxTokens = reasoning.model.max_tokens;
      } else {
        messages = [
          {
            role: "system",
            content: "You are Juno, a warm and intelligent AI assistant. Be helpful, concise, and accurate.",
          },
          { role: "user", content: message },
        ];
      }

      const completion = await groq.chat.completions.create({
        model: modelId,
        messages,
        temperature,
        max_tokens: maxTokens,
      });

      const reply = completion.choices[0]?.message?.content || "";

      res.json({
        reply,
        language: language || "en",
        model: modelId,
        reasoning_engine: !!reasoning,
        detected_intents: reasoning?.detected_intents || [],
        personality_profile: reasoning?.personality_profile || "default",
        knowledge_layers: reasoning?.knowledge_layers || [],
      });
    } catch (err: any) {
      if (err?.status === 429) {
        return res.status(429).json({ error: "Rate limited by LLM provider. Try again shortly." });
      }

      console.error("Chat error:", err?.message || err);
      res.status(500).json({
        error: "Failed to generate response",
        details: err?.message || "Unknown error",
      });
    }
  });

  chatRouter.get("/reasoning/capabilities", async (_req: Request, res: Response) => {
    try {
      const resp = await fetch(`${INTELLIGENCE_CORE_URL}/api/reasoning/capabilities`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) throw new Error("Core unreachable");
      const data = await resp.json();
      res.json({ connected: true, core_url: INTELLIGENCE_CORE_URL, ...data as object });
    } catch {
      res.json({ connected: false, core_url: INTELLIGENCE_CORE_URL, error: "Intelligence Core unreachable" });
    }
  });
  