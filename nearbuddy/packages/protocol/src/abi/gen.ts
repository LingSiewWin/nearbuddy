// NEAR contract ABI (near-abi 0.4.x, JSON serialization) -> TypeScript + Python types. No dependencies.
// Usage: `bun run gen:types` (writes every file in OUTPUTS); scripts/gen-abi.sh also refreshes abi/*.json first.
// Fails closed: a JSON Schema keyword it does not map throws instead of degrading to any/Any.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// biome-ignore lint/suspicious/noExplicitAny: parsed ABI JSON; conv() checks every keyword before use (fail closed)
type Json = any;
type Obj = Record<string, Json>;
type Field = { key: string; type: string; optional: boolean; doc?: string };
type Entry = { name: string; kind: string; doc: string; args: string; result: string };
interface Lang {
  reserved: string[];
  any(): string;
  str: string;
  int: string;
  num: string;
  bool: string;
  nul: string;
  none: string;
  array(t: string): string;
  tuple(ts: string[]): string;
  map(t: string): string;
  union(ts: string[]): string;
  literal(vs: unknown[]): string;
  object(name: string, fields: Field[], doc: string | undefined, eager: boolean): string;
  alias(name: string, type: string, doc?: string): string;
  inlineArgs?(fields: Field[]): string;
}

const ANNOTATIONS = ["description", "title", "format", "minimum", "maximum", "default", "$schema"];
const INT_FORMATS = new Set(["int8", "int16", "int32", "int64", "int", "uint8", "uint16", "uint32", "uint64", "uint"]);
const FN_KEYS = new Set(["name", "doc", "kind", "modifiers", "params", "result", "callbacks", "callbacks_vec"]);
const PY_KEYWORDS =
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
    " ",
  );
const LINE = 120;
// near-sdk's Base64VecU8 derives JsonSchema from its Vec<u8> field, but serde writes it as a base64 string.
const BASE64_WRONG = { type: "array", items: { type: "integer", format: "uint8", minimum: 0 } };

const fail = (msg: string): never => {
  throw new Error(msg);
};
const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
const docLines = (doc?: string) =>
  doc
    ? doc
        .trim()
        .split("\n")
        .map((l) => l.trimEnd())
    : [];
const nullable = (s: Json) =>
  !!s &&
  typeof s === "object" &&
  ((s.anyOf ?? []).some((m: Json) => m?.type === "null") || (Array.isArray(s.type) && s.type.includes("null")));

function build(abi: Obj, L: Lang): { decls: string[]; entries: Entry[] } {
  if (!/^0\.4\./.test(abi.schema_version)) fail(`unsupported near-abi schema_version ${abi.schema_version}`);
  const defs: Obj = { ...(abi.body.root_schema.definitions ?? {}) };
  const b = defs.Base64VecU8;
  if (b && JSON.stringify({ ...b, description: undefined }) === JSON.stringify(BASE64_WRONG))
    defs.Base64VecU8 = { type: "string", description: "Base64 string on the wire (near-sdk's ABI reports Vec<u8>)." };
  const decls: string[] = [];
  const names = new Set([...L.reserved, ...Object.keys(defs)]);
  let own = ""; // definition being emitted: its top-level object takes the definition's name
  let eager = false; // Python functional TypedDict values run before every definition exists
  const claim = (n: string) => {
    if (n === own) own = "";
    else if (names.has(n)) fail(`type name collision: ${n}`);
    names.add(n);
  };

  // Not-required + nullable = Option<T> that serde always writes as null; not-required otherwise = serde(default).
  const fields = (props: Obj, req: Set<string>, kids: string, path: string): Field[] =>
    Object.entries(props).map(([k, v]) => ({
      key: k,
      type: conv(v, kids + pascal(k), `${path}/${k}`),
      optional: !req.has(k) && !nullable(v),
      doc: v?.description,
    }));

  function conv(s: unknown, name: string, path: string, kids = name): string {
    if (s === true) return L.any();
    if (typeof s !== "object" || s === null || Array.isArray(s))
      return fail(`${path}: unsupported schema ${JSON.stringify(s)}`);
    const o = s as Obj;
    const used = new Set(ANNOTATIONS);
    const take = (k: string) => {
      used.add(k);
      return o[k];
    };
    const out = shape();
    const extra = Object.keys(o).filter((k) => !used.has(k));
    if (extra.length) fail(`${path}: unhandled schema keyword(s) ${extra.join(", ")}`);
    return out;

    function shape(): string {
      if ("$ref" in o) {
        const ref = take("$ref");
        const m = /^#\/definitions\/(.+)$/.exec(ref);
        if (!m?.[1] || !(m[1] in defs)) return fail(`${path}: unresolvable $ref ${ref}`);
        // a `true` definition (near-sdk's Promise) is any JSON: inline it, never export a type named Promise
        return defs[m[1]] === true ? L.any() : m[1];
      }
      if ("allOf" in o) {
        const all = take("allOf");
        return all.length === 1
          ? conv(all[0], name, `${path}/allOf/0`, kids)
          : fail(`${path}: allOf with ${all.length} members`);
      }
      for (const k of ["anyOf", "oneOf"])
        if (k in o) return L.union(take(k).map((m: Json, i: number) => variant(m, `${path}/${k}/${i}`, i)));
      if ("enum" in o) {
        take("type");
        return L.literal(take("enum"));
      }
      const t = take("type");
      if (Array.isArray(t)) return L.union(t.map(one));
      return t === undefined ? L.any() : one(t);
    }

    // Externally tagged enum variant {"Pulled": {...}}: wrapper PullOutcomePulledVariant, payload PullOutcomePulled.
    function variant(m: Json, p: string, i: number): string {
      const keys = m?.properties ? Object.keys(m.properties) : [];
      return keys.length === 1 && keys[0]
        ? conv(m, `${name}${pascal(keys[0])}Variant`, p, name)
        : conv(m, `${name}Variant${i}`, p);
    }

    function one(t: string): string {
      switch (t) {
        case "string":
          return L.str;
        case "boolean":
          return L.bool;
        case "null":
          return L.nul;
        case "number":
          return L.num;
        case "integer":
          return o.format === undefined || INT_FORMATS.has(o.format)
            ? L.int
            : fail(`${path}: integer format ${o.format} has no JSON number mapping`);
        case "array": {
          const items = take("items");
          const min = take("minItems");
          const max = take("maxItems");
          if (!Array.isArray(items))
            return L.array(items === undefined ? L.any() : conv(items, `${name}Item`, `${path}/items`));
          if (min !== items.length || max !== items.length)
            fail(`${path}: open tuple (minItems/maxItems != ${items.length})`);
          return L.tuple(items.map((it, i) => conv(it, `${name}${i}`, `${path}/items/${i}`)));
        }
        case "object": {
          const props = take("properties");
          const req = new Set<string>(take("required") ?? []);
          const ap = take("additionalProperties");
          if (!props) {
            if (req.size || ap === false) fail(`${path}: object without properties`);
            return L.map(
              ap === undefined || ap === true ? L.any() : conv(ap, `${name}Value`, `${path}/additionalProperties`),
            );
          }
          if (ap !== undefined && ap !== false)
            fail(`${path}: properties with additionalProperties ${JSON.stringify(ap)}`);
          for (const r of req) if (!(r in props)) fail(`${path}: required ${r} not in properties`);
          const fs = fields(props, req, kids, `${path}/properties`);
          claim(name);
          decls.push(L.object(name, fs, o.description, eager));
          return name;
        }
        default:
          return fail(`${path}: unsupported type ${t}`);
      }
    }
  }

  eager = true;
  for (const name of Object.keys(defs).sort()) {
    own = name;
    const s = defs[name];
    if (s === true) continue; // inlined at every $ref
    const expr = conv(s, name, `#/definitions/${name}`);
    if (expr !== name) decls.push(L.alias(name, expr, s?.description));
    else if (own === name) fail(`#/definitions/${name}: refers only to itself`);
  }
  eager = false;
  own = "";

  const entries = [...abi.body.functions]
    // private = only the contract itself may call it (promise callbacks): no client ever does
    .filter((fn: Obj) => !fn.modifiers?.includes("private"))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((fn: Obj): Entry => {
      const path = `functions/${fn.name}`;
      const extra = Object.keys(fn).filter((k) => !FN_KEYS.has(k));
      if (extra.length) fail(`${path}: unhandled function key(s) ${extra.join(", ")}`);
      if (fn.kind !== "view" && fn.kind !== "call") fail(`${path}: unknown kind ${fn.kind}`);
      for (const io of [fn.params, fn.result])
        if (io && io.serialization_type !== "json")
          fail(`${path}: ${io.serialization_type} serialization not supported`);
      const P = pascal(fn.name);
      const args: Obj[] = fn.params?.args ?? [];
      const props = Object.fromEntries(args.map((a) => [a.name, a.type_schema]));
      const fs = fields(props, new Set(Object.keys(props)), `${P}Args`, `${path}/args`);
      let argsType = `${P}Args`;
      if (L.inlineArgs) argsType = L.inlineArgs(fs);
      else {
        claim(argsType);
        decls.push(L.object(argsType, fs, undefined, false));
      }
      const doc = [
        ...docLines(fn.doc),
        ...(fn.modifiers?.length ? [`modifiers: ${fn.modifiers.join(", ")}`] : []),
      ].join("\n");
      // no result schema: a call returns nothing, but a view always answers (near-sdk's own contract_source_metadata
      // has no schema in the ABI), so unknown rather than a confident "nothing"
      const result = fn.result
        ? conv(fn.result.type_schema, `${P}Result`, `${path}/result`)
        : fn.kind === "view"
          ? L.any()
          : L.none;
      return { name: fn.name, kind: fn.kind, doc, args: argsType, result };
    });
  return { decls, entries };
}

// ---------- TypeScript ----------
const jsdoc = (doc: string | undefined, ind: string) => {
  const ls = docLines(doc).map((l) => l.replaceAll("*/", "*\\/"));
  if (!ls.length) return "";
  if (ls.length === 1) return `${ind}/** ${ls[0]} */\n`;
  return `${ind}/**\n${ls.map((l) => `${ind} * ${l}`.trimEnd()).join("\n")}\n${ind} */\n`;
};
const tsKey = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
const tsField = (f: Field) => `${tsKey(f.key)}${f.optional ? "?" : ""}: ${f.type}`;

export function emitTs(abi: Obj, src: string, prefix: string): string {
  const L: Lang = {
    reserved: ["Record", `${prefix}Views`, `${prefix}Calls`],
    any: () => "unknown",
    str: "string",
    int: "number",
    num: "number",
    bool: "boolean",
    nul: "null",
    none: "undefined",
    array: (t) => (t.includes(" | ") ? `(${t})[]` : `${t}[]`),
    tuple: (ts) => `[${ts.join(", ")}]`,
    map: (t) => `Record<string, ${t}>`,
    union: (ts) => ts.join(" | "),
    literal: (vs) =>
      vs
        .map((v) =>
          v === null || ["string", "number", "boolean"].includes(typeof v)
            ? JSON.stringify(v)
            : fail(`bad enum value ${v}`),
        )
        .join(" | "),
    object: (name, fs, doc) =>
      `${jsdoc(doc, "")}export interface ${name} {\n${fs.map((f) => `${jsdoc(f.doc, "  ")}  ${tsField(f)};\n`).join("")}}`,
    alias: (name, type, doc) => `${jsdoc(doc, "")}export type ${name} = ${type};`,
    inlineArgs: (fs) => (fs.length ? `{ ${fs.map(tsField).join("; ")} }` : "Record<string, never>"),
  };
  const { decls, entries } = build(abi, L);
  const out = [
    `// Generated from ${src} by packages/protocol/src/abi/gen.ts (bun run gen:types). Do not edit.`,
    ...decls,
  ];
  for (const [kind, suffix] of [
    ["view", "Views"],
    ["call", "Calls"],
  ]) {
    const es = entries.filter((e) => e.kind === kind);
    out.push(
      `export interface ${prefix}${suffix} {\n${es.map((e) => `${jsdoc(e.doc, "  ")}  ${e.name}: { args: ${e.args}; result: ${e.result} };\n`).join("")}}`,
    );
  }
  return `${out.join("\n\n")}\n`;
}

// ---------- Python ----------
const wrap = (line: string, width: number): string[] => {
  const out: string[] = [];
  let cur = "";
  for (const w of line.split(" ").filter(Boolean)) {
    if (cur && cur.length + 1 + w.length > width) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  return [...out, cur];
};
const pyDoc = (doc: string | undefined, ind: string) =>
  docLines(doc)
    .flatMap((l) => wrap(l, LINE - ind.length - 2))
    .map((l) => `${`${ind}# ${l}`.trimEnd()}\n`)
    .join("");
const pyIdent = (k: string) => /^[A-Za-z_]\w*$/.test(k) && !PY_KEYWORDS.includes(k) && !k.startsWith("__");
const pyLit = (v: unknown) =>
  typeof v === "string"
    ? JSON.stringify(v)
    : typeof v === "boolean"
      ? v
        ? "True"
        : "False"
      : v === null
        ? "None"
        : Number.isInteger(v)
          ? String(v)
          : fail(`enum value ${JSON.stringify(v)} cannot be a Python Literal`);

// ruff (black) splits an overlong def at its parameter list: one indented line, else one parameter per line.
function pyDef(params: string[], ret: string): string {
  const flat = `    def __call__(${params.join(", ")}) -> ${ret}: ...`;
  if (flat.length <= LINE) return flat;
  const mid = `        ${params.join(", ")}`;
  const body = mid.length <= LINE ? [mid] : params.map((p) => `        ${p},`);
  return ["    def __call__(", ...body, `    ) -> ${ret}: ...`].join("\n");
}

export function emitPy(abi: Obj, src: string, prefix: string): string {
  const used = new Set<string>();
  const use = (n: string) => {
    used.add(n);
    return n;
  };
  const quote = (t: string) =>
    !t.includes('"') ? `"${t}"` : !t.includes("'") ? `'${t}'` : fail(`cannot quote forward ref ${t}`);
  const L: Lang = {
    reserved: [
      ...PY_KEYWORDS,
      "Any",
      "Literal",
      "NotRequired",
      "Protocol",
      "TypedDict",
      "overload",
      "annotations",
      "str",
      "int",
      "float",
      "bool",
      "list",
      "dict",
      "tuple",
      `${prefix}View`,
      `${prefix}Call`,
    ],
    any: () => use("Any"),
    str: "str",
    int: "int",
    num: "float",
    bool: "bool",
    nul: "None",
    none: "None",
    array: (t) => `list[${t}]`,
    tuple: (ts) => `tuple[${ts.join(", ")}]`,
    map: (t) => `dict[str, ${t}]`,
    union: (ts) => ts.join(" | "),
    literal: (vs) => `${use("Literal")}[${vs.map(pyLit).join(", ")}]`,
    object: (name, fs, doc, eager) => {
      const ty = (f: Field) => (f.optional ? `${use("NotRequired")}[${f.type}]` : f.type);
      if (fs.every((f) => pyIdent(f.key))) {
        const body = fs.length ? fs.map((f) => `${pyDoc(f.doc, "    ")}    ${f.key}: ${ty(f)}`).join("\n") : "    pass";
        return `${pyDoc(doc, "")}class ${name}(${use("TypedDict")}):\n${body}`;
      }
      // Functional form for keys that are not identifiers (e.g. `from`); field docs move above the assignment.
      const fdocs = fs.flatMap((f) => (f.doc ? [`${f.key}: ${f.doc}`] : [])).join("\n");
      const items = fs.map((f) => `${JSON.stringify(f.key)}: ${eager ? quote(ty(f)) : ty(f)}`).join(", ");
      return `${pyDoc([doc, fdocs].filter(Boolean).join("\n"), "")}${name} = ${use("TypedDict")}(${JSON.stringify(name)}, {${items}})`;
    },
    alias: (name, type, doc) => `${pyDoc(doc, "")}type ${name} = ${type}`,
  };
  const { decls, entries } = build(abi, L);
  for (const [kind, cls] of [
    ["view", "View"],
    ["call", "Call"],
  ]) {
    const es = entries.filter((e) => e.kind === kind);
    if (!es.length) continue;
    const ov = es.length > 1 ? `    @${use("overload")}\n` : "";
    const methods = es.map(
      (e) =>
        `${pyDoc(e.doc, "    ")}${ov}${pyDef(["self", `method: ${use("Literal")}[${JSON.stringify(e.name)}]`, `args: ${e.args}`], e.result)}`,
    );
    decls.push(`class ${prefix}${cls}(${use("Protocol")}):\n${methods.join("\n\n")}`);
  }
  const head = `# Generated from ${src} by packages/protocol/src/abi/gen.ts (bun run gen:types). Do not edit.\nfrom __future__ import annotations\n\nfrom typing import ${[...used].sort().join(", ")}`;
  // isort (ruff I001): two blank lines after imports before a class, one before anything else.
  const firstCode = decls[0]?.split("\n").find((l) => !l.startsWith("#")) ?? "";
  const text = `${head}${firstCode.startsWith("class ") ? "\n\n\n" : "\n\n"}${decls.join("\n\n\n")}\n`;
  for (const l of text.split("\n"))
    if (l.length > LINE) fail(`Python line over ${LINE} chars; ruff wrapping not reproduced: ${l}`);
  return text;
}

// Paths from nearbuddy/. web is its own bun project (ADR 0004), so it gets its own copy of the TS.
// Python gets the arena and predict types; the agents never call the vault contract.
const OUTPUTS = [
  {
    abi: "abi/arena.json",
    prefix: "Arena",
    ts: ["packages/protocol/src/abi/arena.ts", "web/app/lib/abi/arena.ts"],
    py: "agents/arena_types.py",
  },
  { abi: "abi/vault.json", prefix: "Vault", ts: ["packages/protocol/src/abi/vault.ts", "web/app/lib/abi/vault.ts"] },
  {
    abi: "abi/predict.json",
    prefix: "Predict",
    ts: ["packages/protocol/src/abi/predict.ts", "web/app/lib/abi/predict.ts"],
    py: "agents/predict_types.py",
  },
];

if (import.meta.main) {
  const root = join(import.meta.dirname, "../../../..");
  const written: string[] = [];
  for (const o of OUTPUTS) {
    const abi = JSON.parse(readFileSync(join(root, o.abi), "utf8"));
    for (const t of o.ts) {
      writeFileSync(join(root, t), emitTs(abi, o.abi, o.prefix));
      written.push(t);
    }
    if (o.py) writeFileSync(join(root, o.py), emitPy(abi, o.abi, o.prefix));
  }
  // emitTs is close to biome's style; biome settles line breaks so `bun run lint` stays clean
  const r = spawnSync("bun", ["x", "biome", "format", "--write", ...written], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) fail("biome format failed on the generated TypeScript");
}
