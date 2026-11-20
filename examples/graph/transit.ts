/**
 * Navigating a graph: a small transit map. The model sees the lines (`state.network`) and where it stands
 * (`state.location`); the next stations on offer are the neighbours it has not visited yet, filtered in code.
 *
 *   move(station)   ride one stop to an unvisited neighbouring station (only while there is one)
 *   end             built in: chosen when `instructions` are carried out, i.e. at the named station
 *
 * Nothing is revisited by construction, so the walk is simple; getting to the target quickly is Jev's judgment.
 */
import { defineTool, param, type AnyTool, type Json } from "../../src/index.js";

export type Lines = Record<string, string[]>;

export const defaultLines: Lines = {
  "Red line": ["Airport", "Northgate", "Central", "Riverside", "Harbour"],
  "Blue line": ["Westfield", "Museum", "Central", "Market", "Stadium"],
  "Green line": ["Northgate", "Museum", "Old Town", "Market", "Southpark"],
  "Yellow line": ["Riverside", "Old Town", "Hillcrest"],
};

/** station -> neighbour -> the line that connects them */
export function adjacency(lines: Lines): Record<string, Record<string, string>> {
  const graph: Record<string, Record<string, string>> = {};
  for (const [line, stations] of Object.entries(lines)) {
    for (let i = 0; i < stations.length; i++) {
      const here = (graph[stations[i]!] ??= {});
      for (const j of [i - 1, i + 1]) {
        const other = stations[j];
        if (other !== undefined) here[other] ??= line;
      }
    }
  }
  return graph;
}

/** Number of rides on the shortest route, or undefined when there is none. */
export function shortestPath(lines: Lines, from: string, to: string): number | undefined {
  const graph = adjacency(lines);
  const dist = new Map([[from, 0]]);
  const queue = [from];
  for (const s of queue) {
    if (s === to) return dist.get(s);
    for (const n of Object.keys(graph[s] ?? {})) {
      if (!dist.has(n)) {
        dist.set(n, dist.get(s)! + 1);
        queue.push(n);
      }
    }
  }
  return undefined;
}

export function createTransit(opts: { lines?: Lines; start?: string } = {}) {
  const lines = opts.lines ?? defaultLines;
  const graph = adjacency(lines);
  const start = opts.start ?? "Airport";
  const world = { at: start, path: [start] };

  const slots = (): Record<string, Json> => {
    const visited = new Set(world.path);
    return {
      network: lines,
      location: {
        station: world.at,
        // visited stations are filtered out here, in code
        next: Object.fromEntries(Object.entries(graph[world.at] ?? {}).filter(([n]) => !visited.has(n))),
      },
      visited: world.path,
    };
  };

  const tools: AnyTool[] = [
    defineTool({
      name: "move",
      description: "Rides one stop along a line to a neighbouring station that has not been visited yet, to get closer to the destination.",
      params: {
        station: param.choice({
          question: "Which of the stations in `state.location.next` is on the shortest route from `state.location.station` to the destination named in `instructions`, going by `state.network`?",
          options: (ctx) => ctx.state.location?.next ?? {},
        }),
      },
      available: (ctx) => Object.keys(ctx.state.location?.next ?? {}).length > 0,
      run: ({ station }) => {
        const line = graph[world.at]?.[station];
        if (!line || world.path.includes(station)) throw new Error(`Cannot move to ${station} from ${world.at}`);
        world.at = station;
        world.path.push(station);
        return { state: slots(), summary: `rode the ${line} to ${station}` };
      },
    }),
  ];

  return { tools, initialState: slots(), world, lines };
}
