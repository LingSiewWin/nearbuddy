// How a stranger's headline reaches a duel, behind one interface so the contract's next call drops in.
// Deploy 16.1 (today): the text goes to the solver (POST /api/chaos, which relays to its open POST /chaos); the
// solver keeps the text and answers its sha256; the wallet then signs
// `inject_chaos(duel_id, target, kind, payload_hash)` with `min_chaos_deposit` attached (arena/src/duels.rs).
// Deploy 17 puts the headline itself on chain: write a second InjectAdapter whose prepare() needs no solver and
// point ADAPTER at it; the terminal only ever calls price(), prepare() and the wallet's send().

export type InjectInput = { duel_id: string; target: string; text: string };
/** What the adapter reads from the live arena snapshot (/api/arena `contract` and `config`). */
export type Chain = { contract: string; min_chaos_deposit: string };
/** One function call for the wallet to sign. */
export type Call = {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: string;
  deposit: string;
};

/** A service the attack needs is down: the page says so and nothing is signed. */
export class Offline extends Error {}

export interface InjectAdapter {
  /** Shown in help: which contract call this adapter signs. */
  readonly name: string;
  /** Longest headline it accepts. */
  readonly maxChars: number;
  /** What the next attack costs in yoctoNEAR. */
  price(chain: Chain): string;
  /** Off-chain work before signing; throws Offline when a service it needs is down, Error for a refused input. */
  prepare(input: InjectInput, chain: Chain, fetcher?: typeof fetch): Promise<Call>;
}

export const MAX_HEADLINE = 280;
/** inject_chaos `kind` for a headline typed on the web; the spectator bot writes "fake_news/<mode>/<move>". */
export const WEB_KIND = "fake_news/web";
const GAS = "60000000000000"; // 60 Tgas, as the spectator bot attaches

export const chaosDeploy16: InjectAdapter = {
  name: "inject_chaos (deploy 16.1): text held by the solver, its sha256 on chain",
  maxChars: MAX_HEADLINE,
  price: (chain) => chain.min_chaos_deposit,
  async prepare(input, chain, fetcher = fetch) {
    let r: Response;
    try {
      r = await fetcher("/api/chaos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: input.text }),
      });
    } catch {
      throw new Offline("this page's server did not answer");
    }
    const j = (await r.json().catch(() => ({}))) as { payload_hash?: string; error?: string; offline?: boolean };
    if (j.offline) throw new Offline(j.error ?? "solver offline");
    if (!r.ok || !j.payload_hash) throw new Error(j.error ?? `HTTP ${r.status}`);
    return {
      receiverId: chain.contract,
      methodName: "inject_chaos",
      args: { duel_id: input.duel_id, target: input.target, kind: WEB_KIND, payload_hash: j.payload_hash },
      gas: GAS,
      deposit: chain.min_chaos_deposit,
    };
  },
};

/** The adapter the terminal uses. */
export const ADAPTER: InjectAdapter = chaosDeploy16;
