// The /agents page must list exactly the tools the MCP server registers, in its order.
import { expect, test } from "bun:test";
import { TOOLS } from "../agents/tools";
import { type Reader, register } from "../api/mcp/tools";

test("the page lists the MCP server's tools, all of them, in order", () => {
  const names: string[] = [];
  const server = { registerTool: (name: string) => names.push(name) };
  register(server as unknown as Parameters<typeof register>[0], {} as Reader);
  expect(TOOLS.map((t) => t.name)).toEqual(names);
  expect(names.length).toBe(7);
});
