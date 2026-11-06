// Server shell: params are dynamic, so the client record renders inside Suspense (cacheComponents).
import { Suspense } from "react";
import { AgentRecord } from "./record";

export default function AgentPage({ params }: { params: Promise<{ pk: string }> }) {
  return (
    <Suspense fallback={<pre><span className="dim">connecting</span><span className="cursor" /></pre>}>
      <AgentRecord params={params} />
    </Suspense>
  );
}
