import { Router, Request, Response } from "express";
  import Groq from "groq-sdk";

  const INTELLIGENCE_CORE_URL = process.env.INTELLIGENCE_CORE_URL || "https://junointelligencecore.replit.app";

  interface EnrichResponse {
    persona: { name: string; voice: string; personality: string };
    personality: Record<string, unknown>;
    reasoning: Record<string, unknown>;
    intelligence_layer: Record<string, unknown>;
    knowledge: {
      query: string;
      context: Array<{ layer: string; confidence: number; results: Array<{ title: string; content: string }> }>;
      ranked_layers: Array<{ layer: string; confidence: number }>;
    };
    model: { id: string; provider: string; temperature: number; max_tokens: number };
    fallback_chain: string[];
    feature_flags: Record<string, boolean>;
  }

  async function fetchEnrichment(message: string, history?: Array<{ role: string; content: string }>): Promise<EnrichResponse | null> {
    try {
      const resp = await fetch(`${INTELLIGENCE_CORE_URL}/api/reasoning/enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, conversation_history: history, task: "chat" }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return null;
      return (await resp.json()) as EnrichResponse;
    } catch {
      return null;
    }
  }

  function buildPromptFromEnrichment(data: EnrichResponse, message: string): {
    messages: Array<{ role: "system" | "user"; content: string }>;
    temperature: number;
    maxTokens: number;
  } {
    const parts: string[] = [];
    parts.push(`You are ${data.persona.name}. ${data.persona.personality}`);
    parts.push(`Voice: ${data.persona.voice}`);

    const knowledgeText = data.knowledge.context
      .flatMap((layer) => layer.results.map((r) => `[${layer.layer.toUpperCase()}] ${r.title}: ${r.content}`))
      .join("\n");
    if (knowledgeText) {
      parts.push(`\nRelevant Knowledge:\n${knowledgeText}`);
    }

    parts.push("\nBe helpful, concise, and accurate. Cite knowledge sources when available.");

    return {
      messages: [
        { role: "system", content: parts.join("\n") },
        { role: "user", content: message },
      ],
      temperature: data.model.temperature,
      maxTokens: data.model.max_tokens,
    };
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
      return res.status(503).json({ error: "No LLM provider configured. Set GROQ_API_KEY." });
    }

    try {
      const enrichment = await fetchEnrichment(message, conversation_history);

      let messages: Array<{ role: "system" | "user"; content: string }>;
      let temperature = 0.75;
      let maxTokens = 1200;

      if (enrichment) {
        const prompt = buildPromptFromEnrichment(enrichment, message);
        messages = prompt.messages;
        temperature = prompt.temperature;
        maxTokens = prompt.maxTokens;
      } else {
        messages = [
          { role: "system", content: "You are Juno, a warm and intelligent AI assistant." },
          { role: "user", content: message },
        ];
      }

      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages,
        temperature,
        max_tokens: maxTokens,
      });

      res.json({
        reply: completion.choices[0]?.message?.content || "",
        language: language || "en",
        model: "llama-3.3-70b-versatile",
        enriched: !!enrichment,
        knowledge_layers: enrichment?.knowledge.ranked_layers || [],
      });
    } catch (err: any) {
      if (err?.status === 429) {
        return res.status(429).json({ error: "Rate limited. Try again shortly." });
      }
      console.error("Chat error:", err?.message || err);
      res.status(500).json({ error: "Failed to generate response" });
    }
  });
  