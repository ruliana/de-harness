/**
 * The diagram, as Mermaid text. The text is the state of the agent: a tool reads it (`parse`), changes it and writes it back (`toMermaid`),
 * and the text that comes out is the only copy. The format is one fixed shape of a Mermaid flowchart, so that what is written can be read again:
 *
 *   flowchart TD
 *     n1["Enter credentials"]
 *     n2["Check password"]
 *     n1 --> n2
 *     n2 -->|Invalid| n1
 *
 * Nodes are `n<number>["label"]`, edges are `from --> to` with an optional `|label|`. Labels are unique and may not hold quotes, `|` or brackets.
 */
export type Node = { id: string; label: string };
export type Edge = { from: string; to: string; label: string | null };
export type Graph = { nodes: Node[]; edges: Edge[] };

export const EMPTY = "flowchart TD";

/** Characters that would break the line they are in. */
const FORBIDDEN = /["'|\[\](){}<>\n\\]/;
export const isLabel = (s: string): boolean => s.trim() === s && s.length > 0 && s.length <= 40 && !FORBIDDEN.test(s);

export function toMermaid(g: Graph): string {
  const lines = [EMPTY, ...g.nodes.map((n) => `  ${n.id}["${n.label}"]`)];
  for (const e of g.edges) lines.push(`  ${e.from} -->${e.label ? `|${e.label}|` : ""} ${e.to}`);
  return lines.join("\n");
}

/** Reads the text that `toMermaid` writes (and hand-written text of the same shape). Throws on anything else, so that a drifted text is never taken for a diagram. */
export function parse(text: string): Graph {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== EMPTY) throw new Error(`diagram: expected "${EMPTY}" on the first line, got "${lines[0] ?? ""}"`);
  const g: Graph = { nodes: [], edges: [] };
  for (const line of lines.slice(1)) {
    const node = /^(n\d+)\["([^"]+)"\]$/.exec(line);
    if (node) {
      g.nodes.push({ id: node[1]!, label: node[2]! });
      continue;
    }
    const edge = /^(n\d+) -->(?:\|([^|]+)\|)? (n\d+)$/.exec(line);
    if (edge) {
      g.edges.push({ from: edge[1]!, to: edge[3]!, label: edge[2] ?? null });
      continue;
    }
    throw new Error(`diagram: cannot read the line "${line}"`);
  }
  for (const e of g.edges) {
    for (const id of [e.from, e.to]) if (!g.nodes.some((n) => n.id === id)) throw new Error(`diagram: the edge ${e.from} --> ${e.to} names ${id}, which is not a node`);
  }
  return g;
}

export const labelOf = (g: Graph, id: string): string => g.nodes.find((n) => n.id === id)?.label ?? id;
export const nodeByLabel = (g: Graph, label: string): Node | undefined => g.nodes.find((n) => n.label === label);

/** An edge as the model chooses it: `Check password --Invalid--> Show error message`, or `Enter credentials --> Check password`. */
export const edgeKey = (g: Graph, e: Edge): string => `${labelOf(g, e.from)} ${e.label ? `--${e.label}-->` : "-->"} ${labelOf(g, e.to)}`;

export function addNode(g: Graph, label: string): Graph {
  if (!isLabel(label)) throw new Error(`diagram: "${label}" is not a usable label`);
  if (nodeByLabel(g, label)) throw new Error(`diagram: there is already a node "${label}"`);
  const next = Math.max(0, ...g.nodes.map((n) => Number(n.id.slice(1)))) + 1;
  return { nodes: [...g.nodes, { id: `n${next}`, label }], edges: g.edges };
}

export function removeNode(g: Graph, label: string): Graph {
  const node = nodeByLabel(g, label);
  if (!node) throw new Error(`diagram: no node "${label}"`);
  return { nodes: g.nodes.filter((n) => n !== node), edges: g.edges.filter((e) => e.from !== node.id && e.to !== node.id) };
}

export function renameNode(g: Graph, label: string, to: string): Graph {
  const node = nodeByLabel(g, label);
  if (!node) throw new Error(`diagram: no node "${label}"`);
  if (!isLabel(to)) throw new Error(`diagram: "${to}" is not a usable label`);
  if (to !== label && nodeByLabel(g, to)) throw new Error(`diagram: there is already a node "${to}"`);
  return { nodes: g.nodes.map((n) => (n === node ? { ...n, label: to } : n)), edges: g.edges };
}

export function connect(g: Graph, from: string, to: string, label: string | null): Graph {
  const [a, b] = [nodeByLabel(g, from), nodeByLabel(g, to)];
  if (!a || !b) throw new Error(`diagram: cannot connect "${from}" to "${to}"`);
  if (label !== null && !isLabel(label)) throw new Error(`diagram: "${label}" is not a usable label`);
  if (g.edges.some((e) => e.from === a.id && e.to === b.id)) throw new Error(`diagram: "${from}" is already connected to "${to}"`);
  return { nodes: g.nodes, edges: [...g.edges, { from: a.id, to: b.id, label }] };
}

export function disconnect(g: Graph, key: string): Graph {
  const edge = g.edges.find((e) => edgeKey(g, e) === key);
  if (!edge) throw new Error(`diagram: no edge "${key}"`);
  return { nodes: g.nodes, edges: g.edges.filter((e) => e !== edge) };
}

export function relabelEdge(g: Graph, key: string, label: string): Graph {
  const edge = g.edges.find((e) => edgeKey(g, e) === key);
  if (!edge) throw new Error(`diagram: no edge "${key}"`);
  if (!isLabel(label)) throw new Error(`diagram: "${label}" is not a usable label`);
  return { nodes: g.nodes, edges: g.edges.map((e) => (e === edge ? { ...e, label } : e)) };
}

/** The graph in a form that tests compare: labels instead of ids, edges as `from|label|to`, both sorted. */
export function shape(g: Graph): { nodes: string[]; edges: string[] } {
  return { nodes: g.nodes.map((n) => n.label).sort(), edges: g.edges.map((e) => `${labelOf(g, e.from)}|${e.label ?? ""}|${labelOf(g, e.to)}`).sort() };
}
