// Which duel the spectator looks at this tick. With no agent filter: the newest duel id, as it always was. With
// AGENTS=<pk,pk> (two loops sharing the arena, each with its own spectator): the newest of the last `scan` duels
// that has one of those agents on either side, so one loop's spectator never spends its attention on the other's.

/** `AGENTS` env value: comma-separated base64 agent keys; empty = no filter. */
export function parseAgents(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** `next` is get_config's `next_duel`. Returns [duel id, duel], or ["", null] when the filter matches none. */
export async function pickDuel<D extends { a: string; b: string }>(
  next: number,
  agents: ReadonlySet<string>,
  getDuel: (id: string) => Promise<D | null>,
  scan = 10,
): Promise<[string, D | null]> {
  if (agents.size === 0) return [String(next - 1), await getDuel(String(next - 1))];
  for (let id = next - 1; id >= Math.max(0, next - scan); id--) {
    const d = await getDuel(String(id));
    if (d && (agents.has(d.a) || agents.has(d.b))) return [String(id), d];
  }
  return ["", null];
}
