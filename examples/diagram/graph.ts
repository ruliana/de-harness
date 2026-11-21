/**
 * The diagram, as Mermaid text. The text is the state of the agent: a tool reads it (`parse`), changes it and writes it back (`toMermaid`),
 * and the text that comes out is the only copy. Two kinds of diagram, each in one fixed shape, so that what is written can be read again:
 *
 *   flowchart TD                          sequenceDiagram
 *     n1["Enter credentials"]                participant n1 as User
 *     n2["Check password"]                   participant n2 as Server
 *     n1 --> n2                             n1->>n2: Enter credentials
 *     n2 -->|Invalid| n1                    alt Credentials invalid
 *                                             n2-->>n1: Invalid credentials
 *                                           end
 *
 * Nodes (the steps of a flowchart, the participants of a sequence diagram) are `n<number>`. Edges (arrows, messages) are in the order of the
 * text; in a sequence diagram that order is the order in time, and the first message between two participants is a request (`->>`) while
 * the ones the other way are replies (`-->>`, dotted): code works that out, the model never says it. A message may belong to a case
 * (`alt Credentials valid` ... `else Credentials invalid` ... `end`): messages next to each other with the same case are one branch. An empty text is a diagram nobody has
 * started: the first tool says which kind it is. Labels (and cases) are unique among nodes and may not hold quotes, `|`, `:`, `;`, `#` or brackets.
 */
export type Kind = "flowchart" | "sequence";
export type Node = { id: string; label: string };
/** `case`: the branch of a sequence diagram that the message is in (`null`: in none). */
export type Edge = { from: string; to: string; label: string | null; case?: string | null };
/** `kind` is null for a diagram that has not been started: its text is empty. */
export type Graph = { kind: Kind | null; nodes: Node[]; edges: Edge[] };

export const EMPTY = "";
export const HEADER: Record<Kind, string> = { flowchart: "flowchart TD", sequence: "sequenceDiagram" };

/** Characters that would break the line they are in. */
const FORBIDDEN = /["'|:;#\[\](){}<>\n\\]/;
export const isLabel = (s: string): boolean => s.trim() === s && s.length > 0 && s.length <= 40 && !FORBIDDEN.test(s);

export const labelOf = (g: Graph, id: string): string => g.nodes.find((n) => n.id === id)?.label ?? id;
export const nodeByLabel = (g: Graph, label: string): Node | undefined => g.nodes.find((n) => n.label === label);

/** In a sequence diagram: is this message a reply? It is when the first message between the two participants went the other way. */
function isReply(g: Graph, index: number): boolean {
  const e = g.edges[index]!;
  if (e.from === e.to) return false;
  const first = g.edges.find((x) => (x.from === e.from && x.to === e.to) || (x.from === e.to && x.to === e.from))!;
  return first.from !== e.from;
}

export function toMermaid(g: Graph): string {
  if (g.kind === null) return EMPTY;
  if (g.kind === "flowchart") {
    const lines = [HEADER.flowchart, ...g.nodes.map((n) => `  ${n.id}["${n.label}"]`)];
    for (const e of g.edges) lines.push(`  ${e.from} -->${e.label ? `|${e.label}|` : ""} ${e.to}`);
    return lines.join("\n");
  }
  const lines = [HEADER.sequence, ...g.nodes.map((n) => `  participant ${n.id} as ${n.label}`)];
  let open: string | null = null;
  g.edges.forEach((e, i) => {
    const now = e.case ?? null;
    if (now !== open) {
      if (now === null) lines.push("  end");
      else if (open === null) lines.push(`  alt ${now}`);
      else lines.push(`  else ${now}`);
      open = now;
    }
    lines.push(`  ${open === null ? "" : "  "}${e.from}${isReply(g, i) ? "-->>" : "->>"}${e.to}: ${e.label ?? ""}`);
  });
  if (open !== null) lines.push("  end");
  return lines.join("\n");
}

/** Reads the text that `toMermaid` writes (and hand-written text of the same shape). Throws on anything else, so that a drifted text is never taken for a diagram. */
export function parse(text: string): Graph {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { kind: null, nodes: [], edges: [] };
  const kind = (Object.keys(HEADER) as Kind[]).find((k) => HEADER[k] === lines[0]);
  if (!kind) throw new Error(`diagram: expected "${HEADER.flowchart}" or "${HEADER.sequence}" on the first line, got "${lines[0]}"`);
  const g: Graph = { kind, nodes: [], edges: [] };
  let branch: string | null = null;
  for (const line of lines.slice(1)) {
    const block = kind === "sequence" ? /^(alt|else) (.+)$/.exec(line) : null;
    if (block) {
      branch = block[2]!;
      continue;
    }
    if (kind === "sequence" && line === "end") {
      branch = null;
      continue;
    }
    const node = kind === "flowchart" ? /^(n\d+)\["([^"]+)"\]$/.exec(line) : /^participant (n\d+) as (.+)$/.exec(line);
    if (node) {
      g.nodes.push({ id: node[1]!, label: node[2]! });
      continue;
    }
    const edge = kind === "flowchart" ? /^(n\d+) -->(?:\|([^|]+)\|)? (n\d+)$/.exec(line) : /^(n\d+)-?->>(n\d+): (.+)$/.exec(line);
    if (edge) {
      g.edges.push(kind === "flowchart" ? { from: edge[1]!, to: edge[3]!, label: edge[2] ?? null } : { from: edge[1]!, to: edge[2]!, label: edge[3]!, case: branch });
      continue;
    }
    throw new Error(`diagram: cannot read the line "${line}"`);
  }
  for (const e of g.edges) {
    for (const id of [e.from, e.to]) if (!g.nodes.some((n) => n.id === id)) throw new Error(`diagram: the edge ${e.from} to ${e.to} names ${id}, which is not a node`);
  }
  return g;
}

/** What a node and an edge are called in this kind of diagram, for the words of the panel. */
export const words = (kind: Kind | null): { node: string; nodes: string; edge: string; edges: string } =>
  kind === "sequence" ? { node: "participant", nodes: "participants", edge: "message", edges: "messages" } : { node: "step", nodes: "steps", edge: "arrow", edges: "arrows" };

/**
 * An edge as the model chooses it. A flowchart: `Check password --Invalid--> Show error message`, or `Enter credentials --> Check password`.
 * A sequence diagram: `2. Browser -> Server: Send login request` (the number is its place in time: two messages can join the same pair).
 */
export function edgeKey(g: Graph, e: Edge): string {
  if (g.kind === "sequence") return `${g.edges.indexOf(e) + 1}. ${labelOf(g, e.from)} -> ${labelOf(g, e.to)}: ${e.label}`;
  return `${labelOf(g, e.from)} ${e.label ? `--${e.label}-->` : "-->"} ${labelOf(g, e.to)}`;
}
const edgeOf = (g: Graph, key: string): Edge => {
  const edge = g.edges.find((e) => edgeKey(g, e) === key);
  if (!edge) throw new Error(`diagram: no edge "${key}"`);
  return edge;
};

export const start = (g: Graph, kind: Kind): Graph => {
  if (g.kind !== null) throw new Error("diagram: it has been started already");
  return { kind, nodes: [], edges: [] };
};

export function addNode(g: Graph, label: string): Graph {
  if (g.kind === null) throw new Error("diagram: start the diagram first");
  if (!isLabel(label)) throw new Error(`diagram: "${label}" is not a usable label`);
  if (nodeByLabel(g, label)) throw new Error(`diagram: there is already a node "${label}"`);
  const next = Math.max(0, ...g.nodes.map((n) => Number(n.id.slice(1)))) + 1;
  return { ...g, nodes: [...g.nodes, { id: `n${next}`, label }] };
}

export function removeNode(g: Graph, label: string): Graph {
  const node = nodeByLabel(g, label);
  if (!node) throw new Error(`diagram: no node "${label}"`);
  return { ...g, nodes: g.nodes.filter((n) => n !== node), edges: g.edges.filter((e) => e.from !== node.id && e.to !== node.id) };
}

export function renameNode(g: Graph, label: string, to: string): Graph {
  const node = nodeByLabel(g, label);
  if (!node) throw new Error(`diagram: no node "${label}"`);
  if (!isLabel(to)) throw new Error(`diagram: "${to}" is not a usable label`);
  if (to !== label && nodeByLabel(g, to)) throw new Error(`diagram: there is already a node "${to}"`);
  return { ...g, nodes: g.nodes.map((n) => (n === node ? { ...n, label: to } : n)) };
}

/** A flowchart arrow, from one node to another, with a label or without. */
export function connect(g: Graph, from: string, to: string, label: string | null): Graph {
  const [a, b] = [nodeByLabel(g, from), nodeByLabel(g, to)];
  if (g.kind !== "flowchart") throw new Error("diagram: only a flowchart has arrows");
  if (!a || !b) throw new Error(`diagram: cannot connect "${from}" to "${to}"`);
  if (label !== null && !isLabel(label)) throw new Error(`diagram: "${label}" is not a usable label`);
  if (g.edges.some((e) => e.from === a.id && e.to === b.id)) throw new Error(`diagram: "${from}" is already connected to "${to}"`);
  return { ...g, edges: [...g.edges, { from: a.id, to: b.id, label }] };
}

/** A message of a sequence diagram, in a case or in none: after the last message, or, when its case has messages already, after the last of them, so that a branch stays in one piece. */
export function addMessage(g: Graph, from: string, to: string, label: string, branch: string | null = null): Graph {
  const [a, b] = [nodeByLabel(g, from), nodeByLabel(g, to)];
  if (g.kind !== "sequence") throw new Error("diagram: only a sequence diagram has messages");
  if (!a || !b) throw new Error(`diagram: cannot send a message from "${from}" to "${to}"`);
  if (!isLabel(label)) throw new Error(`diagram: "${label}" is not a usable label`);
  if (branch !== null && !isLabel(branch)) throw new Error(`diagram: "${branch}" is not a usable label`);
  const message = { from: a.id, to: b.id, label, case: branch };
  const lastInBranch = branch === null ? -1 : g.edges.map((e) => e.case ?? null).lastIndexOf(branch);
  const at = lastInBranch < 0 ? g.edges.length : lastInBranch + 1;
  return { ...g, edges: [...g.edges.slice(0, at), message, ...g.edges.slice(at)] };
}

export function disconnect(g: Graph, key: string): Graph {
  const edge = edgeOf(g, key);
  return { ...g, edges: g.edges.filter((e) => e !== edge) };
}

export function relabelEdge(g: Graph, key: string, label: string): Graph {
  const edge = edgeOf(g, key);
  if (!isLabel(label)) throw new Error(`diagram: "${label}" is not a usable label`);
  return { ...g, edges: g.edges.map((e) => (e === edge ? { ...e, label } : e)) };
}

/** The graph in a form that tests compare: labels instead of ids, edges as `from|label|to`; nodes and (in a flowchart) edges sorted, the messages of a sequence diagram in their order. */
export function shape(g: Graph): { kind: Kind | null; nodes: string[]; edges: string[] } {
  const edges = g.edges.map((e) => `${labelOf(g, e.from)}|${e.label ?? ""}|${labelOf(g, e.to)}${e.case ? ` [${e.case}]` : ""}`);
  return { kind: g.kind, nodes: g.nodes.map((n) => n.label).sort(), edges: g.kind === "sequence" ? edges : edges.sort() };
}
