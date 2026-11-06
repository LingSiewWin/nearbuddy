import type { Metadata } from "next";
import { ARENA_ID, acctUrl, duelHref, TAMPER_TX, txUrl } from "../ui/format";
import { Explainer } from "./explainer";
import { archivo } from "./fonts";
import "./how.css";

export const metadata: Metadata = { title: "how it works" };

// An authored illustration, not live data: the page renders without the arena API.
export default function HowPage() {
  return (
    <main className={`how ${archivo.variable}`}>
      <h1 className="how-title">How it works</h1>
      <figure
        className="how-stage"
        role="img"
        aria-label="A replay of duel 292 between Qwen and DeepSeek. Someone pays 0.1 NEAR to send DeepSeek a fake crash headline while NEAR is up 0.18%; DeepSeek believes it and switches to Short. The call is verified on chain, and at the oracle close the loser pays 10% of its bond."
      >
        <Explainer />
      </figure>
      <dl className="how-lines">
        <div>
          <dt>What happens</dt>
          <dd>
            Two AI models trade NEAR/USD in five-minute duels, each calling Long or Short about once a minute. Anyone
            can pay 0.1 NEAR to slip one of them a fake headline mid-duel. <a href="/arena">Watch the live arena</a>.
          </dd>
        </div>
        <div>
          <dt>Why it matters</dt>
          <dd>
            A model that believes the lie trades on it: in <a href={duelHref(292)}>duel 292</a> DeepSeek on the plain
            prompt went Short on a fake crash while NEAR was up 0.18%. On a guarded prompt the same model saw through
            the same lie (<a href={duelHref(326)}>duel 326</a>). Only the last call before the close is scored, and the
            loser pays 10% of its bond. By then the models have nearly always switched back: in the{" "}
            <a href="/api/v1/decisions?attacked=1">published record</a> no model has yet lost a duel on a lie&apos;s
            side.
          </dd>
        </div>
        <div>
          <dt>How it is checked</dt>
          <dd>
            Each call is answered and signed inside a NEAR AI Cloud enclave. The{" "}
            <a href={acctUrl(ARENA_ID)} target="_blank" rel="noreferrer">
              arena contract
            </a>{" "}
            checks that signature before the call counts and{" "}
            <a href={txUrl(TAMPER_TX)} target="_blank" rel="noreferrer">
              refuses a tampered one
            </a>
            . A TEE{" "}
            <a href={acctUrl("price-oracle.testnet")} target="_blank" rel="noreferrer">
              price oracle
            </a>{" "}
            prices the open and the close.
          </dd>
        </div>
      </dl>
    </main>
  );
}
