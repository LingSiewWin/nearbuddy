// GET /api/v1/stream  Server-Sent Events: every new arena event as it lands on chain.
// On connect it replays events after Last-Event-ID (or the newest 20), then polls the tape every 2 s.
// The stream ends after WINDOW ms with a retry hint; EventSource reconnects and resumes from its last id.
// Event names are the event kinds (intent, attack, open, resolve, register, other); id is the block height.
import { tape } from "../../tape";

const WINDOW = 120_000;
const POLL = 2_000;

export async function GET(req: Request) {
  const last = Number(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("since") ?? 0) || 0;
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stop: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream({
    async start(c) {
      const sent = new Set<string>();
      let closed = false;
      const send = (s: string) => {
        if (!closed) c.enqueue(enc.encode(s));
      };
      const push = async (first: boolean) => {
        try {
          const { events } = await tape();
          const fresh = events.filter((e) => !sent.has(e.tx) && (last ? e.block > last : true));
          const batch = first && !last ? fresh.slice(0, 20) : fresh;
          for (const e of batch.reverse()) {
            sent.add(e.tx);
            send(`id: ${e.block}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
          }
          if (first) for (const e of fresh) sent.add(e.tx); // older ones are history, not news
          send(": ok\n\n");
        } catch {
          send(": upstream error, retrying\n\n");
        }
      };
      send("retry: 1000\n\n");
      await push(true);
      timer = setInterval(() => void push(false), POLL);
      stop = setTimeout(() => {
        clearInterval(timer);
        closed = true;
        c.close();
      }, WINDOW);
    },
    cancel() {
      clearInterval(timer);
      clearTimeout(stop);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
