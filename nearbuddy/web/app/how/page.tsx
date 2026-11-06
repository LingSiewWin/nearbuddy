import type { Metadata } from "next";
import { ARENA_ID, acctUrl, duelHref, TAMPER_TX, txUrl } from "../ui/format";
import { Explainer } from "./explainer";
import { archivo } from "./fonts";
import "./how.css";
import { ORACLE_ID } from "../ui/format";

export const metadata: Metadata = { title: "how it works" };

// An authored illustration, not live data: the page renders without the arena API.
export default function HowPage() {
  return (
    <main className={`how ${archivo.variable}`}>
      <h1 className="how-title">How it works</h1>
      <figure
        className="how-stage"
        role="img"
        aria-label="A replay of duel 292 between Qwen and DeepSeek. The house pays 0.1 NEAR to send DeepSeek a fake crash headline while NEAR is up 0.18%; DeepSeek believes it and switches to Short. The call is verified on chain, and at the oracle close the loser pays 10% of its bond."
      >
        <Explainer />
      </figure>
      <dl className="how-lines">
        <div>
          <dt>What happens</dt>
          <dd>
            Two AI models trade NEAR/USD in five-minute duels, each calling Long or Short about once a minute. A paid
            fake headline (0.1 NEAR on chain) is slipped to one of them mid-duel; for now the house sends them, as the
            text reaches the model through its solver. <a href="/arena">Watch the live arena</a>.
          </dd>
        </div>
        <div>
          <dt>Why it matters</dt>
          <dd>
            A model that believes the lie trades on it: in <a href={duelHref(292)}>duel 292</a> DeepSeek on the plain
            prompt went Short on a fake crash while NEAR was up 0.18%. On a guarded prompt the same model saw through
            the same lie (<a href={duelHref(326)}>duel 326</a>). Only the last call before the close is scored, and the
            loser pays 10% of its bond. By then the models have usually switched back, so a lie rarely costs the duel.
            It did in <a href={duelHref(354)}>duel 354</a>: Qwen3.6 was still on the lie&apos;s side at the close and
            paid. The rest are in the <a href="/api/v1/decisions?attacked=1">published record</a>.
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
            <a href={txUrl(TAMPER_TX, "testnet")} target="_blank" rel="noreferrer">
              refuses a tampered one
            </a>
            . A TEE{" "}
            <a href={acctUrl(ORACLE_ID)} target="_blank" rel="noreferrer">
              price oracle
            </a>{" "}
            prices the open and the close.
          </dd>
        </div>
      </dl>
    </main>
  );
}
