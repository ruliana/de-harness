/**
 * A front-desk assistant with thirty tools, the "many tools" domain for the scale item.
 * Each tool does one distinct office chore and has one parameter, a Choice over candidates the tool supplies.
 * Nothing real happens: a tool records what it did in `world.done` and in the `last_action` slot.
 */
import { defineTool, type AnyTool, type Json } from "../../src/index.js";

type Chore = { name: string; description: string; question: string; options: string[] };

const chores: Chore[] = [
  { name: "book_meeting_room", description: "Reserves a meeting room for a team meeting.", question: "Which meeting room do `instructions` ask to reserve?", options: ["Aurora (4 seats)", "Borealis (12 seats)", "Cirrus (30 seats)"] },
  { name: "order_catering", description: "Orders food and drinks from a caterer for an event in the office.", question: "Which menu do `instructions` ask for?", options: ["sandwich platter", "hot lunch", "pastries and coffee"] },
  { name: "print_document", description: "Sends a document to one of the office printers.", question: "Which printer do `instructions` ask to print on?", options: ["first floor black and white", "second floor colour", "plotter in the design studio"] },
  { name: "reset_password", description: "Resets the password of an employee account and emails a temporary one.", question: "Which account do `instructions` ask to reset?", options: ["email", "payroll portal", "vpn", "source repository"] },
  { name: "request_laptop", description: "Requests a new laptop for an employee from IT procurement.", question: "Which laptop model do `instructions` ask for?", options: ["light 13 inch", "standard 15 inch", "workstation 17 inch"] },
  { name: "report_broken_light", description: "Reports a broken light bulb or lamp to facilities.", question: "On which floor do `instructions` say the light is broken?", options: ["ground floor", "first floor", "second floor", "basement"] },
  { name: "set_thermostat", description: "Changes the target temperature of a heating zone.", question: "Which temperature setting do `instructions` ask for?", options: ["cooler", "unchanged", "warmer"] },
  {
    name: "register_visitor",
    description: "Signs a visitor in at the front desk: prints a visitor badge and tells their host that they have arrived.",
    question: "Which of the visitors in `state.expected_visitors` do `instructions` ask to sign in?",
    options: [],
  },
  { name: "reserve_parking_spot", description: "Reserves a parking spot in the company car park for a day.", question: "Which kind of spot do `instructions` ask for?", options: ["standard", "electric charging", "accessible"] },
  { name: "submit_expense", description: "Files an expense report for money an employee spent.", question: "Which category do `instructions` give for the expense?", options: ["meals", "travel", "equipment", "training"] },
  { name: "request_leave", description: "Requests time off for an employee.", question: "Which kind of leave do `instructions` ask for?", options: ["vacation", "sick leave", "parental leave", "unpaid leave"] },
  { name: "order_office_supplies", description: "Orders stationery and small supplies for the office.", question: "Which supply do `instructions` say is running out?", options: ["paper", "pens", "toner", "sticky notes"] },
  { name: "schedule_cleaning", description: "Schedules an extra cleaning of part of the office.", question: "Which area do `instructions` ask to have cleaned?", options: ["kitchen", "meeting rooms", "open space", "restrooms"] },
  { name: "open_it_ticket", description: "Opens a ticket with the IT helpdesk about a problem with a computer or a service.", question: "How urgent do `instructions` say the IT problem is?", options: ["low", "normal", "urgent"] },
  { name: "book_travel", description: "Books a business trip for an employee.", question: "Which way of travelling do `instructions` ask for?", options: ["train", "flight", "rental car"] },
  { name: "update_directory_entry", description: "Changes one detail of an employee in the company directory.", question: "Which detail do `instructions` ask to change?", options: ["phone number", "job title", "desk location", "photo"] },
  { name: "send_company_announcement", description: "Sends an announcement by email to a group of employees.", question: "Which audience do `instructions` ask to announce to?", options: ["everyone", "one department", "managers only"] },
  { name: "grant_building_access", description: "Gives a badge access to a restricted zone of the building.", question: "Which zone do `instructions` ask to open?", options: ["server room", "archive", "roof terrace", "laboratory"] },
  { name: "order_taxi", description: "Orders a taxi to pick someone up at the office.", question: "Where do `instructions` say the taxi should go?", options: ["airport", "central station", "hotel district"] },
  { name: "book_desk", description: "Books a desk in the shared open space for a day.", question: "On which floor do `instructions` ask for a desk?", options: ["first floor", "second floor", "third floor"] },
  { name: "recycle_electronics", description: "Arranges the pickup of old electronics for recycling.", question: "Which item do `instructions` ask to recycle?", options: ["monitors", "laptops", "phones", "cables"] },
  { name: "subscribe_newsletter", description: "Subscribes an employee to an internal mailing list.", question: "Which list do `instructions` ask to subscribe to?", options: ["engineering news", "social events", "security alerts"] },
  { name: "request_badge", description: "Requests a new or replacement access badge for an employee.", question: "Which kind of badge do `instructions` ask for?", options: ["new employee", "replacement for a lost badge", "temporary contractor"] },
  { name: "file_complaint", description: "Files a complaint with the facilities team about the workplace.", question: "What do `instructions` say the complaint is about?", options: ["noise", "temperature", "cleanliness", "furniture"] },
  { name: "rent_bike", description: "Reserves a company bike for a trip around town.", question: "Which bike do `instructions` ask for?", options: ["city bike", "electric bike", "cargo bike"] },
  { name: "refill_coffee_machine", description: "Asks for the coffee machine to be refilled with beans and water.", question: "Which coffee machine do `instructions` mean?", options: ["kitchen", "lobby", "second floor lounge"] },
  { name: "start_fire_drill", description: "Starts the scheduled fire evacuation drill for a building.", question: "Which building do `instructions` ask to run the drill in?", options: ["main building", "annex", "warehouse"] },
  { name: "archive_documents", description: "Sends old paper documents to long-term storage.", question: "Which cabinet do `instructions` ask to archive?", options: ["contracts", "invoices", "personnel files"] },
  { name: "renew_software_license", description: "Renews a paid software licence before it expires.", question: "Which product do `instructions` ask to renew?", options: ["design suite", "code editor", "video calls", "accounting"] },
  { name: "schedule_interview", description: "Schedules a job interview with a candidate.", question: "For which position do `instructions` ask for an interview?", options: ["backend developer", "designer", "office manager"] },
];

export function createOffice(opts: { visitors?: string[] } = {}) {
  const visitors = opts.visitors ?? ["Dr. Okafor", "Mr. Lindqvist", "Ms. Tanaka"];
  const done: { tool: string; choice: string }[] = [];
  const tools: AnyTool[] = chores.map((c) =>
    defineTool({
      name: c.name,
      description: c.description,
      params: {
        choice: {
          kind: "choice" as const,
          question: c.question,
          options: c.name === "register_visitor" ? (ctx) => ctx.state.expected_visitors ?? [] : c.options,
        },
      },
      run: (args: { choice: string }) => {
        done.push({ tool: c.name, choice: args.choice });
        return { state: { last_action: `${c.name}: ${args.choice}` } as Record<string, Json>, summary: `${c.name} with ${args.choice}` };
      },
    }),
  );
  return { tools, initialState: { expected_visitors: visitors } as Record<string, Json>, done };
}
