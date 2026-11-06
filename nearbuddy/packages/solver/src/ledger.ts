// Reservation ledger for the guarantor layer. Pure, synchronous, no I/O, so it can be tested
// exhaustively. Invariant: for every wallet, sum of open reservations <= min(allowance, balance)
// as last observed. This is what turns "N cards on one wallet" from a race into a queue.
export interface Observed {
  balance: bigint;
  allowance: bigint;
}
export interface Reservation {
  id: string;
  wallet: string;
  amount: bigint;
  expiresAt: number;
}

export class Ledger {
  private open = new Map<string, Reservation>(); // id -> reservation
  private byWallet = new Map<string, bigint>(); // wallet -> sum of open amounts

  reserved(wallet: string): bigint {
    return this.byWallet.get(wallet.toLowerCase()) ?? 0n;
  }

  /** Try to reserve. Returns the reservation or the reason it was refused. */
  reserve(id: string, wallet: string, amount: bigint, obs: Observed, now: number, ttlMs: number): Reservation | string {
    if (this.open.has(id)) return "duplicate id";
    if (amount <= 0n) return "amount must be positive";
    const w = wallet.toLowerCase();
    // biome-ignore lint/complexity/useMathMinMax: bigint, Math.min would throw
    const cap = obs.balance < obs.allowance ? obs.balance : obs.allowance;
    const used = this.reserved(w);
    if (used + amount > cap) return `would exceed min(allowance, balance): ${used} + ${amount} > ${cap}`;
    const r = { id, wallet: w, amount, expiresAt: now + ttlMs };
    this.open.set(id, r);
    this.byWallet.set(w, used + amount);
    return r;
  }

  /** Release after the pull settled (either way) or the cert expired. */
  release(id: string): boolean {
    const r = this.open.get(id);
    if (!r) return false;
    this.open.delete(id);
    const left = this.reserved(r.wallet) - r.amount;
    if (left === 0n) this.byWallet.delete(r.wallet);
    else this.byWallet.set(r.wallet, left);
    return true;
  }

  /** Drop expired reservations. Returns how many. */
  sweep(now: number): number {
    let n = 0;
    for (const r of [...this.open.values()]) if (r.expiresAt <= now && this.release(r.id)) n++;
    return n;
  }

  get size(): number {
    return this.open.size;
  }
  snapshot(): { wallet: string; reserved: string; open: number }[] {
    const count = new Map<string, number>();
    for (const r of this.open.values()) count.set(r.wallet, (count.get(r.wallet) ?? 0) + 1);
    return [...this.byWallet.entries()].map(([wallet, v]) => ({
      wallet,
      reserved: v.toString(),
      open: count.get(wallet) ?? 0,
    }));
  }
}
