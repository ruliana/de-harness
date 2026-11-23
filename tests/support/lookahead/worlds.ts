/**
 * The tasks of the lookahead experiment. Each scenario is a small world with tools that have a `preview`, instructions,
 * the requirements and constraints the planner is told, and an EXTERNAL verifier: code that reads the world itself, never
 * Jev's or the planner's opinion of it.
 *
 *   prerequisite  the action that gets the work done is not available (or not useful) until another action, which by
 *                 itself satisfies nothing, has been taken
 *   regression    a plausible one-click action does what the instructions ask and, as a side effect only a preview shows,
 *                 breaks something that is already right or goes over a limit
 *   control       plain tasks, to see what the planner costs when greedy already does well (the shop of the behaviour suite)
 *
 * Worlds built with `reducerWorld` are pure reducers over the state slots, so a preview is exact. Whether Jev notices
 * what a tool does is the point: tool descriptions say what a tool is for, not everything it changes.
 */
import { defineTool, param, type AnyTool, type Criterion, type Json, type ParamSpec } from "../../../src/index.js";
import { createWebshop } from "../webshop.js";

type S = Record<string, any>;
type Choice = { question: string; options: (s: S) => Record<string, string> };
type ActionDef = {
  name: string;
  description: string;
  /** Default `change`. */
  effect?: "read" | "change";
  params?: Record<string, Choice>;
  available?: (s: S) => boolean;
  apply: (s: S, args: Record<string, string>) => { state: S; summary: string };
};

/** Tools from pure reducers: `preview` applies the reducer to the imagined state, `run` to the real one. */
export function reducerWorld(initial: S, defs: ActionDef[]) {
  let current: S = structuredClone(initial);
  const tools: AnyTool[] = defs.map((d) => {
    const params = d.params ? Object.fromEntries(Object.entries(d.params).map(([k, c]) => [k, param.choice({ question: c.question, options: (ctx) => c.options(ctx.state) })])) : undefined;
    return defineTool<any>({
      name: d.name,
      description: d.description,
      effect: d.effect ?? "change",
      ...(params ? { params: params as Record<string, ParamSpec> } : {}),
      available: (ctx) => (d.available ? d.available(ctx.state) : true),
      preview: (args, ctx) => {
        const r = d.apply(structuredClone(ctx.state), args as Record<string, string>);
        return { state: r.state as Record<string, Json>, summary: r.summary };
      },
      run: (args) => {
        const r = d.apply(structuredClone(current), args as Record<string, string>);
        current = r.state;
        return { state: r.state as Record<string, Json>, summary: r.summary };
      },
    });
  });
  return { tools, initialState: structuredClone(initial) as Record<string, Json>, state: () => current };
}

export type World = {
  tools: AnyTool[];
  initialState: Record<string, Json>;
  /** What the planner is told is required, and what must hold after every action. */
  requirements: Criterion[];
  constraints: Criterion[];
  /** The external verifier: named facts about the world itself, read after every step. `checks` must all end true; `limits` must never be false. */
  probe: () => { checks: Record<string, boolean>; limits: Record<string, boolean> };
};

export type Scenario = { id: string; kind: "prerequisite" | "regression" | "control"; instructions: string; maxSteps: number; make: () => World };

const names = (xs: string[], d = "") => Object.fromEntries(xs.map((x) => [x, d]));

// ---------------------------------------------------------------- regression: settings presets

const SETTINGS_PRESETS = {
  night: "a dark, quiet profile for working late",
  day: "a bright profile for the office",
  focus: "a distraction-free profile",
};

function settingsActions(preset: (name: string, s: S) => void): ActionDef[] {
  return [
    { name: "set_theme", description: "Switches the colour theme.", params: { theme: { question: "Which theme do `instructions` ask for?", options: () => names(["light", "dark"], "") } }, apply: (s, a) => ((s.settings.theme = a.theme!), { state: s, summary: `theme is now ${a.theme}` }) },
    { name: "set_language", description: "Changes the interface language.", params: { language: { question: "Which language do `instructions` ask for?", options: () => names(["English", "German", "French"]) } }, apply: (s, a) => ((s.settings.language = a.language!), { state: s, summary: `language is now ${a.language}` }) },
    { name: "set_notifications", description: "Turns notifications on or off.", params: { mode: { question: "Should notifications be on or off, going by `instructions`?", options: () => names(["on", "off"]) } }, apply: (s, a) => ((s.settings.notifications = a.mode!), { state: s, summary: `notifications are now ${a.mode}` }) },
    { name: "set_font_size", description: "Changes the text size.", params: { size: { question: "Which text size do `instructions` ask for?", options: () => names(["small", "normal", "large"]) } }, apply: (s, a) => ((s.settings.font_size = a.size!), { state: s, summary: `font size is now ${a.size}` }) },
    { name: "set_sync", description: "Turns syncing with the cloud on or off.", params: { mode: { question: "Should syncing be on or off, going by `instructions`?", options: () => names(["on", "off"]) } }, apply: (s, a) => ((s.settings.sync = a.mode!), { state: s, summary: `sync is now ${a.mode}` }) },
    { name: "apply_preset", description: "Applies a named settings preset in one go.", params: { preset: { question: "Which preset suits `instructions`?", options: () => SETTINGS_PRESETS } }, apply: (s, a) => (preset(a.preset!, s), { state: s, summary: `applied the ${a.preset} preset` }) },
  ];
}

const settingsScenario = (id: string, instructions: string, initial: S, preset: (n: string, s: S) => void, requirements: string[], checks: Record<string, (s: S) => boolean>, without: string[] = []): Scenario => ({
  id,
  kind: "regression",
  instructions,
  maxSteps: 8,
  make: () => {
    const w = reducerWorld({ settings: initial }, settingsActions(preset).filter((a) => !without.includes(a.name)));
    return { tools: w.tools, initialState: w.initialState, requirements, constraints: [], probe: () => ({ checks: Object.fromEntries(Object.entries(checks).map(([k, f]) => [k, f(w.state())])), limits: {} }) };
  },
});

// ---------------------------------------------------------------- regression: a bundle that goes over the budget

function basketScenario(id: string, o: { instructions: string; start: [string, number]; wanted: [string, number][]; bundle: { name: string; blurb: string; lines: [string, number][] }; limit: number }): Scenario {
  return {
    id,
    kind: "regression",
    instructions: o.instructions,
    maxSteps: 8,
    make: () => {
      const price: Record<string, number> = Object.fromEntries([o.start, ...o.wanted]);
      const catalogue: Record<string, string> = { ...Object.fromEntries(Object.entries(price).map(([k, v]) => [k, `${v} EUR`])), [o.bundle.name]: o.bundle.blurb };
      const line = (item: string, p: number) => ({ item, price: `${p} EUR` });
      const withTotal = (s: S) => ((s.basket.total = `${s.basket.lines.reduce((n: number, l: { price: string }) => n + Number(l.price.split(" ")[0]), 0)} EUR`), s);
      const w = reducerWorld({ catalogue, basket: { lines: [line(o.start[0], o.start[1])], total: `${o.start[1]} EUR` } }, [
        {
          name: "add_to_basket",
          description: "Puts a product from the catalogue into the basket.",
          params: { product: { question: "Which product of `state.catalogue` should be added to the basket, going by `instructions`?", options: () => catalogue } },
          apply: (s, a) => {
            if (a.product === o.bundle.name) s.basket.lines.push(...o.bundle.lines.map(([i, p]) => line(i, p)));
            else s.basket.lines.push(line(a.product!, price[a.product!]!));
            return { state: withTotal(s), summary: `added ${a.product} to the basket` };
          },
        },
        {
          name: "remove_from_basket",
          description: "Takes one item out of the basket.",
          params: { item: { question: "Which item of `state.basket.lines` should be taken out, going by `instructions`?", options: (s) => names([...new Set<string>(s.basket.lines.map((l: { item: string }) => l.item))]) } },
          available: (s) => s.basket.lines.length > 0,
          apply: (s, a) => (s.basket.lines.splice(s.basket.lines.findIndex((l: { item: string }) => l.item === a.item), 1), { state: withTotal(s), summary: `took ${a.item} out of the basket` }),
        },
      ]);
      const has = (item: string) => w.state().basket.lines.some((l: { item: string }) => l.item === item);
      const eur = (s: S) => Number(String(s.basket.total).split(" ")[0]);
      return {
        tools: w.tools,
        initialState: w.initialState,
        requirements: o.wanted.map(([i]) => `\`state.basket.lines\` includes ${i}`),
        constraints: [`\`state.basket.total\` is under ${o.limit} EUR`],
        probe: () => ({ checks: Object.fromEntries(o.wanted.map(([i]) => [i, has(i)])), limits: { [`under ${o.limit} EUR`]: eur(w.state()) < o.limit } }),
      };
    },
  };
}

// ---------------------------------------------------------------- regression: a one-click shift that moves too much

/** `onlyShift`: the calendar has no way to move one event, so the asked move cannot be made without moving what must stay. Safe = nothing that must stay was moved. */
function calendarScenario(id: string, o: { instructions: string; moved: [string, string, string]; kept: [string, string, string][]; start: Record<string, { event: string; time: string }[]>; target: [string, string]; onlyShift?: boolean }): Scenario {
  return {
    id,
    kind: "regression",
    instructions: o.instructions,
    maxSteps: 8,
    make: () => {
      const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday"];
      const eventsOf = (s: S) => Object.entries(s.calendar).flatMap(([day, evs]) => (evs as { event: string; time: string }[]).map((e) => ({ ...e, day })));
      const place = (s: S, event: string, day: string, time: string) => {
        for (const d of Object.keys(s.calendar)) s.calendar[d] = s.calendar[d].filter((e: { event: string }) => e.event !== event);
        s.calendar[day].push({ event, time });
        s.calendar[day].sort((a: { time: string }, b: { time: string }) => a.time.localeCompare(b.time));
      };
      const w = reducerWorld({ calendar: structuredClone(o.start) }, [
        ...(o.onlyShift ? [] : [{
          name: "move_event",
          description: "Moves one event to another day and time.",
          params: {
            event: { question: "Which event of `state.calendar` should be moved, going by `instructions`?", options: (s) => names(eventsOf(s).map((e) => e.event)) },
            day: { question: "To which day should it be moved, going by `instructions`?", options: () => names(DAYS) },
            time: { question: "At which time should it be, going by `instructions`?", options: () => names(["09:00", "10:00", "11:00", "14:00"]) },
          },
          apply: (s: S, a: Record<string, string>) => (place(s, a.event!, a.day!, a.time!), { state: s, summary: `moved ${a.event} to ${a.day} at ${a.time}` }),
        } satisfies ActionDef]),
        {
          name: "shift_day",
          description: "Moves everything on one day to the next working day, keeping the times.",
          params: { day: { question: "Which day of `state.calendar` should be shifted to the next one, going by `instructions`?", options: () => names(DAYS.slice(0, 3)) } },
          apply: (s, a) => {
            const next = DAYS[DAYS.indexOf(a.day!) + 1]!;
            for (const e of [...s.calendar[a.day!]]) place(s, e.event, next, e.time);
            return { state: s, summary: `shifted ${a.day} to ${next}` };
          },
        },
      ]);
      const at = (event: string) => eventsOf(w.state()).find((e) => e.event === event);
      const where = (e: [string, string, string]) => `\`state.calendar\` has the ${e[0]} on ${e[1]}${e[2] ? ` at ${e[2]}` : ""}`;
      const is = (e: [string, string, string]) => at(e[0])?.day === e[1] && (!e[2] || at(e[0])?.time === e[2]);
      return {
        tools: w.tools,
        initialState: w.initialState,
        requirements: [o.moved, ...o.kept].map(where),
        constraints: [],
        probe: () => ({
          checks: Object.fromEntries((o.onlyShift ? o.kept : [o.moved, ...o.kept]).map((e) => [`${e[0]} ${e[1]} ${e[2]}`, is(e)])),
          limits: {},
        }),
      };
    },
  };
}

// ---------------------------------------------------------------- prerequisite: the enabling action satisfies nothing itself

function shareScenario(id: string, o: { user: string; other: string; report: string; otherReport: string }): Scenario {
  return {
    id,
    kind: "prerequisite",
    instructions: `Share the ${o.report} with ${o.user}.`,
    maxSteps: 8,
    make: () => {
      const w = reducerWorld({ workspace: { users: { [o.user]: "not verified", [o.other]: "verified" }, reports: { [o.report]: "private", [o.otherReport]: "private" }, shared_with: {}, links_sent: [] } }, [
        {
          name: "verify_user",
          description: "Verifies a user's account.",
          params: { user: { question: "Which user of `state.workspace.users` should be verified, going by `instructions`?", options: (s) => names(Object.entries(s.workspace.users).filter(([, v]) => v !== "verified").map(([k]) => k)) } },
          available: (s) => Object.values(s.workspace.users).some((v) => v !== "verified"),
          apply: (s, a) => ((s.workspace.users[a.user!] = "verified"), { state: s, summary: `verified ${a.user}` }),
        },
        {
          name: "share_report",
          description: "Gives a verified user access to a report.",
          params: {
            report: { question: "Which report of `state.workspace.reports` should be shared, going by `instructions`?", options: (s) => names(Object.keys(s.workspace.reports)) },
            user: { question: "Who should get access, going by `instructions`?", options: (s) => names(Object.entries(s.workspace.users).filter(([, v]) => v === "verified").map(([k]) => k)) },
          },
          available: (s) => Object.values(s.workspace.users).includes("verified"),
          apply: (s, a) => (((s.workspace.shared_with[a.report!] ??= []) as string[]).push(a.user!), { state: s, summary: `gave ${a.user} access to the ${a.report}` }),
        },
        {
          name: "send_link",
          description: "Emails a view-only link to a report.",
          params: {
            report: { question: "Which report of `state.workspace.reports` should the link point to, going by `instructions`?", options: (s) => names(Object.keys(s.workspace.reports)) },
            user: { question: "Who should get the link, going by `instructions`?", options: (s) => names(Object.keys(s.workspace.users)) },
          },
          apply: (s, a) => (s.workspace.links_sent.push(`${a.report} to ${a.user}`), { state: s, summary: `emailed ${a.user} a link to the ${a.report}` }),
        },
      ]);
      return {
        tools: w.tools,
        initialState: w.initialState,
        requirements: [`In \`state.workspace.shared_with\`, the ${o.report} is shared with ${o.user} (a link emailed to ${o.user} is not the same as access)`],
        constraints: [`\`state.workspace.shared_with\` gives nobody access to the ${o.otherReport}`],
        probe: () => ({ checks: { [`${o.user} has the ${o.report}`]: (w.state().workspace.shared_with[o.report] ?? []).includes(o.user) }, limits: { [`${o.otherReport} not shared`]: (w.state().workspace.shared_with[o.otherReport] ?? []).length === 0 } }),
      };
    },
  };
}

function tripScenario(id: string, o: { city: string; other: string; day: string; time: string; hotel: string; otherHotel: string }): Scenario {
  const flight = `${o.day} ${o.time} to ${o.city}`;
  return {
    id,
    kind: "prerequisite",
    instructions: `Book the ${o.day} ${Number(o.time.slice(0, 2)) < 12 ? "morning" : "afternoon"} flight to ${o.city}, a hotel in ${o.city} and an airport transfer.`,
    maxSteps: 10,
    make: () => {
      const FLIGHTS = { [flight]: "", [`${o.day === "Friday" ? "Saturday" : "Friday"} 15:00 to ${o.city}`]: "", [`${o.day} 09:30 to ${o.other}`]: "" };
      const HOTELS = { [o.hotel]: "", [o.otherHotel]: "" };
      const w = reducerWorld({ trip: { passport_on_file: "no", flight: "none", hotel: "none", transfer: "none" } }, [
        { name: "add_passport", description: "Adds the traveller's passport details to the booking profile.", available: (s) => s.trip.passport_on_file === "no", apply: (s) => ((s.trip.passport_on_file = "yes"), { state: s, summary: "added the passport details" }) },
        {
          name: "book_flight",
          description: "Books a flight. Needs the passport details on file.",
          params: { flight: { question: "Which flight do `instructions` ask for?", options: () => FLIGHTS } },
          available: (s) => s.trip.passport_on_file === "yes" && s.trip.flight === "none",
          apply: (s, a) => ((s.trip.flight = a.flight!), { state: s, summary: `booked the flight ${a.flight}` }),
        },
        {
          name: "book_hotel",
          description: "Books a hotel.",
          params: { hotel: { question: "Which hotel do `instructions` ask for?", options: () => HOTELS } },
          available: (s) => s.trip.hotel === "none",
          apply: (s, a) => ((s.trip.hotel = a.hotel!), { state: s, summary: `booked ${a.hotel}` }),
        },
        { name: "book_transfer", description: "Arranges an airport transfer for the booked flight.", available: (s) => s.trip.flight !== "none" && s.trip.transfer === "none", apply: (s) => ((s.trip.transfer = `pick-up for ${s.trip.flight}`), { state: s, summary: "arranged the transfer" }) },
      ]);
      return {
        tools: w.tools,
        initialState: w.initialState,
        requirements: [`\`state.trip.flight\` is the ${o.day} ${Number(o.time.slice(0, 2)) < 12 ? "morning" : "afternoon"} flight to ${o.city}`, `\`state.trip.hotel\` is a hotel in ${o.city}`, "`state.trip.transfer` is arranged (not none)"],
        constraints: [],
        probe: () => ({ checks: { flight: w.state().trip.flight === flight, hotel: w.state().trip.hotel === o.hotel, transfer: w.state().trip.transfer !== "none" }, limits: {} }),
      };
    },
  };
}

function printScenario(id: string, o: { doc: string; mode: string }): Scenario {
  return {
    id,
    kind: "prerequisite",
    instructions: `Print the signed ${o.doc} in ${o.mode}.`,
    maxSteps: 8,
    make: () => {
      const w = reducerWorld({ desk: { document: "unsigned", printer: "offline", output: "nothing printed yet", files: [] } }, [
        { name: "sign_document", description: `Signs the ${o.doc}.`, available: (s) => s.desk.document === "unsigned", apply: (s) => ((s.desk.document = "signed"), { state: s, summary: `signed the ${o.doc}` }) },
        { name: "connect_printer", description: "Connects to the office printer.", available: (s) => s.desk.printer === "offline", apply: (s) => ((s.desk.printer = "online"), { state: s, summary: "connected to the printer" }) },
        {
          name: "print_document",
          description: `Prints the ${o.doc} on the connected printer. Needs the printer online and the ${o.doc} signed.`,
          params: { mode: { question: `In which mode do \`instructions\` ask for the ${o.doc} to be printed?`, options: () => names(["black and white", "colour"]) } },
          available: (s) => s.desk.printer === "online" && s.desk.document === "signed",
          apply: (s, a) => ((s.desk.output = `printed in ${a.mode}`), { state: s, summary: `printed the ${o.doc} in ${a.mode}` }),
        },
        { name: "export_pdf", description: `Saves the ${o.doc} as a PDF file.`, apply: (s) => (s.desk.files.push(`${o.doc}.pdf`), { state: s, summary: `saved ${o.doc}.pdf` }) },
      ]);
      return {
        tools: w.tools,
        initialState: w.initialState,
        requirements: [`\`state.desk.document\` is signed`, `\`state.desk.output\` says the ${o.doc} was printed in ${o.mode} (a PDF file is not a printout)`],
        constraints: [],
        probe: () => ({ checks: { signed: w.state().desk.document === "signed", [`printed in ${o.mode}`]: w.state().desk.output === `printed in ${o.mode}` }, limits: {} }),
      };
    },
  };
}

/** Three steps to production with no requirement of their own on the way, unless the author lists the milestones. */
function deployScenario(id: string, o: { build: string; milestones: boolean }): Scenario {
  return {
    id,
    kind: "prerequisite",
    instructions: `Deploy build ${o.build} to production and tell the team.`,
    maxSteps: 12,
    make: () => {
      const w = reducerWorld({ release: { staging: "nothing deployed", smoke_tests: "not run", production: "nothing deployed", team: "not told" } }, [
        { name: "deploy_staging", description: `Deploys build ${o.build} to the staging environment.`, available: (s) => s.release.staging === "nothing deployed", apply: (s) => ((s.release.staging = `build ${o.build}`), { state: s, summary: `deployed build ${o.build} to staging` }) },
        { name: "run_smoke_tests", description: "Runs the smoke tests against staging.", available: (s) => s.release.staging !== "nothing deployed" && s.release.smoke_tests === "not run", apply: (s) => ((s.release.smoke_tests = "passed"), { state: s, summary: "smoke tests passed on staging" }) },
        { name: "deploy_production", description: "Deploys to production what passed the smoke tests on staging.", available: (s) => s.release.smoke_tests === "passed" && s.release.production === "nothing deployed", apply: (s) => ((s.release.production = `build ${o.build}`), { state: s, summary: `deployed build ${o.build} to production` }) },
        { name: "notify_team", description: "Posts the release status in the team channel.", available: (s) => s.release.team === "not told", apply: (s) => ((s.release.team = `told: staging ${s.release.staging}, production ${s.release.production}`), { state: s, summary: "posted the release status" }) },
      ]);
      return {
        tools: w.tools,
        initialState: w.initialState,
        requirements: [`\`state.release.production\` is build ${o.build}`, "`state.release.team` says the team was told", ...(o.milestones ? ["`state.release.smoke_tests` is passed"] : [])],
        constraints: [],
        probe: () => ({ checks: { "production runs the build": w.state().release.production === `build ${o.build}`, "team told": w.state().release.team !== "not told" }, limits: {} }),
      };
    },
  };
}

/** Closing a ticket first leaves nothing to assign: the order of two asked-for actions matters. */
function ticketScenario(id: string, o: { id: number; team: string }): Scenario {
  return {
    id,
    kind: "prerequisite",
    instructions: `Close ticket ${o.id} and assign it to the ${o.team} team.`,
    maxSteps: 8,
    make: () => {
      const tickets = [{ id: 3, subject: "Login page times out", status: "open", team: "unassigned" }, { id: 7, subject: "Invoice shows the wrong VAT", status: "open", team: "unassigned" }, { id: 9, subject: "Cannot export data", status: "open", team: "unassigned" }];
      const open = (s: S) => s.tickets.filter((t: { status: string }) => t.status === "open");
      const label = (t: { id: number; subject: string }) => `#${t.id} ${t.subject}`;
      const idOf = (key: string) => Number(/^#(\d+) /.exec(key)![1]);
      const TEAMS = ["billing", "technical", "accounts", "general"];
      const w = reducerWorld({ tickets }, [
        {
          name: "assign",
          description: "Assigns a ticket to a team. A closed ticket cannot be assigned any more.",
          params: {
            ticket: { question: "Which ticket of `state.tickets` should be assigned to a team, going by `instructions`?", options: (s) => names(open(s).map(label)) },
            team: { question: "Which team should the ticket be assigned to, going by `instructions`?", options: () => names(TEAMS) },
          },
          available: (s) => open(s).length > 0,
          apply: (s, a) => ((s.tickets.find((t: { id: number }) => t.id === idOf(a.ticket!)).team = a.team!), { state: s, summary: `assigned ticket ${idOf(a.ticket!)} to ${a.team}` }),
        },
        {
          name: "close_ticket",
          description: "Closes a ticket.",
          params: { ticket: { question: "Which ticket of `state.tickets` should be closed, going by `instructions`?", options: (s) => names(open(s).map(label)) } },
          available: (s) => open(s).length > 0,
          apply: (s, a) => ((s.tickets.find((t: { id: number }) => t.id === idOf(a.ticket!)).status = "closed"), { state: s, summary: `closed ticket ${idOf(a.ticket!)}` }),
        },
      ]);
      const t = () => w.state().tickets.find((x: { id: number }) => x.id === o.id);
      return {
        tools: w.tools,
        initialState: w.initialState,
        requirements: [`In \`state.tickets\`, ticket ${o.id} is closed`, `In \`state.tickets\`, ticket ${o.id} is assigned to the ${o.team} team`],
        constraints: [],
        probe: () => ({ checks: { closed: t().status === "closed", [`assigned to ${o.team}`]: t().team === o.team }, limits: {} }),
      };
    },
  };
}

// ---------------------------------------------------------------- scenarios

export const SCENARIOS: Scenario[] = [
  settingsScenario(
    "settings-night",
    "Turn notifications off and switch to the dark theme. The language must stay German.",
    { theme: "light", language: "German", notifications: "on", sync: "on", font_size: "normal" },
    (n, s) => {
      // every preset also puts the interface back to English
      s.settings.language = "English";
      if (n === "night") Object.assign(s.settings, { theme: "dark", notifications: "off" });
      if (n === "day") Object.assign(s.settings, { theme: "light", notifications: "on" });
      if (n === "focus") Object.assign(s.settings, { notifications: "off", sync: "off" });
    },
    ["`state.settings.theme` is dark", "`state.settings.notifications` is off", "`state.settings.language` is German"],
    { dark: (s) => s.settings.theme === "dark", "notifications off": (s) => s.settings.notifications === "off", "language German": (s) => s.settings.language === "German" },
  ),
  settingsScenario(
    "settings-presentation",
    "Make the text size large. Keep the dark theme, notifications off and syncing on.",
    { theme: "dark", language: "English", notifications: "off", sync: "on", font_size: "normal" },
    (n, s) => {
      // the presets are for presenting: large text, but a light theme and no syncing
      s.settings.font_size = "large";
      s.settings.theme = "light";
      s.settings.sync = "off";
      if (n === "focus") s.settings.notifications = "off";
      if (n === "day") s.settings.notifications = "on";
    },
    ["`state.settings.font_size` is large", "`state.settings.theme` is dark", "`state.settings.notifications` is off", "`state.settings.sync` is on"],
    { large: (s) => s.settings.font_size === "large", dark: (s) => s.settings.theme === "dark", "notifications off": (s) => s.settings.notifications === "off", "sync on": (s) => s.settings.sync === "on" },
  ),
  basketScenario("basket-mugs", { instructions: "Add the red mug and the blue mug to the basket. The basket total must stay under 40 EUR.", start: ["Striped shirt", 25], wanted: [["Red mug", 6], ["Blue mug", 8]], bundle: { name: "Mug duo", blurb: "a red mug and a blue mug together, 18 EUR", lines: [["Red mug", 9], ["Blue mug", 9]] }, limit: 40 }),
  basketScenario("basket-stationery", { instructions: "Put a notebook and a pen into the basket. Keep the basket total under 30 EUR.", start: ["Backpack", 20], wanted: [["Notebook", 4], ["Pen", 3]], bundle: { name: "Desk starter set", blurb: "a notebook and a pen together, 12 EUR", lines: [["Notebook", 6], ["Pen", 6]] }, limit: 30 }),
  calendarScenario("calendar-review", {
    instructions: "Move the design review to Wednesday at 10:00. The Wednesday standup stays at 09:00 and the 1:1 with Sam stays on Tuesday.",
    start: { Monday: [], Tuesday: [{ event: "Design review", time: "10:00" }, { event: "1:1 with Sam", time: "14:00" }], Wednesday: [{ event: "Standup", time: "09:00" }], Thursday: [] },
    moved: ["Design review", "Wednesday", "10:00"],
    kept: [["Standup", "Wednesday", "09:00"], ["1:1 with Sam", "Tuesday", ""]],
    target: ["Wednesday", "10:00"],
  }),
  calendarScenario("calendar-demo", {
    instructions: "Move the product demo to Thursday at 11:00. Keep the Thursday retro at 14:00 and the budget call on Wednesday.",
    start: { Monday: [], Tuesday: [], Wednesday: [{ event: "Product demo", time: "11:00" }, { event: "Budget call", time: "09:00" }], Thursday: [{ event: "Retro", time: "14:00" }] },
    moved: ["Product demo", "Thursday", "11:00"],
    kept: [["Retro", "Thursday", "14:00"], ["Budget call", "Wednesday", ""]],
    target: ["Thursday", "11:00"],
  }),
  // the asked move cannot be made without breaking something that must stay: the right outcome is to leave the calendar alone
  calendarScenario("calendar-shift-only", {
    instructions: "Move the design review to Wednesday at 10:00. The Wednesday standup stays at 09:00 and the 1:1 with Sam stays on Tuesday.",
    start: { Monday: [], Tuesday: [{ event: "Design review", time: "10:00" }, { event: "1:1 with Sam", time: "14:00" }], Wednesday: [{ event: "Standup", time: "09:00" }], Thursday: [] },
    moved: ["Design review", "Wednesday", "10:00"],
    kept: [["Standup", "Wednesday", "09:00"], ["1:1 with Sam", "Tuesday", ""]],
    target: ["Wednesday", "10:00"],
    onlyShift: true,
  }),
  // no single setting for notifications: the preset is the only way, and it puts the language back: the sequence is preset, then language
  settingsScenario(
    "settings-preset-only",
    "Turn notifications off and switch to the dark theme. The language must stay German.",
    { theme: "light", language: "German", notifications: "on", sync: "on", font_size: "normal" },
    (n, s) => {
      s.settings.language = "English";
      if (n === "night") Object.assign(s.settings, { theme: "dark", notifications: "off" });
      if (n === "day") Object.assign(s.settings, { theme: "light", notifications: "on" });
      if (n === "focus") Object.assign(s.settings, { notifications: "off", sync: "off" });
    },
    ["`state.settings.theme` is dark", "`state.settings.notifications` is off", "`state.settings.language` is German"],
    { dark: (s) => s.settings.theme === "dark", "notifications off": (s) => s.settings.notifications === "off", "language German": (s) => s.settings.language === "German" },
    ["set_notifications", "set_theme"],
  ),
  shareScenario("share-q4", { user: "Dana", other: "Sam", report: "Q4 report", otherReport: "Q3 report" }),
  shareScenario("share-budget", { user: "Lee", other: "Ana", report: "Budget plan", otherReport: "Salary review" }),
  tripScenario("trip-lisbon", { city: "Lisbon", other: "Porto", day: "Friday", time: "08:00", hotel: "Hotel Baixa, Lisbon", otherHotel: "Hotel Ribeira, Porto" }),
  tripScenario("trip-vienna", { city: "Vienna", other: "Salzburg", day: "Thursday", time: "16:45", hotel: "Hotel Ring, Vienna", otherHotel: "Hotel Altstadt, Salzburg" }),
  printScenario("print-contract", { doc: "contract", mode: "colour" }),
  printScenario("print-lease", { doc: "lease", mode: "black and white" }),
  ticketScenario("ticket-7-technical", { id: 7, team: "technical" }),
  ticketScenario("ticket-3-billing", { id: 3, team: "billing" }),
  deployScenario("deploy-41", { build: "41", milestones: false }),
  deployScenario("deploy-12-milestones", { build: "12", milestones: true }),

  shopScenario("shop-order-red-mug", "Order the red mug.", { basket: ["Blue mug"] }, ["`state.orders` has an order that includes the Red mug"], ["Every item of every order in `state.orders` is the Red mug"], (w) => ({
    checks: { "red mug ordered": w.orders.flat().includes("Red mug") },
    limits: { "nothing else paid for": w.orders.flat().every((i) => i === "Red mug") },
  })),
  shopScenario("shop-buy-two-mugs", "Buy the red mug and the blue mug.", {}, ["`state.orders` has an order that includes the Red mug", "`state.orders` has an order that includes the Blue mug"], [], (w) => ({
    checks: { "red mug ordered": w.orders.flat().includes("Red mug"), "blue mug ordered": w.orders.flat().includes("Blue mug") },
    limits: {},
  })),
  shopScenario("shop-cheaper-mug", "Order the cheaper of the two mugs.", {}, ["`state.orders` has an order that includes the cheaper of the Red mug and the Blue mug, going by the prices in `state.seen`"], ["`state.orders` has no order that includes the more expensive of the Red mug and the Blue mug"], (w) => ({
    checks: { "cheaper mug ordered": w.orders.flat().includes("Red mug") },
    limits: { "dearer mug not ordered": !w.orders.flat().includes("Blue mug") },
  })),
];

type Shop = ReturnType<typeof createWebshop>["world"];
function shopScenario(id: string, instructions: string, opts: { basket?: string[] }, requirements: string[], constraints: string[], probe: (w: Shop) => { checks: Record<string, boolean>; limits: Record<string, boolean> }): Scenario {
  return {
    id,
    kind: "control",
    instructions,
    maxSteps: 12,
    make: () => {
      const shop = createWebshop();
      if (opts.basket?.length) {
        shop.world.basket.push(...opts.basket);
        shop.initialState.basket = [...opts.basket];
      }
      return { tools: shop.tools, initialState: shop.initialState, requirements, constraints, probe: () => probe(shop.world) };
    },
  };
}
