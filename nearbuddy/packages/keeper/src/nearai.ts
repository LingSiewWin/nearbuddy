// NEAR AI Cloud for the keeper: the TS twin of agents/nearai.py's paid path plus runner.py's health check, outage
// count and a spend cap. The keeper sends the exact request bytes the contract built, keeps the exact response bytes,
// and fetches the enclave's signature record over `model:sha256(request):sha256(response)`.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const NEAR_AI_BASE = "https://cloud-api.near.ai/v1";

/** USD per token, from GET /v1/models `pricing.prompt` / `pricing.completion`. */
export type Pricing = { prompt: number; completion: number };
export type SigRecord = {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo?: string;
  signature_kind?: string;
};
export type Completion = {
  chatId: string;
  response: Uint8Array;
  usage: { prompt_tokens: number; completion_tokens: number };
};

/** HTTP status of a failed model call; null = no answer (connection error, timeout). */
export class ModelError extends Error {
  constructor(
    msg: string,
    readonly status: number | null,
  ) {
    super(msg);
  }
  /** 5xx or no answer: the model API is failing (runner.py `_model_down`). A 429 is throttling, not an outage. */
  get down(): boolean {
    return this.status === null || this.status >= 500;
  }
}

export class NearAi {
  private readonly base: string;
  constructor(
    private readonly key: string,
    base = NEAR_AI_BASE,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.base = base.replace(/\/$/, "");
  }

  private headers(json = false): Record<string, string> {
    return {
      Authorization: `Bearer ${this.key}`,
      accept: "application/json",
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }
  /** Error text without the key, even when the server echoes it back. */
  private brief(text: string): string {
    return (this.key ? text.split(this.key).join("***") : text).replace(/\s+/g, " ").slice(0, 120);
  }

  private async send(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      return await this.fetchFn(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new ModelError(`${init.method ?? "GET"} ${path}: no answer (${(e as Error).name})`, null);
    }
  }

  /** Health and prices (free): GET /v1/models must answer 200 and list every model; returns their pricing. Throws a
   *  ModelError with one line otherwise, as runner.py `model_health`. */
  async models(want: string[]): Promise<Map<string, Pricing>> {
    const r = await this.send("/models", { headers: this.headers() }, 10_000);
    const text = await r.text();
    if (r.status !== 200) throw new ModelError(`GET /v1/models: HTTP ${r.status} ${this.brief(text)}`, r.status);
    let data: { id: string; pricing?: { prompt?: string; completion?: string } }[];
    try {
      data = (JSON.parse(text) as { data: typeof data }).data;
      if (!Array.isArray(data)) throw new TypeError();
    } catch {
      throw new ModelError(`GET /v1/models: 200 without a data[].id list: ${this.brief(text)}`, 200);
    }
    const out = new Map<string, Pricing>();
    for (const m of data) {
      const prompt = Number(m.pricing?.prompt),
        completion = Number(m.pricing?.completion);
      if (want.includes(m.id) && Number.isFinite(prompt) && Number.isFinite(completion))
        out.set(m.id, { prompt, completion });
    }
    const missing = want.filter((m) => !out.has(m));
    if (missing.length) throw new ModelError(`GET /v1/models: not listed with a price: ${missing.join(", ")}`, 200);
    return out;
  }

  /** POST the exact request bytes; the response bytes come back untouched (the enclave signed them). */
  async complete(body: Uint8Array, timeoutMs = 180_000): Promise<Completion> {
    const r = await this.send(
      "/chat/completions",
      { method: "POST", headers: this.headers(true), body: body as BodyInit },
      timeoutMs,
    );
    const response = new Uint8Array(await r.arrayBuffer());
    if (r.status !== 200) {
      const text = new TextDecoder().decode(response);
      throw new ModelError(`POST /v1/chat/completions: HTTP ${r.status} ${this.brief(text)}`, r.status);
    }
    // fatal: bytes that are not UTF-8 would not survive the reveal's JSON string; refuse them here
    const j = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response)) as {
      id?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (typeof j.id !== "string") throw new ModelError("POST /v1/chat/completions: 200 without an id", 200);
    return {
      chatId: j.id,
      response,
      usage: { prompt_tokens: j.usage?.prompt_tokens ?? 0, completion_tokens: j.usage?.completion_tokens ?? 0 },
    };
  }

  /** The enclave signature record. A model runs on several TEE nodes and the record lives on the one that served the
   *  completion, so a miss is retried (nearai.py `signature`). null after `attempts`. */
  async signature(chatId: string, model: string, attempts = 6, sleep = defaultSleep): Promise<SigRecord | null> {
    const q = new URLSearchParams({ model, signing_algo: "ed25519" });
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await this.send(`/signature/${encodeURIComponent(chatId)}?${q}`, { headers: this.headers() }, 30_000);
        if (r.status === 200) return (await r.json()) as SigRecord;
      } catch (e) {
        if (!(e instanceof ModelError)) throw e;
      }
      if (i < attempts - 1) await sleep(1500 * (i + 1));
    }
    return null;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** Consecutive model calls, per model, that got a 5xx or no answer (runner.py `ModelOutage`). Any answer resets the
 *  model's count; at `limit` the keeper makes no more model calls and stops. `limit` 0 turns it off. */
export class Outage {
  private streak = new Map<string, number>();
  private last = new Map<string, string>();
  constructor(public limit = 3) {}
  answered(model: string) {
    this.streak.set(model, 0);
  }
  failed(model: string, e: ModelError) {
    if (!e.down) return;
    this.streak.set(model, (this.streak.get(model) ?? 0) + 1);
    this.last.set(model, e.message.slice(0, 100));
  }
  /** One line naming the first model at its limit, or null. */
  down(): string | null {
    if (this.limit <= 0) return null;
    for (const [m, n] of this.streak)
      if (n >= this.limit)
        return `model ${m}: ${n} calls in a row failed (5xx or no answer; last: ${this.last.get(m)})`;
    return null;
  }
}

export type SpendRow = {
  ts: number;
  agent: "keeper";
  model: string;
  tokens_in: number;
  tokens_out: number;
  usd: number;
  purpose: string;
  chat_id?: string;
};

/** Spend cap over an append-only jsonl: every billed call is one row; the total is the sum of the file, so a restart
 *  keeps counting. `admit` refuses a call whose worst case would cross the cap. */
export class Budget {
  constructor(
    readonly capUsd: number,
    readonly file: string,
  ) {}
  spent(): number {
    if (!existsSync(this.file)) return 0;
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .reduce((s, l) => s + Number((JSON.parse(l) as SpendRow).usd || 0), 0);
  }
  /** Worst case of one call: every request byte a prompt token (a token is at least one byte) plus max_tokens out. */
  static worst(p: Pricing, requestBytes: number, maxTokens: number): number {
    return requestBytes * p.prompt + maxTokens * p.completion;
  }
  /** null when the call fits under the cap, else the reason it does not. */
  admit(worstUsd: number): string | null {
    const spent = this.spent();
    return spent + worstUsd > this.capUsd
      ? `budget: spent $${spent.toFixed(4)} + worst case $${worstUsd.toFixed(4)} > cap $${this.capUsd}`
      : null;
  }
  record(row: Omit<SpendRow, "ts" | "agent">): SpendRow {
    const full: SpendRow = { ts: Date.now() / 1000, agent: "keeper", ...row };
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(full)}\n`);
    return full;
  }
  static usd(p: Pricing, u: Completion["usage"]): number {
    return u.prompt_tokens * p.prompt + u.completion_tokens * p.completion;
  }
}
