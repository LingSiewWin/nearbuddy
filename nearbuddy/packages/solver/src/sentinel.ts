// Headline sentinel: scores a headline for fabricated or manipulative market news before it reaches a duelist.
// The headline is embedded with Qwen3-Embedding-0.6B on NEAR AI Cloud (POST /v1/embeddings, OpenAI format) and
// scored by the logistic model in sentinel/weights.json, which sentinel/sentinel/eval.py trains and evaluates.
// Not wired into any route yet.
import { readFileSync } from "node:fs";

export interface SentinelModel {
  model: string;
  dim: number;
  bias: number;
  threshold: number;
  weights: number[];
  selftest: { logit: number };
}

export interface Verdict {
  score: number;
  flagged: boolean;
  threshold: number;
}

const NEAR_AI_BASE = process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1";
const WEIGHTS = new URL("../../../sentinel/weights.json", import.meta.url);

export function loadModel(path: URL | string = WEIGHTS): SentinelModel {
  const m = JSON.parse(readFileSync(path, "utf8")) as SentinelModel;
  if (m.weights.length !== m.dim) throw new Error(`sentinel: ${m.weights.length} weights for dim ${m.dim}`);
  return m;
}

let cached: SentinelModel | undefined;
function defaultModel(): SentinelModel {
  cached ??= loadModel();
  return cached;
}

/** Same as clean_text in sentinel/sentinel/corpus.py: links removed, whitespace collapsed. */
export function cleanText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

export async function embed(
  text: string,
  apiKey: string,
  model: string,
  fetchFn: typeof fetch = fetch,
): Promise<number[]> {
  const res = await fetchFn(`${NEAR_AI_BASE}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: cleanText(text) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`sentinel embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { data?: { embedding: number[] }[] };
  const e = body.data?.[0]?.embedding;
  if (!e) throw new Error("sentinel embeddings: no data[0].embedding");
  return e;
}

/** weights . x / |x| + bias */
export function logit(embedding: number[], m: SentinelModel): number {
  if (embedding.length !== m.dim) throw new Error(`sentinel: embedding has ${embedding.length} dims, model ${m.dim}`);
  const norm = Math.hypot(...embedding);
  if (norm === 0) throw new Error("sentinel: zero embedding");
  let z = m.bias;
  for (let i = 0; i < m.dim; i++) z += (m.weights[i]! * embedding[i]!) / norm;
  return z;
}

/** sigmoid(logit), in (0, 1); higher means more likely fabricated or manipulative. */
export function score(embedding: number[], m: SentinelModel): number {
  return 1 / (1 + Math.exp(-logit(embedding, m)));
}

export async function screen(
  text: string,
  opts: { apiKey?: string; model?: SentinelModel; fetchFn?: typeof fetch } = {},
): Promise<Verdict> {
  const apiKey = opts.apiKey ?? process.env.NEAR_AI_API_KEY;
  if (!apiKey) throw new Error("sentinel: NEAR_AI_API_KEY is not set");
  const m = opts.model ?? defaultModel();
  const s = score(await embed(text, apiKey, m.model, opts.fetchFn), m);
  return { score: s, flagged: s > m.threshold, threshold: m.threshold };
}
