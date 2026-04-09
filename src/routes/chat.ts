import { Router, Request, Response } from "express";

export const chatRouter = Router();

chatRouter.post("/chat", async (req: Request, res: Response) => {
  const { message, language } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  res.json({
    reply: null,
    language: language || "en",
    note: "LLM provider not yet wired up",
  });
});
