import { Router } from "express";

  const INTELLIGENCE_CORE_URL = process.env.INTELLIGENCE_CORE_URL || "https://junointelligencecore.replit.app";

  export const healthRouter = Router();

  healthRouter.get("/", async (_req, res) => {
    let coreStatus = "unknown";
    let coreLatency = 0;

    try {
      const start = Date.now();
      const resp = await fetch(`${INTELLIGENCE_CORE_URL}/api/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      coreLatency = Date.now() - start;
      coreStatus = resp.ok ? "connected" : "error";
    } catch {
      coreStatus = "unreachable";
    }

    res.json({
      status: "ok",
      service: "juno-intelligence-api",
      version: "2.0.0",
      timestamp: new Date().toISOString(),
      intelligence_core: {
        status: coreStatus,
        url: INTELLIGENCE_CORE_URL,
        latency_ms: coreLatency,
      },
      providers: {
        groq: !!process.env.GROQ_API_KEY,
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        openrouter: !!process.env.OPENROUTER_API_KEY,
      },
    });
  });
  