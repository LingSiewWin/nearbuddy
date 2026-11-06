// Guarantor routes for the solver. The issuer calls /guarantee inside its card-authorization
// window and gets a solver-signed cert back; /pull executes the on-chain pull (signed by the
// vault contract via Chain Signatures); /settle_pulls reports outcomes to the contract in one tx,
// which pays the issuer from the reserve for every failed pull.
import { type Account, KeyPair, teraToGas } from "near-api-js";
import type { Hex } from "viem";
import { type GuaranteeCert, type PullSettlement, type SignedCert, signCert } from "../../protocol/src/cert.ts";
import { CONTRACT, loadKey, view } from "../../protocol/src/chain.ts";
import { b64 } from "../../protocol/src/index.ts";
import { Ledger } from "./ledger.ts";
import { CHAIN_ID, observe, type PullResult, pull, USDC } from "./pull.ts";

export interface IssuerReserve {
  solver: string;
  reserved: string;
  paid_out: string;
  fees_accrued: string;
  pulls_ok: number;
  pulls_failed: number;
}
export interface PullReport {
  settled: number;
  paid_out: string;
  fees_accrued: string;
  rejected: { index: number; reason: string }[];
}

/// yoctoNEAR the issuer is paid per failed pull. ponytail: flat; price it off the USDC amount later.
const PAYOUT_YOCTO = BigInt(process.env.GUARANTEE_PAYOUT_YOCTO ?? (10n ** 22n).toString()); // 0.01 NEAR
const CERT_TTL_MS = Number(process.env.GUARANTEE_TTL_MS ?? 10 * 60_000);
const OBS_TTL_MS = 2_000;

type Open = { signed: SignedCert; payoutTo: Hex; result?: PullResult; at: number };

export class Guarantor {
  readonly ledger = new Ledger();
  private open = new Map<string, Open>(); // cert id (solver:nonce) -> state
  private toSettle: PullSettlement[] = [];
  private nonce = BigInt(Date.now()) * 1000n;
  private obs = new Map<string, { at: number; v: { balance: bigint; allowance: bigint } }>();
  private kp: KeyPair;
  readonly pkB64: string;

  constructor(
    private solver: Account,
    private solverId: string,
  ) {
    this.kp = KeyPair.fromString(loadKey(solverId));
    this.pkB64 = b64.enc(this.kp.getPublicKey().data);
  }

  private async observed(wallet: Hex) {
    const k = wallet.toLowerCase();
    const hit = this.obs.get(k);
    if (hit && Date.now() - hit.at < OBS_TTL_MS) return hit.v;
    const v = await observe(wallet);
    this.obs.set(k, { at: Date.now(), v });
    return v;
  }

  /** Issue a cert or refuse. The whole point is that this is fast and backed by on-chain reserve. */
  async guarantee(
    issuer: string,
    wallet: Hex,
    amount: bigint,
    payoutTo: Hex,
  ): Promise<{ ok: true; signed: SignedCert; ms: number } | { ok: false; reason: string; ms: number }> {
    const t0 = Date.now();
    const ir = await view<IssuerReserve | null>("get_issuer", { issuer });
    if (!ir || ir.solver !== this.solverId)
      return { ok: false, reason: "no reserve for this issuer", ms: Date.now() - t0 };
    const carried = [...this.open.values()].filter((o) => o.signed.cert.issuer === issuer && !o.result).length;
    if (BigInt(ir.reserved) < PAYOUT_YOCTO * BigInt(carried + 1))
      return { ok: false, reason: "issuer reserve exhausted (incl. open certs)", ms: Date.now() - t0 };
    const ob = await this.observed(wallet);
    const nonce = (this.nonce++).toString();
    const id = `${this.solverId}:${nonce}`;
    const r = this.ledger.reserve(id, wallet, amount, ob, Date.now(), CERT_TTL_MS);
    if (typeof r === "string") return { ok: false, reason: r, ms: Date.now() - t0 };
    const cert: GuaranteeCert = {
      solver: this.solverId,
      issuer,
      chain_id: CHAIN_ID,
      wallet: wallet.toLowerCase(),
      token: USDC.toLowerCase(),
      amount: amount.toString(),
      payout: PAYOUT_YOCTO.toString(),
      nonce,
      expires_at: ((BigInt(Date.now()) + BigInt(CERT_TTL_MS)) * 1_000_000n).toString(),
    };
    const signed = signCert(this.kp, cert);
    this.open.set(id, { signed, payoutTo, at: Date.now() });
    return { ok: true, signed, ms: Date.now() - t0 };
  }

  /** Execute the pull for a cert and queue the outcome for settlement. */
  async executePull(id: string): Promise<PullResult & { outcome: PullSettlement["outcome"] }> {
    const o = this.open.get(id);
    if (!o) throw new Error("unknown cert");
    if (o.result) throw new Error("already pulled");
    const c = o.signed.cert;
    const res = await pull(this.solver, c.wallet as Hex, o.payoutTo, BigInt(c.amount));
    o.result = res;
    this.ledger.release(id);
    this.obs.delete(c.wallet.toLowerCase());
    const outcome = res.ok ? { Pulled: { tx_hash: res.txHash! } } : { Failed: { reason: res.reason ?? "unknown" } };
    this.toSettle.push({ signed: o.signed, outcome });
    return { ...res, outcome };
  }

  /** One NEAR tx settles every queued outcome; failed pulls pay the issuer from the reserve. */
  async settle(): Promise<{ txHash: string; report: PullReport; count: number } | null> {
    if (!this.toSettle.length) return null;
    const batch = this.toSettle.splice(0, 200);
    const r = await this.solver.callFunctionRaw({
      contractId: CONTRACT,
      methodName: "settle_pull",
      args: { settlements: batch },
      gas: teraToGas("300"),
    });
    const st = r.status as { SuccessValue?: string };
    if (!st.SuccessValue) {
      this.toSettle.unshift(...batch);
      throw new Error(`settle_pull failed: ${JSON.stringify(r.status)}`);
    }
    const report = JSON.parse(Buffer.from(st.SuccessValue, "base64").toString()) as PullReport;
    for (const s of batch) this.open.delete(`${s.signed.cert.solver}:${s.signed.cert.nonce}`);
    return { txHash: r.transaction.hash as string, report, count: batch.length };
  }

  snapshot() {
    return {
      guarantee_pk: this.pkB64,
      payout_yocto: PAYOUT_YOCTO.toString(),
      ledger: this.ledger.snapshot(),
      open_certs: [...this.open.entries()].map(([id, o]) => ({
        id,
        wallet: o.signed.cert.wallet,
        amount: o.signed.cert.amount,
        pulled: o.result?.ok ?? null,
      })),
      queued_for_settlement: this.toSettle.length,
    };
  }

  /** HTTP dispatch. Returns null when the route is not ours. */
  async route(
    method: string | undefined,
    url: string | undefined,
    body: string,
  ): Promise<{ code: number; body: unknown } | null> {
    if (method === "POST" && url === "/guarantee") {
      const q = JSON.parse(body) as { issuer: string; wallet: Hex; amount: string; payout_to: Hex };
      return { code: 200, body: await this.guarantee(q.issuer, q.wallet, BigInt(q.amount), q.payout_to) };
    }
    if (method === "POST" && url === "/pull") {
      const q = JSON.parse(body) as { id: string };
      return { code: 200, body: await this.executePull(q.id) };
    }
    if (method === "POST" && url === "/settle_pulls")
      return { code: 200, body: (await this.settle()) ?? { nothing: true } };
    if (url === "/guarantor") return { code: 200, body: this.snapshot() };
    return null;
  }
}
