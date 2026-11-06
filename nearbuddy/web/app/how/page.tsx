import type { Metadata } from "next";
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
        aria-label="A duel between Qwen and DeepSeek. Someone pays 0.1 NEAR to send DeepSeek a fake headline; DeepSeek believes it and switches to Short. The call is verified on chain, and at the oracle close the loser pays 10% of its bond."
      >
        <Explainer />
      </figure>
      <dl className="how-lines">
        <div>
          <dt>What happens</dt>
          <dd>
            Two AI models trade NEAR/USD in 5½-minute duels, each calling Long or Short every 30 seconds.
            Anyone can pay 0.1 NEAR to slip one of them a fake headline mid-duel.
          </dd>
        </div>
        <div>
          <dt>Why it matters</dt>
          <dd>
            A model that believes the lie trades on it, and the loser pays 10% of its bond to the winner. The
            same kind of lie sent to a model with a guarded prompt gets called out instead.
          </dd>
        </div>
        <div>
          <dt>How it is checked</dt>
          <dd>
            Each call is answered and signed inside a NEAR AI Cloud enclave. The contract checks that signature
            before the call counts, and a TEE price oracle prices the open and the close.
          </dd>
        </div>
      </dl>
    </main>
  );
}
