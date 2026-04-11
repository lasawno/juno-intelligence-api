/**
 * Juno Intelligence Core — Full Client
 *
 * Drop this file into your JunoTalk `server/` folder.
 *
 * Only 2 env vars needed on JunoTalk:
 *   JUNO_CORE_URL=https://junointelligencecore.replit.app
 *   JUNOCORE_API_KEY=<your API key from Intelligence Core>
 *
 * Usage in JunoTalk startup:
 *   import { connectToCore, startHeartbeat, isEngineOffloaded } from './juno-core-client';
 *   const connection = await connectToCore();
 *   startHeartbeat();
 *
 *   // Before running any local engine, check if Core owns it:
 *   if (isEngineOffloaded("ai-gateway")) {
 *     // Use coreGatewayChat() instead of local ai-gateway
 *   }
 */

const CORE_URL = () => process.env.JUNO_CORE_URL?.replace(/\/+$/, "") || "";
const API_KEY = () => process.env.JUNOCORE_API_KEY || "";
const TIMEOUT_MS = 8000;
const COMPUTE_TIMEOUT_MS = 30000;

function authHeaders(): Record<string, string> {
  const key = API_KEY();
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
}

async function coreFetch<T>(path: string): Promise<T | null> {
  const base = CORE_URL();
  if (!base) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(`${base}/api${path}`, {
      signal: controller.signal,
      headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function corePost<T>(path: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<T | null> {
  const base = CORE_URL();
  if (!base) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${base}/api${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.error(`[JunoCore] POST ${path} failed: ${resp.status} ${resp.statusText}`);
      return null;
    }
    return (await resp.json()) as T;
  } catch (err) {
    console.error(`[JunoCore] POST ${path} error:`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function coreDelete<T>(path: string): Promise<T | null> {
  const base = CORE_URL();
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${base}/api${path}`, {
      method: "DELETE",
      signal: controller.signal,
      headers: authHeaders(),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch { return null; } finally { clearTimeout(timer); }
}

export function isCoreConfigured(): boolean {
  return !!CORE_URL();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Engine Offloading — prevents duplicate engine execution
// ═══════════════════════════════════════════════════════════════════════════════

let _offloadedEngines: Set<string> = new Set();

export function isEngineOffloaded(engineName: string): boolean {
  return _offloadedEngines.has(engineName);
}

export function getOffloadedEngines(): string[] {
  return Array.from(_offloadedEngines);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Connection & Heartbeat
// ═══════════════════════════════════════════════════════════════════════════════

interface ConnectResponse {
  status: string;
  offloadedEngines?: string[];
  engineManifest?: Array<{ name: string; description: string; endpoints: string[]; status: string }>;
  availableEndpoints?: Record<string, string>;
}

export async function connectToCore(options?: {
  version?: string;
  activeModules?: string[];
  activeEngines?: Record<string, boolean>;
  voiceAi?: Record<string, unknown>;
  llmProviders?: string[];
  featureFlags?: Record<string, boolean>;
  appUrl?: string;
}): Promise<ConnectResponse | null> {
  const result = await corePost<ConnectResponse>("/junotalk/connect", {
    appUrl: options?.appUrl || "https://junotalk.app",
    version: options?.version || "3.2.0",
    activeModules: options?.activeModules || [
      "reasoning-engine",
      "personality-engine",
      "intelligence-layer",
      "ai-gateway",
      "voice-ai",
      "translation",
      "juno-agent-t1",
    ],
    activeEngines: options?.activeEngines || {
      reasoning: true,
      personality: true,
      intelligenceLayer: true,
      voiceAi: true,
    },
    voiceAi: options?.voiceAi || { whisper: true, edgeTts: true, piperTts: true },
    llmProviders: options?.llmProviders || ["groq", "openai", "gemini"],
    featureFlags: options?.featureFlags || {
      conversational_ai: true,
      voice_translation: true,
      tts_enabled: true,
    },
  });

  if (result) {
    console.log(`[JunoCore] Connected: ${result.status}`);
    if (result.offloadedEngines) {
      _offloadedEngines = new Set(result.offloadedEngines);
      console.log(`[JunoCore] Offloaded engines (${_offloadedEngines.size}): ${result.offloadedEngines.join(", ")}`);
      console.log(`[JunoCore] >> DISABLE local copies of these engines to avoid duplicate execution`);
    }
  }

  return result;
}

export async function sendHeartbeat(stats?: Record<string, unknown>): Promise<void> {
  await corePost("/junotalk/heartbeat", { stats: stats || {} });
}

export async function syncState(update: {
  activeModules?: string[];
  activeEngines?: Record<string, boolean>;
  voiceAi?: Record<string, unknown>;
  llmProviders?: string[];
  featureFlags?: Record<string, boolean>;
  stats?: Record<string, unknown>;
  customData?: Record<string, unknown>;
}): Promise<void> {
  await corePost("/junotalk/sync", update);
}

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

export function startHeartbeat(intervalMs = 120_000): void {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => sendHeartbeat(), intervalMs);
  console.log(`[JunoCore] Heartbeat started (every ${intervalMs / 1000}s)`);
}

export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Data Fetch (read-only, no auth required)
// ═══════════════════════════════════════════════════════════════════════════════

export async function fetchEnrichment(
  message: string,
  conversationHistory?: Array<{ role: string; content: string }>,
  task?: string,
): Promise<Record<string, unknown> | null> {
  return corePost<Record<string, unknown>>("/reasoning/enrich", {
    message,
    conversation_history: conversationHistory || [],
    task: task || "chat",
  });
}

export async function fetchConfig<T = unknown>(name: string): Promise<T | null> {
  return coreFetch<T>(`/config/${name}`);
}

export async function fetchModelStack<T = unknown>(): Promise<T | null> {
  return coreFetch<T>("/models/stack");
}

export async function fetchModelRegistry<T = unknown>(): Promise<T | null> {
  return coreFetch<T>("/models/registry");
}

export async function fetchModelSelect<T = unknown>(task: string): Promise<T | null> {
  return coreFetch<T>(`/models/select?task=${encodeURIComponent(task)}`);
}

export async function fetchKnowledgeCollection<T = unknown>(collection: string): Promise<T | null> {
  return coreFetch<T>(`/knowledge/${collection}`);
}

export async function fetchKnowledgeQuery<T = unknown>(query: string): Promise<T | null> {
  return coreFetch<T>(`/knowledge/query?q=${encodeURIComponent(query)}`);
}

export async function fetchKnowledgeBrain<T = unknown>(): Promise<T | null> {
  return coreFetch<T>("/knowledge/brain");
}

export async function fetchKnowledgeVector<T = unknown>(): Promise<T | null> {
  return coreFetch<T>("/knowledge/vector");
}

export async function fetchKnowledgeSummary(): Promise<Record<string, number> | null> {
  const resp = await coreFetch<{ collections: Record<string, number> }>("/knowledge");
  return resp?.collections ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Compute API — call Intelligence Core engines instead of running locally
// ═══════════════════════════════════════════════════════════════════════════════

// ── AI Gateway (replaces local ai-gateway) ──

export async function coreGatewayRequest(request: Record<string, unknown>) {
  return corePost("/compute/gateway/request", request, COMPUTE_TIMEOUT_MS);
}

export async function coreGatewayChat(request: {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  provider?: string;
  temperature?: number;
  max_tokens?: number;
}) {
  return corePost("/compute/gateway/chat", request, COMPUTE_TIMEOUT_MS);
}

export async function coreGatewayTranslate(text: string, sourceLang: string, targetLang: string, options?: Record<string, unknown>) {
  return corePost("/compute/gateway/translate", { text, sourceLang, targetLang, options }, COMPUTE_TIMEOUT_MS);
}

export async function coreGatewayHealth() {
  return coreFetch("/compute/gateway/health");
}

// ── Juno Orb (replaces local juno-orb) ──

export async function coreOrbAsk(request: {
  userId: string;
  message: string;
  context?: Record<string, unknown>;
}) {
  return corePost("/compute/orb/ask", request, COMPUTE_TIMEOUT_MS);
}

export async function coreOrbClearSession(userId: string) {
  return coreDelete(`/compute/orb/session/${encodeURIComponent(userId)}`);
}

export async function coreOrbStats() {
  return coreFetch("/compute/orb/stats");
}

// ── Reasoning Engine (replaces local reasoning-engine) ──

export async function coreReasoningAnalyze(text: string) {
  return corePost("/compute/reasoning/analyze", { text });
}

export async function coreReasoningStats() {
  return coreFetch("/compute/reasoning/stats");
}

// ── Intelligence Layer (replaces local juno-intelligence-layer) ──

export async function coreIntelligenceEvaluate(request: Record<string, unknown>) {
  return corePost("/compute/intelligence/evaluate", request, COMPUTE_TIMEOUT_MS);
}

export async function coreIntelligenceConfig() {
  return coreFetch("/compute/intelligence/config");
}

// ── Personality Engine (replaces local personality-engine) ──

export async function corePersonalityContext(intent?: string) {
  return corePost("/compute/personality/context", { intent });
}

export async function corePersonalityStats() {
  return coreFetch("/compute/personality/stats");
}

// ── Safety (replaces local juno-safety) ──

export async function coreSafetyCheck(text: string) {
  return corePost<{ safety: unknown; chat: { ok: boolean; reason?: string } }>("/compute/safety/check", { text });
}

export async function coreSafetyBoundary(text: string) {
  return corePost("/compute/safety/boundary", { text });
}

export async function coreSafetyStats() {
  return coreFetch("/compute/safety/stats");
}

// ── Embedding Service (replaces local embedding-service) ──

export async function coreEmbed(text: string) {
  return corePost<{ vector: number[]; dimensions: number }>("/compute/embed", { text }, COMPUTE_TIMEOUT_MS);
}

export async function coreEmbedBatch(texts: string[]) {
  return corePost<{ vectors: (number[] | null)[]; count: number }>("/compute/embed/batch", { texts }, COMPUTE_TIMEOUT_MS);
}

export async function coreEmbedSearch(text: string, sourceLang: string, targetLang: string, limit?: number) {
  return corePost("/compute/embed/search", { text, sourceLang, targetLang, limit }, COMPUTE_TIMEOUT_MS);
}

export async function coreEmbedStats() {
  return coreFetch("/compute/embed/stats");
}

// ── Recall (replaces local recall-orchestrator + agent-recall) ──

export async function coreRecallOrchestrate(request: Record<string, unknown>) {
  return corePost("/compute/recall/orchestrate", request, COMPUTE_TIMEOUT_MS);
}

export async function coreRecallTranslation(text: string, sourceLang: string, targetLang: string) {
  return corePost("/compute/recall/translation", { text, sourceLang, targetLang });
}

export async function coreRecallStats() {
  return coreFetch("/compute/recall/stats");
}

// ── Knowledge (replaces local juno-knowledge + knowledge-sync) ──

export async function coreKnowledgeSearch(query: string, limit?: number, minRelevance?: number) {
  return corePost("/compute/knowledge/search", { query, limit, minRelevance });
}

export async function coreKnowledgeAnswer(query: string) {
  return corePost("/compute/knowledge/answer", { query });
}

export async function coreKnowledgeSync(force = false) {
  return corePost("/compute/knowledge/sync", { force }, COMPUTE_TIMEOUT_MS);
}

export async function coreKnowledgeOsint(query: string, limit?: number) {
  return corePost("/compute/knowledge/osint", { query, limit });
}

export async function coreKnowledgeSyncStats() {
  return coreFetch("/compute/knowledge/sync-stats");
}

// ── Vision (replaces local juno-vision-hub + vision-knowledge) ──

export async function coreVisionAnalyze(request: Record<string, unknown>) {
  return corePost("/compute/vision/analyze", request, COMPUTE_TIMEOUT_MS);
}

export async function coreVisionCompose(objects: unknown[], lang?: string, options?: Record<string, unknown>) {
  return corePost("/compute/vision/compose", { objects, lang, options });
}

// ── VRisk (replaces local juno-vrisk) ──

export async function coreVriskScan(code: string, language?: string, options?: Record<string, unknown>) {
  return corePost("/compute/vrisk/scan", { code, language, options }, COMPUTE_TIMEOUT_MS);
}

export async function coreVriskStatus() {
  return coreFetch("/compute/vrisk/status");
}

export async function coreVriskRules() {
  return coreFetch("/compute/vrisk/rules");
}

// ── Cache Intelligence (replaces local juno-cache-intelligence) ──

export async function coreCacheDecide(request: Record<string, unknown>) {
  return corePost("/compute/cache/decide", request);
}

// ── Adaptive Policy (replaces local juno-adaptive-policy) ──

export async function corePolicyEvaluate(request: Record<string, unknown>) {
  return corePost("/compute/policy/evaluate", request, COMPUTE_TIMEOUT_MS);
}

export async function corePolicyConfig() {
  return coreFetch("/compute/policy/config");
}

// ── Learner (replaces local juno-learner + open-source-learner) ──

export async function coreLearnerExtract(text: string) {
  return corePost("/compute/learner/extract", { text }, COMPUTE_TIMEOUT_MS);
}

export async function coreLearnerRecall(request: Record<string, unknown>) {
  return corePost("/compute/learner/recall", request);
}

export async function coreLearnerCycle() {
  return corePost("/compute/learner/cycle", {}, COMPUTE_TIMEOUT_MS);
}

// ── Arena LLM (replaces local arena-llm) ──

export async function coreArenaConfig() {
  return coreFetch("/compute/arena/config");
}

export async function coreArenaSelect(task: string) {
  return corePost("/compute/arena/select", { task });
}

// ── OSINT Pipeline (replaces local osint-pipeline) ──

export async function coreOsintRun(options?: Record<string, unknown>) {
  return corePost("/compute/osint/run", options || {}, COMPUTE_TIMEOUT_MS);
}

export async function coreOsintSources() {
  return coreFetch("/compute/osint/sources");
}

// ── Voice Config (Edge TTS voice selection) ──

export async function coreVoiceSelect(persona: string, language: string) {
  return corePost<{
    voice: string;
    rate: string;
    pitch: string;
    style?: string;
    persona: string;
    language: string;
    personaDescription?: string;
    personaTone?: string;
    personaTraits?: string[];
  }>("/compute/voice/select", { persona, language });
}

export async function coreVoiceConfig() {
  return coreFetch("/compute/voice/config");
}

// ── Obsidian Vault (behavioral data) ──

export async function coreVaultPersonas() {
  return coreFetch<{ personas: Array<{ persona: string; tone: string; description: string; traits: string[] }> }>("/compute/vault/personas");
}

export async function coreVaultUserContext() {
  return coreFetch("/compute/vault/user-context");
}
