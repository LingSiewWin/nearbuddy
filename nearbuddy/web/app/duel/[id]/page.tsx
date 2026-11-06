// Server shell: params are dynamic, so the client record renders inside Suspense (cacheComponents).
import { Suspense } from "react";
import { DuelRecord } from "./duel";

export default function DuelPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<pre><span className="dim">connecting</span><span className="cursor" /></pre>}>
      <DuelRecord params={params} />
    </Suspense>
  );
}
