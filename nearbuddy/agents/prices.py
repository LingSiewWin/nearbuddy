"""Spot prices normalised to u64 with 8 decimals, for the market brief the models read. The contract itself
scores on the Outlayer TEE oracle price (price-oracle.testnet), not on anything fetched here.

Pyth Hermes first when a key is configured (the public endpoint answered 401 on 2026-11-05 without one);
Coinbase spot otherwise, keyless. ponytail: single source per call; add a median over sources before
real money depends on the close.
"""

from __future__ import annotations

import requests

HERMES = "https://hermes.pyth.network/v2/updates/price/latest"
FEEDS = {
    "BTC/USD": "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    "ETH/USD": "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    "NEAR/USD": "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750",
}


def normalise(price: int, expo: int, decimals: int = 8) -> int:
    """Pyth gives price * 10^expo (expo usually -8). Return price scaled to `decimals`."""
    shift = decimals + expo
    return price * 10**shift if shift >= 0 else price // 10 ** (-shift)


COINBASE = "https://api.coinbase.com/v2/prices/{base}-USD/spot"


def coinbase_price(symbol: str) -> int:
    base = symbol.split("/")[0]
    r = requests.get(COINBASE.format(base=base), timeout=20)
    r.raise_for_status()
    amount = r.json()["data"]["amount"]
    whole, _, frac = amount.partition(".")
    return int(whole) * 10**8 + int((frac + "00000000")[:8])


def price(symbol: str, pyth_key: str | None = None, attempts: int = 4) -> int:
    """Hermes (with a key) then Coinbase; a transient network error (DNS blip, 5xx) is retried with backoff
    so one failed fetch never kills a duel loop."""
    import time

    last: Exception | None = None
    for i in range(attempts):
        try:
            if pyth_key:
                try:
                    return hermes_price(symbol, pyth_key)
                except requests.RequestException:
                    pass
            return coinbase_price(symbol)
        except requests.RequestException as e:
            last = e
            time.sleep(2**i)
    raise RuntimeError(f"price fetch failed after {attempts} attempts: {last}")


def hermes_price(symbol: str, api_key: str | None = None) -> int:
    feed = FEEDS[symbol]
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    r = requests.get(HERMES, params={"ids[]": feed}, headers=headers, timeout=20)
    r.raise_for_status()
    p = r.json()["parsed"][0]["price"]
    return normalise(int(p["price"]), int(p["expo"]))


def brief(symbol: str, price8: int, prev8: int | None) -> str:
    px = price8 / 1e8
    if prev8:
        move = (price8 - prev8) / prev8 * 10_000
        return f"{symbol} last {px:,.2f}. Move since duel open: {move:+.1f} bps."
    return f"{symbol} last {px:,.2f}. Duel just opened."
