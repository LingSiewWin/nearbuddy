#!/usr/bin/env python3
"""ZeroTab guarantor loss model: Monte Carlo fee floor in bps per chain.

The guarantor signs a certificate at card-auth time promising to pay the issuer
if the later on-chain pull (transferFrom) fails. This script estimates the
expected loss per $ guaranteed and the fee floor (bps) that covers it.

Loss channels per swipe:
  (a) adversarial drain: user moves funds after the swipe; succeeds only if the
      drain lands before the guarantor's pull (race on the same chain).
  (b) card race: K cards on one wallet, each issuer approves against the same
      stale balance; pulls landing after the balance is exhausted fail.
      Reservation ledger on: guarantor refuses certs once sum(reserved) > balance,
      so (b) becomes a decline instead of a loss.
Fixed costs: gas per pull + NEAR settle. Capital: stake must cover p99 of the
guarantor's concurrent outstanding exposure; charged at target yield y.

Variance reduction: the adversary's attempt (prob p_adv) and the "at least one
concurrent swipe" event are conditioned out analytically; Monte Carlo samples
the race given the event. This is why p_adv=0 gives exactly 0 and why results
are monotone in p_adv without 1e-5 events needing millions of trials.

Run:  python3 -I loss_model.py [trials] [seed]
Stdlib only. Self-check runs first and aborts the report on failure.
"""
import math
import random
import sys
import time

# ---------------------------------------------------------------- assumptions
# name: (value, source). "ESTIMATE" = no measurement yet.
ASSUMPTIONS = {
    "trials": (200_000, "default per scenario; argv[1] overrides"),
    "seed": (7, "argv[2] overrides"),
    "latency_sigma": (0.5, "ESTIMATE lognormal sigma for block inclusion jitter; pending Track 2 measurement"),
    "near_settle_s": (1.2, "NEAR finality ~1.2 s, https://docs.near.org/concepts/basics/transactions/overview"),
    "near_settle_gas_usd": (0.0001, "0.498 TGas/IOU measured at 100-IOU batch (agents/finance-ops.md); "
                                    "1 TGas = 1e-4 NEAR, NEAR ~ $2 ESTIMATE -> ~$0.0001"),
    "amount_median_usd": (40.0, "ESTIMATE card ticket median; lognormal"),
    "amount_sigma": (1.0, "ESTIMATE; mean ticket = median*exp(sigma^2/2) ~ $66"),
    "balance_median_usd": (500.0, "ESTIMATE self-custody card wallet balance; lognormal"),
    "balance_sigma": (0.8, "ESTIMATE"),
    "allowance": ("inf", "ESTIMATE allowance >= balance, so ledger bound = balance"),
    "cards_per_wallet": (5, "ESTIMATE K; shared wallet backing several agent cards"),
    "swipes_per_card_per_day": (50.0, "ESTIMATE lambda; agentic cards swipe often"),
    "p_adv_grid": ((1e-5, 1e-4, 1e-3), "ESTIMATE range. Ceiling analog: e-commerce chargeback rate 0.6-1.0%, "
                                       "friendly fraud ~44% of chargebacks, https://chargebacks911.com/chargeback-statistics/"),
    "adv_react_median_s": (3.0, "ESTIMATE human reaction: open wallet, sign drain; lognormal sigma 1.0"),
    "adv_react_sigma": (1.0, "ESTIMATE"),
    "recovery_rate": (0.0, "ESTIMATE r; later recovery from wallet not modeled"),
    "book_swipes_per_day": (10_000.0, "ESTIMATE guarantor-wide swipe volume, drives concurrent exposure"),
    "stake_yield_apr": (0.08, "ESTIMATE target yield on staked USDC"),
    "exposure_percentile": (0.99, "stake covers p99 of concurrent outstanding $"),
    "insurable_bps": (25.0, "product target: fee floor <= 25 bps"),
}

# Inclusion latency spec: ("lognormal", median_s, sigma) or ("shiftexp", shift_s, mean_s).
# final_extra_s: extra wait after inclusion until the finality the guarantor accepts.
CHAINS = {
    "base": dict(
        incl=("lognormal", 2.0, None), final_extra_s=0.0, gas_pull_usd=0.001,
        source="2 s block, accept at block; https://docs.base.org/base-chain/network-information/transaction-finality; gas ESTIMATE"),
    "base_preconf": dict(
        incl=("lognormal", 0.2, None), final_extra_s=0.0, gas_pull_usd=0.001,
        source="200 ms flashblock preconf, same Base doc; sequencer equivocation risk set to 0 (ESTIMATE)"),
    "base_l1": dict(
        incl=("lognormal", 2.0, None), final_extra_s=118.0, gas_pull_usd=0.001,
        source="2 s block + wait for L1 batch ~2 min, same Base doc"),
    "solana": dict(
        incl=("lognormal", 0.4, None), final_extra_s=12.4, gas_pull_usd=0.0007,
        source="400 ms slot, ~12.8 s finalized; https://solana.com/docs/core/transactions/confirmation; "
               "gas 5000 lamports + priority ESTIMATE"),
    "ethereum": dict(
        incl=("lognormal", 12.0, None), final_extra_s=768.0, gas_pull_usd=1.0,
        source="12 s slot, ~13 min finality; https://ethereum.org/en/developers/docs/consensus-mechanisms/pos/#finality; "
               "gas $0.50-2 ESTIMATE, mid $1"),
    "bitcoin_chainsig": dict(
        incl=("shiftexp", 3.5, 600.0), final_extra_s=0.0, gas_pull_usd=1.5,
        source="~10 min exponential block wait + MPC sign 2-5 s ESTIMATE, accept 1 conf (ESTIMATE); "
               "https://docs.near.org/chain-abstraction/chain-signatures; BTC fee ESTIMATE"),
}
DEFAULT_CHAINS = ["base", "solana", "ethereum", "bitcoin_chainsig"]
SENSITIVITY_CHAINS = ["base_preconf", "base", "base_l1"]


def V(k):
    return ASSUMPTIONS[k][0]


def sample_latency(spec, sigma, rng):
    kind, a, b = spec
    if kind == "lognormal":
        return rng.lognormvariate(math.log(a), sigma if b is None else b)
    return a + rng.expovariate(1.0 / b)


def poisson(m, rng):
    if m > 30:  # normal approx for the book-level count only
        return max(0, int(round(rng.gauss(m, math.sqrt(m)))))
    L, k, p = math.exp(-m), 0, 1.0
    while True:
        p *= rng.random()
        if p <= L:
            return k
        k += 1


def zero_trunc_poisson(m, rng):
    """N | N >= 1 for Poisson(m), inverse CDF. m is small (concurrent swipes in seconds)."""
    p0 = math.exp(-m)
    u = p0 + rng.random() * (1.0 - p0)
    k, cdf, pk = 0, p0, p0
    while cdf < u and k < 1000:
        k += 1
        pk *= m / k
        cdf += pk
    return max(k, 1)


def simulate(chain, n, rng):
    c = CHAINS[chain]
    sig = V("latency_sigma")
    mu_a, s_a = math.log(V("amount_median_usd")), V("amount_sigma")
    mu_b, s_b = math.log(V("balance_median_usd")), V("balance_sigma")
    mu_r, s_r = math.log(V("adv_react_median_s")), V("adv_react_sigma")
    other_rate = (V("cards_per_wallet") - 1) * V("swipes_per_card_per_day") / 86400.0
    book_rate = V("book_swipes_per_day") / 86400.0
    tail = c["final_extra_s"] + V("near_settle_s")
    # lognormal amount moments for the normal approx of the outstanding book
    a_mean = math.exp(mu_a + s_a * s_a / 2)
    a_var = (math.exp(s_a * s_a) - 1) * math.exp(2 * mu_a + s_a * s_a)

    sum_a = adv_h = adv_bot = race_off = decline = 0.0
    exposures = []
    n_cap = min(n, 20_000)
    for i in range(n):
        a = rng.lognormvariate(mu_a, s_a)
        b = rng.lognormvariate(mu_b, s_b)
        while b < a:  # issuer only approves if observed balance covers the ticket
            b = rng.lognormvariate(mu_b, s_b)
        l_pull = sample_latency(c["incl"], sig, rng)
        sum_a += a

        # (a) adversarial drain, conditional on an attempt
        l_drain = sample_latency(c["incl"], sig, rng)
        if l_drain < l_pull:
            adv_bot += a
            if rng.lognormvariate(mu_r, s_r) + l_drain < l_pull:
                adv_h += a

        # (b) card race, conditional on >= 1 other swipe during the pull window
        m = other_rate * l_pull
        w = 1.0 - math.exp(-m)
        k = zero_trunc_poisson(m, rng)
        before = rng.randrange(k + 1)  # focal pull lands after `before` of the k others
        s = sum(rng.lognormvariate(mu_a, s_a) for _ in range(before))
        if s + a > b:
            race_off += w * a   # ledger off: cert honored, pull fails, guarantor pays
            decline += w        # ledger on: cert refused instead

        # capital: concurrent outstanding $ across the whole book
        if i < n_cap:
            W = l_pull + tail
            N = poisson(book_rate * W, rng)
            exposures.append(max(0.0, rng.gauss(N * a_mean, math.sqrt(N * a_var))) if N else 0.0)

    exposures.sort()
    stake = exposures[min(len(exposures) - 1, int(V("exposure_percentile") * len(exposures)))]
    annual_vol = V("book_swipes_per_day") * 365 * (sum_a / n)
    return dict(
        chain=chain, mean_amt=sum_a / n,
        adv_h=adv_h / n, adv_bot=adv_bot / n, race_off=race_off / n, decline=decline / n,
        gas_usd=c["gas_pull_usd"] + V("near_settle_gas_usd"),
        stake_p99=stake, capital_bps=1e4 * V("stake_yield_apr") * stake / annual_vol,
    )


def loss_bps(r, p_adv, ledger_on, bot=False):
    adv = r["adv_bot"] if bot else r["adv_h"]
    loss = p_adv * adv * (1 - V("recovery_rate")) + (0.0 if ledger_on else r["race_off"])
    return 1e4 * loss / r["mean_amt"]


def floor_bps(r, p_adv, ledger_on, capital=True, bot=False):
    gas = 1e4 * r["gas_usd"] / r["mean_amt"]
    return loss_bps(r, p_adv, ledger_on, bot) + gas + (r["capital_bps"] if capital else 0.0)


def self_check(results):
    grid = V("p_adv_grid")
    for r in results.values():
        assert loss_bps(r, 0.0, True) == 0.0, r["chain"]
        for p in grid:
            assert loss_bps(r, p, True) <= loss_bps(r, p, False), r["chain"]
        for on in (True, False):
            f = [floor_bps(r, p, on) for p in grid]
            assert all(x <= y for x, y in zip(f, f[1:])), (r["chain"], on)


def report(results, n, seed, secs):
    grid = V("p_adv_grid")
    out = []
    p = out.append
    p(f"ZeroTab guarantor loss model  trials={n} seed={seed} runtime={secs:.1f}s  (python3 -I, stdlib)")
    p("")
    p("ASSUMPTIONS")
    for k, (v, src) in ASSUMPTIONS.items():
        p(f"  {k:26s} {str(v):22s} {src}")
    for k in DEFAULT_CHAINS + ["base_preconf", "base_l1"]:
        c = CHAINS[k]
        p(f"  chain:{k:20s} incl={c['incl']} final_extra_s={c['final_extra_s']} gas_pull_usd={c['gas_pull_usd']}  {c['source']}")
    p("")
    p("SCENARIOS  (loss and floor in bps of guaranteed volume; p99 exposure = stake S in $)")
    hdr = f"{'chain':18s} {'ledger':6s} {'p_adv':>7s} {'loss_bps':>10s} {'gas_bps':>8s} {'p99_exp_$':>10s} {'cap_bps':>8s} {'floor_bps':>10s} {'floor+cap':>10s}"
    p(hdr)
    for k in DEFAULT_CHAINS:
        r = results[k]
        gas = 1e4 * r["gas_usd"] / r["mean_amt"]
        for on in (True, False):
            for pa in grid:
                p(f"{k:18s} {'on' if on else 'off':6s} {pa:7.0e} {loss_bps(r, pa, on):10.4f} {gas:8.4f} "
                  f"{r['stake_p99']:10.0f} {r['capital_bps']:8.5f} {floor_bps(r, pa, on, False):10.4f} {floor_bps(r, pa, on):10.4f}")
    p("")
    p("LEDGER VALUE  (race loss removed by the reservation ledger; same events become declines)")
    for k in DEFAULT_CHAINS:
        r = results[k]
        p(f"  {k:18s} race_loss_off={1e4 * r['race_off'] / r['mean_amt']:.4f} bps  "
          f"declines_with_ledger={100 * r['decline']:.3f}% of swipes")
    p("")
    p("SENSITIVITY  Base: what the guarantor waits for (p_adv=1e-4, ledger on)")
    for k in SENSITIVITY_CHAINS:
        r = results[k]
        p(f"  {k:14s} loss={loss_bps(r, 1e-4, True):.4f} bps  p99_exp=${r['stake_p99']:.0f}  "
          f"cap={r['capital_bps']:.5f} bps  floor+cap={floor_bps(r, 1e-4, True):.4f} bps")
    p("")
    p("SENSITIVITY  bot adversary (zero reaction time, drain races pull head-on), ledger on, p_adv=1e-4")
    for k in DEFAULT_CHAINS:
        r = results[k]
        p(f"  {k:18s} P(drain wins|attempt): human={r['adv_h'] / r['mean_amt']:.3f} bot={r['adv_bot'] / r['mean_amt']:.3f}  "
          f"floor+cap bot={floor_bps(r, 1e-4, True, bot=True):.4f} bps")
    p("")
    lim = V("insurable_bps")
    ok = [k for k in DEFAULT_CHAINS if floor_bps(results[k], 1e-3, True) <= lim]
    p(f"INSURABLE at <= {lim:.0f} bps with ledger on, worst p_adv={grid[-1]:.0e}: {', '.join(ok) or 'none'}")
    return "\n".join(out)


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else V("trials")
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else V("seed")
    t0 = time.time()
    results = {}
    for k in DEFAULT_CHAINS + ["base_preconf", "base_l1"]:
        results[k] = simulate(k, n, random.Random(f"{seed}:{k}"))
    self_check(results)
    print(report(results, n, seed, time.time() - t0))
