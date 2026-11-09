import assert from "node:assert/strict";
import { test } from "node:test";
import { emitPy, emitTs } from "./gen.ts";

const BASE64_AS_BYTES = { description: "x", type: "array", items: { type: "integer", format: "uint8", minimum: 0 } };
const abi = (definitions: Record<string, unknown>, result: unknown = { $ref: "#/definitions/Row" }) => ({
  schema_version: "0.4.0",
  body: {
    functions: [{ name: "get_row", kind: "view", result: { serialization_type: "json", type_schema: result } }],
    root_schema: { definitions },
  },
});
const ROW = {
  type: "object",
  required: ["pk"],
  properties: {
    pk: { $ref: "#/definitions/Base64VecU8" },
    in_duel: { type: ["string", "null"] }, // Option<U64>: not required, serde still writes null
    spent: { type: "string" }, // serde(default): may be absent on input
    p: { $ref: "#/definitions/Promise" },
  },
};

test("Option fields are present-and-null, serde(default) fields optional, Base64VecU8 is a string", () => {
  const ts = emitTs(abi({ Row: ROW, Base64VecU8: BASE64_AS_BYTES, Promise: true }), "t.json", "T");
  assert.ok(ts.includes("in_duel: string | null;"));
  assert.ok(ts.includes("spent?: string;"));
  assert.ok(ts.includes("export type Base64VecU8 = string;"));
  assert.ok(ts.includes("p?: unknown;"));
  assert.ok(!ts.includes("type Promise")); // would shadow the global Promise
  const py = emitPy(abi({ Row: ROW, Base64VecU8: BASE64_AS_BYTES, Promise: true }), "t.json", "T");
  assert.ok(py.includes("    in_duel: str | None\n"));
  assert.ok(py.includes("    spent: NotRequired[str]\n"));
  assert.ok(py.includes("type Base64VecU8 = str\n"));
});

test("a Base64VecU8 schema other than the known wrong one is kept as published", () => {
  const fixed = { type: "string", description: "base64" };
  assert.ok(
    emitTs(abi({ Row: ROW, Base64VecU8: fixed, Promise: true }), "t.json", "T").includes(
      "export type Base64VecU8 = string;",
    ),
  );
  const other = { ...BASE64_AS_BYTES, items: { type: "integer", format: "uint16", minimum: 0 } };
  assert.ok(
    emitTs(abi({ Row: ROW, Base64VecU8: other, Promise: true }), "t.json", "T").includes(
      "export type Base64VecU8 = number[];",
    ),
  );
});

test("an unmapped schema keyword throws with its path instead of degrading to any", () => {
  const bad = abi({ Side: { type: "string", const: "Long" } }, { $ref: "#/definitions/Side" });
  assert.throws(() => emitTs(bad, "t.json", "T"), /#\/definitions\/Side: unhandled schema keyword\(s\) const/);
  assert.throws(() => emitTs(abi({}, { $ref: "#/definitions/Gone" }), "t.json", "T"), /unresolvable \$ref/);
});
