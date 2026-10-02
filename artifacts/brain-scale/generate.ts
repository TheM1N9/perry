import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// node artifacts/brain-scale/generate.ts <home> [--scale 1] [--seed 7] [--vectors <models dir>] [--model <id>]
//
// A synthetic three-year Brain for issue #220, written into <home>/perry.sqlite as Perry at main 34628c4 leaves
// one: pages in `notes`, every line a row in `memories` with its page, order, section, layer and dates, and (with
// --vectors) each line's vector inside its row as base64 float32 from the sentence model main uses. About 100,000
// lines at scale 1: a journal of ~30 lines a day for three years, Things to remember in the thousands, a page for
// each of 300 people, four projects with their own Things to remember, and ~3,000 pages of the owner's own
// (meetings, books, recipes, trips, logs, lists). Planted among them are lines with a known question each, written
// to <home>/labels.json with the ids of the lines that answer them, for recall@k: by words, by meaning only, across
// languages (Hindi, Telugu), the latest of several, and facts on a person's page.
//
// Node, not Bun (Bun has no node:sqlite); no relative imports, so Node runs it as it is. Everything here is made up.

const args = process.argv.slice(2);
const home = args[0];
if (!home || home.startsWith("--")) throw new Error("usage: node artifacts/brain-scale/generate.ts <home> [--scale 1] [--seed 7] [--vectors <models dir>]");
const flag = (name: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const SCALE = Number(flag("scale") ?? 1);
const SEED = Number(flag("seed") ?? 7);
const VECTORS = flag("vectors");
const MODEL = flag("model") ?? "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

// --- Words ---------------------------------------------------------------------------------------------------------

const FIRST = [
  "Aarav", "Aditi", "Akhil", "Ananya", "Anil", "Anjali", "Arjun", "Asha", "Bhavana", "Chaitanya", "Deepa", "Dev", "Farhan", "Gautam",
  "Gayatri", "Harsha", "Ishaan", "Jaya", "Karthik", "Kavitha", "Kiran", "Madhav", "Manasa", "Meghana", "Mohan", "Nandini", "Naveen",
  "Neha", "Nikhil", "Padma", "Pooja", "Pradeep", "Priya", "Rahul", "Rajesh", "Ramya", "Ravi", "Sahana", "Sai", "Sameer", "Sandeep",
  "Sanjana", "Shreya", "Siddharth", "Sneha", "Srinivas", "Sruthi", "Suresh", "Swathi", "Tanvi", "Tarun", "Uday", "Varun", "Vidya", "Vikram",
  "Vinay", "Yamini", "Zoya", "Imran", "Ayesha", "Joseph", "Maria", "Daniel", "Sarah", "Tom", "Emma", "Lucas", "Olivia", "Hiroshi", "Mei",
  "Carlos", "Sofia", "Ahmed", "Fatima", "Noah", "Leah", "Omar", "Hana", "Ethan", "Grace", "Mateo", "Chloe", "Ravindra", "Sunitha", "Venu",
  "Prakash", "Rekha", "Satish", "Usha", "Bala", "Geetha", "Hemant", "Indira", "Jagan", "Kamala", "Lokesh", "Mani", "Nirmala", "Pavan",
];
const LAST = [
  "Reddy", "Rao", "Sharma", "Iyer", "Nair", "Menon", "Kapoor", "Gupta", "Verma", "Khan", "Patel", "Shah", "Das", "Bose", "Chowdary", "Naidu",
  "Varma", "Pillai", "Kulkarni", "Joshi", "Desai", "Mehta", "Singh", "Mishra", "Banerjee", "Fernandes", "D'Souza", "Thomas", "George",
  "Mathew", "Kumar", "Prasad", "Murthy", "Hegde", "Shetty", "Bhat", "Agarwal", "Malhotra", "Saxena", "Tiwari", "Chandra", "Goud", "Yadav",
  "Ali", "Hussain", "Siddiqui", "Tanaka", "Chen", "Garcia", "Silva", "Martin", "Brown", "Wilson", "Lee", "Park", "Kim", "Lopez",
];
const RELATIONS = [
  "a friend from college", "a colleague at Tidewell", "a client", "a neighbour", "a cousin", "a friend from the running club", "an investor",
  "a former colleague at Infosys", "a friend from school", "my badminton partner", "a mentor", "a designer we contract with", "our accountant",
  "a parent from Kavya's school", "the landlord's son", "a friend from the book club", "a co-founder of a startup we work with",
];
const COMPANIES = ["Infosys", "Swiggy", "Zomato", "Microsoft", "Google", "Amazon", "Deloitte", "TCS", "Wipro", "Razorpay", "Freshworks", "Zoho", "Flipkart", "Dr. Reddy's", "Apollo Hospitals", "Finlytics", "Kotak", "HDFC Bank", "Accenture", "PhonePe", "CRED", "Meesho"];
const ROLES = ["product manager", "engineer", "designer", "data scientist", "founder", "sales lead", "consultant", "teacher", "lawyer", "architect", "analyst", "HR lead"];
const AREAS = ["Gachibowli", "Kondapur", "Madhapur", "Jubilee Hills", "Banjara Hills", "Kukatpally", "Miyapur", "Begumpet", "Secunderabad", "Manikonda", "Kokapet", "Ameerpet"];
const CITIES = ["Hyderabad", "Bengaluru", "Pune", "Chennai", "Mumbai", "Delhi", "Vizag", "Vijayawada", "Kochi", "Singapore", "Dubai", "London", "San Francisco", "Toronto"];
const FOODS = ["dosa", "idli", "biryani", "pesarattu", "haleem", "paneer tikka", "chole bhature", "ramen", "pasta", "sushi", "pizza", "thali", "upma", "poha", "khichdi", "mutton curry", "fish fry"];
const EATERIES = ["Paradise", "Chutneys", "Bawarchi", "Ohri's", "Minerva", "Rayalaseema Ruchulu", "Ulavacharu", "Cafe Niloufer", "Farzi Cafe", "Kritunga", "Pista House", "Absolute Barbecues"];
const BOOKS = ["The Overstory", "Sapiens", "Atomic Habits", "Deep Work", "The Mom Test", "Shoe Dog", "Thinking, Fast and Slow", "The Midnight Library", "Project Hail Mary", "Range", "The Psychology of Money", "Klara and the Sun", "The Lean Startup", "Zero to One", "A Fine Balance", "The God of Small Things", "Sea of Poppies", "Dune", "Educated", "Four Thousand Weeks"];
const TOPICS = [
  "the invoice dashboard", "the onboarding flow", "the Q3 roadmap", "pricing for the new plan", "the hiring plan", "the Android release", "the API rate limits",
  "the data migration", "the board deck", "customer churn", "the GST filing", "the office lease", "the design system", "the analytics export",
  "the payments integration", "the support backlog", "the security review", "the WhatsApp bot", "the search feature", "the mobile redesign",
  "the partnership with Finlytics", "the demo for Kotak", "the offsite plan", "the referral program", "the logging pipeline", "the SOC 2 audit",
];
const PRODUCTS = ["Ledgerly", "Tidewell CRM", "Finlytics dashboard", "Swiftpay SDK", "Harvest app", "Clinic booking", "Atlas"];
const ACTIVITIES = ["a 5 km run", "a 10 km run", "yoga", "a swim", "a gym session", "a long walk", "cycling", "stretching", "a hike at Ananthagiri"];
const ERRANDS = [
  "Paid the water bill", "Bought groceries at Ratnadeep", "Picked up Kavya from school", "Got the car washed", "Renewed the gas cylinder",
  "Dropped clothes at the laundry", "Recharged the Airtel postpaid", "Collected the courier from the gate", "Fixed the leaking tap in the kitchen",
  "Took Pixel to the vet", "Paid the maid's salary", "Ordered printer ink", "Returned the Amazon parcel", "Topped up the FASTag", "Bought vegetables at the Rythu Bazaar",
];
const MOODS = ["Tired but okay.", "Good, focused day.", "Felt low in the afternoon.", "Slept badly; groggy all morning.", "Energetic after the run.", "Anxious about cash flow.", "Happy with how the demo went.", "Distracted; too many meetings.", "Calm, quiet evening."];
const WEATHER = ["Heavy rain in the evening; Biodiversity junction flooded.", "Hot, 39°C by noon.", "Pleasant, cloudy morning.", "Humid and sticky all day.", "Cool breeze at night.", "Power cut for two hours in the afternoon."];
const DISHES = ["Pesarattu", "Gongura chicken", "Palak paneer", "Tomato rasam", "Vegetable pulao", "Lemon rice", "Egg curry", "Masala dosa", "Aloo paratha", "Bisi bele bath", "Chicken 65", "Mango lassi"];
const TRIPS = ["Goa", "Coorg", "Vizag", "Araku", "Hampi", "Pondicherry", "Ooty", "Munnar", "Jaipur", "Udaipur", "Rishikesh", "Singapore", "Bali", "Sri Lanka", "Kyoto"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PETS = ["Biscuit", "Bruno", "Coco", "Mango", "Pepper", "Simba", "Toffee", "Luna", "Oreo", "Ginger", "Rocky", "Snowy"];
const BREEDS = ["beagle", "labrador", "indie dog", "golden retriever", "shih tzu", "pug", "persian cat", "tabby cat"];
const CARS = ["Hyundai Creta", "Tata Nexon EV", "Maruti Swift", "Kia Seltos", "Honda City", "Mahindra XUV700", "Toyota Innova", "MG ZS EV"];
const TEAMS = ["Sunrisers Hyderabad", "Chennai Super Kings", "Mumbai Indians", "Royal Challengers Bengaluru", "Kolkata Knight Riders"];
const INSTRUMENTS = ["the veena", "the guitar", "the tabla", "the violin", "the flute", "the keyboard"];
const HOBBIES = ["pottery", "birdwatching", "chess", "photography", "baking sourdough", "trekking", "carnatic music", "gardening", "astronomy", "salsa"];

// --- Randomness, ids and dates -------------------------------------------------------------------------------------

let state = SEED >>> 0;
const random = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
const chance = (p: number) => random() < p;
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const newId = () => { let id = ""; for (const byte of randomBytes(26)) id += ALPHABET[byte % 32]; return id; };

const DAY = 86_400_000;
const END = Date.UTC(2026, 9, 1, 18, 0);
const START = END - 3 * 365 * DAY;
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
const human = (at: number) => { const d = new Date(at); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const monthYear = (at: number) => { const d = new Date(at); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const when = () => START + Math.floor(random() * (END - START));
const money = () => `₹${(int(2, 400) * 50).toLocaleString("en-IN")}`;
const journalTitle = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }).replace(/,/g, "");

// --- Pages, as lists of lines --------------------------------------------------------------------------------------

type Line = { text: string; section?: string; at: number; label?: string };
type Page = {
  key: string; title: string; kind?: "about" | "remember" | "journal" | "person"; day?: string; person?: string; project?: string;
  by: "owner" | "assistant"; lines: Line[]; pinned?: boolean;
};
const pages: Page[] = [];
const byKey = new Map<string, Page>();
const page = (input: Omit<Page, "lines">): Page => { const made = { ...input, lines: [] }; pages.push(made); byKey.set(made.key, made); return made; };

// The people in the owner's life. The family by first name; the rest by full name, as the owner calls them.
type Person = { name: string; relation: string; close: boolean };
const family: Person[] = [
  { name: "Meera", relation: "my wife", close: true }, { name: "Kavya", relation: "my daughter, born 2017", close: true },
  { name: "Aditya", relation: "my son, born 2021", close: true }, { name: "Lakshmi", relation: "my mother (Amma)", close: true },
  { name: "Venkat", relation: "my father (Nanna)", close: true }, { name: "Divya", relation: "my younger sister", close: true },
  { name: "Rohan", relation: "Divya's husband", close: true }, { name: "Srikanth", relation: "my best friend since school", close: true },
];
const people: Person[] = [...family];
const used = new Set(people.map((person) => person.name));
const PEOPLE = Math.round(300 * Math.min(SCALE, 1)) || 20;
while (people.length < PEOPLE) {
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  if (used.has(name)) continue;
  used.add(name);
  people.push({ name, relation: pick(RELATIONS), close: false });
}
const someone = () => pick(people).name;
const first = (name: string) => name.split(" ")[0];

// --- About me ------------------------------------------------------------------------------------------------------

const about = page({ key: "about", title: "About me", kind: "about", by: "owner" });
for (const [section, lines] of [
  ["Who I am", ["Arjun Rao, 38, founder of Tidewell Labs, a 14-person software studio in Hyderabad.", "Grew up in Vijayawada; moved to Hyderabad in 2010 for work.", "Married to Meera; two kids, Kavya and Aditya.", "Vegetarian on Tuesdays and Saturdays; otherwise eat everything."]],
  ["Work", ["Run Tidewell Labs since 2019: product work for fintech and health clients.", "Before that, eight years at Infosys, last as a delivery manager.", "Mornings are for deep work; meetings after 2 pm."]],
  ["How I like things done", ["Reply in short paragraphs, no bullet lists unless I ask.", "Use Indian number formats (lakh, crore) for money.", "Remind me of birthdays a day before, not on the day.", "Don't book anything without asking me first.", "When I say 'the kids', I mean Kavya and Aditya."]],
] as const) for (const text of lines) about.lines.push({ text, section, at: START + int(0, 60) * DAY });

// --- Things to remember: thousands of lines in sections ------------------------------------------------------------

const remember = page({ key: "remember", title: "Things to remember", kind: "remember", by: "assistant" });
const REMEMBER: Array<[string, number, () => string]> = [
  ["People", 1200, () => { const p = someone(); return pick([
    `${p} works at ${pick(COMPANIES)} as a ${pick(ROLES)}.`, `${p}'s birthday is on ${int(1, 28)} ${pick(MONTHS)}.`, `${p} lives in ${pick(AREAS)}.`,
    `${p} moved to ${pick(CITIES)} in ${monthYear(when())}.`, `${p} is ${pick(RELATIONS)}.`, `${p} recommended ${pick(BOOKS)}.`,
    `${p} doesn't drink; order mocktails when we meet.`, `${p} has two kids and lives near ${pick(AREAS)} metro station.`, `I owe ${p} ${money()} for ${pick(["dinner", "the cab", "concert tickets", "the gift", "groceries"])}.`,
  ]); }],
  ["Work", 1200, () => pick([
    `${pick(PRODUCTS)}: ${pick(TOPICS)} is owned by ${first(someone())}.`, `Client ${pick(COMPANIES)} pays net 45; chase invoices on day 40.`,
    `${pick(PRODUCTS)} runs on ${pick(["AWS Mumbai", "GCP Singapore", "a DigitalOcean droplet", "Azure Pune"])}; staging is separate.`,
    `Decided on ${human(when())} to ${pick(["hire two more engineers", "pause the Android app", "raise prices by 15%", "drop the free plan", "move standups to 10:30", "use Linear instead of Jira"])}.`,
    `${first(someone())} is the point of contact at ${pick(COMPANIES)} for ${pick(TOPICS)}.`, `Retainer with ${pick(COMPANIES)} is ${money()} a month until ${monthYear(when())}.`,
    `${pick(PRODUCTS)} release train: every second Thursday.`, `The ${pick(PRODUCTS)} repo needs two approvals before merging to main.`,
  ])],
  ["Health", 300, () => pick([
    `Resting heart rate around ${int(55, 68)} in ${monthYear(when())}.`, `Vitamin D was ${int(14, 40)} ng/ml in ${monthYear(when())}; take the supplement on Sundays.`,
    `Physio said to do ${pick(["clamshells", "calf raises", "hip bridges", "foam rolling"])} for the left knee, ${int(2, 4)} sets.`,
    `Weight ${int(72, 81)} kg on ${human(when())}.`, `Annual health check at ${pick(["Apollo", "Yashoda", "Kims", "Care"])} every ${pick(MONTHS)}.`,
    `Lower back hurts after long drives; stop every two hours.`, `Fasting sugar was ${int(88, 104)} in ${monthYear(when())}.`,
  ])],
  ["Home", 400, () => pick([
    `Plumber ${first(someone())} (${pick(AREAS)}) fixed the ${pick(["geyser", "kitchen sink", "bathroom tap", "overhead tank valve"])} in ${monthYear(when())}.`,
    `The ${pick(["AC in the bedroom", "fridge", "washing machine", "RO purifier", "inverter"])} was serviced on ${human(when())}.`,
    `Society maintenance is ${money()} a month, due by the 10th.`, `Spare keys are with ${first(someone())} next door.`,
    `Bought the ${pick(["sofa", "dining table", "bookshelf", "mattress", "study chair"])} from ${pick(["Pepperfry", "IKEA", "Urban Ladder", "Home Centre"])} in ${monthYear(when())}.`,
  ])],
  ["Preferences", 400, () => pick([
    `I like ${pick(FOODS)} from ${pick(EATERIES)}.`, `Don't like ${pick(FOODS)} too spicy.`, `Prefer ${pick(["morning", "evening"])} flights for trips under ${int(2, 4)} hours.`,
    `Favourite ${pick(["podcast", "author", "playlist", "cafe"])} lately: ${pick(["Lex Fridman", "Ruskin Bond", "Lo-fi Hyderabad", "Roastery Coffee House", "The Seen and the Unseen"])}.`,
    `Like reading ${pick(["fiction", "history", "biographies", "science fiction"])} before bed.`, `Prefer calls over long WhatsApp threads for ${pick(["work", "family", "client"])} matters.`,
  ])],
  ["Finance", 400, () => pick([
    `SIP of ${money()} in ${pick(["Parag Parikh Flexi Cap", "Nifty 50 index fund", "HDFC Mid-Cap", "UTI Nifty Next 50"])} on the ${int(1, 28)}th.`,
    `Advance tax instalment of ${money()} paid on ${human(when())}.`, `Credit card ${pick(["HDFC Regalia", "Amex Platinum", "ICICI Amazon Pay", "SBI Cashback"])} bill is due on the ${int(1, 28)}th.`,
    `Lent ${money()} to ${first(someone())} on ${human(when())}.`, `Term insurance premium ${money()} due every ${pick(MONTHS)}.`,
  ])],
  ["Travel", 300, () => pick([
    `${pick(TRIPS)} trip in ${monthYear(when())}: stayed at ${pick(["a homestay", "the Taj", "an Airbnb", "a Zostel", "a resort"])}, would go again.`,
    `Visa for ${pick(["Singapore", "Japan", "the UK", "the US", "Schengen"])} valid until ${monthYear(when() + 365 * DAY)}.`,
    `Frequent flyer number with ${pick(["IndiGo", "Air India", "Vistara", "Emirates"])} is in the travel folder.`, `Kids get car sick on ghat roads; carry ${pick(["Avomine", "ginger candy", "lemon"])}.`,
  ])],
  ["Tech", 300, () => pick([
    `Laptop is a ${pick(["ThinkPad X1", "MacBook Air M3", "Dell XPS 13", "Framework 13"])} bought ${monthYear(when())}.`,
    `Home NAS backup runs every ${pick(["night", "Sunday", "6 hours"])}.`, `Domain ${pick(["tidewell.in", "arjunrao.dev", "ledgerly.app"])} renews in ${pick(MONTHS)} with ${pick(["GoDaddy", "Namecheap", "Cloudflare"])}.`,
    `Use ${pick(["1Password", "Bitwarden"])} for family passwords; Meera has the emergency kit.`,
  ])],
  ["Other", 500, () => pick([
    `${pick(["Kavya", "Aditya"])} ${pick(["loves", "is scared of", "wants to learn", "is bored by"])} ${pick(["swimming", "dinosaurs", "the dark", "chess", "drawing", "cricket", "maths"])}.`,
    `Temple visit planned for ${pick(["Tirupati", "Yadadri", "Srisailam", "Bhadrachalam"])} in ${monthYear(when())}.`, `Library card for ${pick(["the State Central Library", "Lamakaan", "Saptaparni"])} renews yearly.`,
    `${pick(["Kavya", "Aditya"])}'s ${pick(["shoe", "dress", "t-shirt"])} size is ${int(9, 14)} now.`,
  ])],
];
for (const [section, count, make] of REMEMBER) for (let i = 0; i < Math.round(count * SCALE); i++) remember.lines.push({ text: make(), section, at: when() });

// --- A page per person ---------------------------------------------------------------------------------------------

for (const person of people) {
  const card = page({ key: `person:${person.name}`, title: person.name, kind: "person", person: person.name.toLowerCase(), by: "assistant" });
  const met = when();
  card.lines.push({ text: `${person.name} is ${person.relation}.`, at: met });
  const count = person.close ? int(60, 120) : int(10, 45);
  for (let i = 0; i < Math.round(count * SCALE); i++) {
    const at = met + Math.floor(random() * (END - met));
    card.lines.push({ at, text: pick([
      `Talked to ${first(person.name)} on ${human(at)} about ${pick(TOPICS)}.`, `${first(person.name)} works at ${pick(COMPANIES)} as a ${pick(ROLES)} (as of ${monthYear(at)}).`,
      `${first(person.name)} likes ${pick(FOODS)}; not a fan of ${pick(FOODS)}.`, `Met ${first(person.name)} for ${pick(["coffee", "lunch", "dinner", "a walk"])} at ${pick(EATERIES)} on ${human(at)}.`,
      `${first(person.name)} recommended ${pick(BOOKS)}.`, `${first(person.name)} has a ${pick(BREEDS)} called ${pick(PETS)}.`, `${first(person.name)} is learning ${pick(INSTRUMENTS)}.`,
      `${first(person.name)} drives a ${pick(CARS)}.`, `${first(person.name)} is into ${pick(HOBBIES)} these days.`, `${first(person.name)} was in ${pick(CITIES)} for work in ${monthYear(at)}.`,
      `Sent ${first(person.name)} a gift for ${pick(["their birthday", "Diwali", "their new house", "the baby"])} on ${human(at)}.`, `${first(person.name)} is allergic to ${pick(["dust", "pollen", "peanuts", "shellfish", "penicillin"])}.`,
    ]) });
  }
  card.lines.sort((a, b) => a.at - b.at);
}

// --- The journal: a page a day, about 30 lines -----------------------------------------------------------------------

const days: string[] = [];
for (let at = START; at <= END; at += DAY) days.push(dayOf(at));
const journalLine = (at: number): string => {
  const hh = String(int(6, 22)).padStart(2, "0");
  const mm = pick(["00", "15", "30", "45"]);
  return pick([
    `${hh}:${mm} call with ${first(someone())} about ${pick(TOPICS)}; ${pick(["agreed on next steps", "needs a follow-up", "went long", "they want a proposal by Friday", "no decision yet"])}.`,
    `Morning: ${pick(ACTIVITIES)}, ${pick(["felt strong", "knee a bit sore", "slow pace", "personal best", "rained halfway"])}.`,
    `${pick(ERRANDS)}.`, `Lunch: ${pick(FOODS)} at ${pick(EATERIES)} with ${first(someone())}.`, `Dinner at home: ${pick(DISHES).toLowerCase()}.`,
    `Read ${int(10, 60)} pages of ${pick(BOOKS)}.`, `${pick(MOODS)}`, `${pick(WEATHER)}`,
    `Shipped ${pick(["a fix for", "the first cut of", "a prototype of", "tests for"])} ${pick(TOPICS)} in ${pick(PRODUCTS)}.`,
    `Reviewed ${int(2, 9)} pull requests on ${pick(PRODUCTS)}.`, `Spent ${money()} on ${pick(["groceries", "fuel", "books", "a gift", "the kids' classes", "medicines", "Swiggy"])}.`,
    `Video call with Amma and Nanna; ${pick(["Nanna's BP is fine", "Amma wants us to visit", "they are going to Tirupati", "the mango tree is fruiting"])}.`,
    `${pick(["Kavya", "Aditya"])} ${pick(["had a fever", "won a drawing contest", "lost a tooth", "learnt to ride the cycle", "had a school play", "got a star in maths"])}.`,
    `Interviewed a candidate for ${pick(["backend", "frontend", "QA", "design", "sales"])}: ${pick(["strong yes", "no", "maybe; second round", "good culture fit"])}.`,
    `Idea: ${pick(["offer a yearly plan", "add CSV export", "a WhatsApp reminder for invoices", "open-source the UI kit", "a referral discount", "a weekly founder newsletter"])}.`,
    `${pick(["Meera", "Divya", "Srikanth"])} and I ${pick(["watched a movie", "went for a walk", "planned the weekend", "argued about the budget", "cooked together"])}.`,
    `Slept at ${int(22, 24) % 24 || 12}:${pick(["00", "30"])}, ${int(5, 8)} hours.`, `Commute to the office took ${int(25, 75)} minutes; ${pick(["traffic at Biodiversity", "smooth", "metro was quicker", "rain made it worse"])}.`,
  ]);
};
for (const day of days) {
  const journal = page({ key: `journal:${day}`, title: journalTitle(day), kind: "journal", day, by: "assistant" });
  const base = Date.parse(`${day}T06:00:00Z`);
  const count = Math.max(1, Math.round(int(18, 42) * SCALE));
  for (let i = 0; i < count; i++) journal.lines.push({ text: journalLine(base), at: base + i * 25 * 60_000 });
}

// --- The owner's own pages: meetings, books, recipes, trips, logs, lists --------------------------------------------

const PAGES = Math.round(3000 * SCALE);
const projectsOf = ["Tidewell Labs", "Kitchen renovation", "Marathon 2026", "Kids' school"];
const ownPage = (index: number) => {
  const at = when();
  const kind = index % 7;
  const project = chance(0.15) ? pick(projectsOf) : undefined;
  if (kind === 0) {
    const client = pick(COMPANIES);
    const made = page({ key: `page:${index}`, title: `Meeting: ${client}, ${pick(TOPICS)} (${human(at)})`, by: "owner", project });
    for (let i = 0; i < int(2, 5); i++) made.lines.push({ section: "Attendees", text: `${someone()} (${pick(ROLES)})`, at });
    for (let i = 0; i < int(8, 20); i++) made.lines.push({ section: "Notes", text: `${pick(["They want", "We agreed", "Open question:", "Risk:", "Budget:"])} ${pick(TOPICS)} ${pick(["by end of month", "in two phases", "with a fixed fee", "only after the audit", "if legal signs off"])}.`, at });
    for (let i = 0; i < int(3, 8); i++) made.lines.push({ section: "Actions", text: `${first(someone())} to ${pick(["send the deck", "share the API docs", "draft the SOW", "set up a sandbox", "follow up on pricing"])} by ${human(at + int(2, 14) * DAY)}.`, at });
  } else if (kind === 1) {
    const book = pick(BOOKS);
    const made = page({ key: `page:${index}`, title: `Book notes: ${book} (${monthYear(at)})`, by: "owner" });
    for (let i = 0; i < int(10, 35); i++) made.lines.push({ section: pick(["Ideas", "Quotes", "What I'll try"]), text: `${pick(["Chapter", "Part", "Section"])} ${int(1, 20)}: ${pick(["habits compound", "attention is the scarce resource", "talk to customers before building", "slow thinking catches errors", "small bets beat big plans", "rest is part of the work"])}${pick([".", "; worth rereading.", "; reminded me of Tidewell's early days."])}`, at });
  } else if (kind === 2) {
    const dish = pick(DISHES);
    const made = page({ key: `page:${index}`, title: `Recipe: ${dish} (${int(1, 999)})`, by: "owner" });
    for (let i = 0; i < int(6, 14); i++) made.lines.push({ section: "Ingredients", text: `${int(1, 4)} ${pick(["cups", "tbsp", "tsp", "pieces"])} ${pick(["rice", "moong dal", "onion", "tomato", "ginger", "green chillies", "curry leaves", "ghee", "jaggery", "tamarind", "coconut"])}`, at });
    for (let i = 0; i < int(5, 12); i++) made.lines.push({ section: "Steps", text: `${pick(["Soak", "Grind", "Temper", "Simmer", "Roast", "Mix"])} ${pick(["for 10 minutes", "until golden", "on low flame", "with a pinch of salt", "and rest overnight"])}.`, at });
  } else if (kind === 3) {
    const place = pick(TRIPS);
    const made = page({ key: `page:${index}`, title: `Trip: ${place}, ${monthYear(at)}`, by: "owner" });
    for (let i = 0; i < int(10, 30); i++) made.lines.push({ section: pick(["Plan", "Bookings", "Packing", "Ideas"]), text: `${pick(["Day", "Option", "Note"])} ${int(1, 7)}: ${pick(["sunrise point", "the old market", "a boat ride", "the fort", "beach cafe", "the museum", "rest day"])} ${pick(["with the kids", "if it doesn't rain", "booked", "maybe", "Meera's pick"])}.`, at });
  } else if (kind === 4) {
    const product = pick(PRODUCTS);
    const made = page({ key: `page:${index}`, title: `${product} log ${index}`, by: "owner", project: project ?? (chance(0.5) ? "Tidewell Labs" : undefined) });
    for (let i = 0; i < int(15, 45); i++) { const t = at + i * DAY; made.lines.push({ section: monthYear(t), text: `${human(t)}: ${pick(["deployed", "rolled back", "profiled", "refactored", "documented", "load-tested"])} ${pick(TOPICS)}${pick(["", "; p95 down to 180 ms", "; found a race in the queue", "; client happy"])}.`, at: t }); }
  } else if (kind === 5) {
    const made = page({ key: `page:${index}`, title: `${pick(["Gift ideas", "Packing list", "Weekend plans", "Things to buy", "Questions for the doctor", "Movies to watch"])} ${index}`, by: "owner", project });
    for (let i = 0; i < int(8, 25); i++) made.lines.push({ text: `${pick(["Ask about", "Buy", "Try", "Book", "Look up"])} ${pick([...FOODS, ...BOOKS, ...TRIPS, ...HOBBIES])}`, at });
  } else {
    const made = page({ key: `page:${index}`, title: `Weekly review ${dayOf(at)}`, by: "owner", project });
    for (const section of ["Went well", "Didn't", "Next week"]) for (let i = 0; i < int(4, 9); i++) made.lines.push({ section, text: `${pick(TOPICS)}: ${pick(["moved forward", "stuck on review", "needs a decision", "done", "slipped a week"])}.`, at });
  }
};
for (let i = 0; i < PAGES; i++) ownPage(i);

// --- Each project's own Things to remember ---------------------------------------------------------------------------

for (const project of projectsOf) {
  const made = page({ key: `project:${project}`, title: "Things to remember", kind: "remember", project, by: "assistant" });
  for (let i = 0; i < Math.round(int(150, 300) * SCALE); i++) made.lines.push({ section: pick(["Plan", "People", "Budget", "Decisions"]), text: `${project}: ${pick(["decided", "remember", "check", "budget for"])} ${pick(TOPICS)} ${pick(["with " + first(someone()), "before " + monthYear(when()), "under " + money(), "every week"])}.`, at: when() });
}

// --- Planted lines, each with a question it answers --------------------------------------------------------------

type Needle = { kind: "words" | "meaning" | "languages" | "latest" | "person" | "dated"; question: string; text: string; place: string; section?: string; at?: number };
const NEEDLES: Needle[] = [
  // By meaning only: the question shares no telling word with the line.
  { kind: "meaning", question: "which nuts make me sick?", text: "I'm allergic to cashews: my throat swells, so I carry cetirizine.", place: "remember", section: "Health" },
  { kind: "meaning", question: "am I vegetarian?", text: "I stopped eating meat in January 2019, except fish on holidays.", place: "remember", section: "Preferences" },
  { kind: "meaning", question: "what temperature do I keep the bedroom at night", text: "Can't sleep if the room is warmer than 24 degrees; AC on 22.", place: "remember", section: "Preferences" },
  { kind: "meaning", question: "when does my travel document run out", text: "Passport expires on 14 Feb 2029; renew six months before.", place: "remember", section: "Travel" },
  { kind: "meaning", question: "when is the vehicle policy due", text: "The car's insurance renews every 9 March with ICICI Lombard.", place: "remember", section: "Home" },
  { kind: "meaning", question: "where do I like to sit on a plane", text: "Prefer aisle seats on flights longer than two hours.", place: "remember", section: "Preferences" },
  { kind: "meaning", question: "when can people phone me in the morning", text: "Hate being called before 9 am unless it's urgent.", place: "remember", section: "Preferences" },
  { kind: "meaning", question: "when does my fitness club subscription finish", text: "Cult Fit Kondapur membership ends 30 Nov 2026.", place: "remember", section: "Health" },
  { kind: "meaning", question: "what time does my daughter leave for class", text: "Kavya's school bus picks her up at 7:10 from the main gate.", place: "remember", section: "Other" },
  { kind: "meaning", question: "when is the house payment due to the owner", text: "Landlord Mr. Reddy wants rent by the 5th, via NEFT.", place: "remember", section: "Home" },
  { kind: "meaning", question: "where is the internet box kept", text: "The Wi-Fi router is a TP-Link Archer C6 in the hall cupboard.", place: "remember", section: "Tech" },
  { kind: "meaning", question: "who is my skin specialist", text: "Dr. Sameera Iyer is my dermatologist at Kims, Kondapur.", place: "remember", section: "Health" },
  { kind: "meaning", question: "moving our servers to a cheaper provider", text: "Planning to switch the startup's cloud from AWS to Hetzner to cut costs by 40%.", place: "remember", section: "Work" },
  { kind: "meaning", question: "which days do I play shuttle", text: "I play badminton every Tuesday and Thursday at 7 pm at Gachibowli stadium.", place: "remember", section: "Health" },
  { kind: "meaning", question: "when did I get married", text: "Wedding anniversary with Meera is 21 November.", place: "remember", section: "People" },
  { kind: "meaning", question: "rules about tablets and TV for the children in the evening", text: "Kids are not allowed screens after 8 pm on school nights.", place: "remember", section: "Other" },
  { kind: "meaning", question: "how are we sharing the beach house money", text: "Agreed with Farhan Ali to split the Goa villa cost 60/40.", place: "remember", section: "Finance" },
  { kind: "meaning", question: "what blood type am I", text: "My blood group is O negative.", place: "remember", section: "Health" },
  { kind: "meaning", question: "how much do I pay the cook", text: "Saroja, who cooks lunch on weekdays, gets ₹9,000 a month.", place: "remember", section: "Home" },
  { kind: "meaning", question: "what is my shoe size", text: "I wear UK 9 in sneakers but 8.5 in formal shoes.", place: "remember", section: "Other" },
  { kind: "meaning", question: "who fixes our pipes", text: "Call Yadagiri for any plumbing; he comes the same day.", place: "remember", section: "Home" },
  { kind: "meaning", question: "how do I take my coffee", text: "Filter coffee, strong, no sugar, a splash of milk.", place: "remember", section: "Preferences" },
  { kind: "meaning", question: "which school do the kids go to", text: "Kavya and Aditya are at Glendale Academy, Kokapet campus.", place: "remember", section: "Other" },
  { kind: "meaning", question: "how much did the new roof cost", text: "Terrace waterproofing in May 2025 came to ₹1.8 lakh with Dr. Fixit.", place: "remember", section: "Home", at: Date.UTC(2025, 4, 20) },
  { kind: "meaning", question: "my running goal for this year", text: "Target: a sub-2-hour half marathon at the Hyderabad run in August 2026.", place: "remember", section: "Health", at: Date.UTC(2026, 0, 2) },
  { kind: "meaning", question: "what did the eye doctor prescribe", text: "Ophthalmologist gave me -1.25 in both eyes for screens, Mar 2024.", place: "remember", section: "Health", at: Date.UTC(2024, 2, 11) },
  { kind: "meaning", question: "who looks after the dog when we travel", text: "Pixel stays with Nandini Rao's family whenever we're away.", place: "remember", section: "Home" },
  { kind: "meaning", question: "what present did I get my wife last year", text: "Gave Meera a Kanjeevaram silk saree for her birthday in 2025.", place: "remember", section: "People", at: Date.UTC(2025, 6, 9) },
  { kind: "meaning", question: "how do we back up the family photos", text: "Every phone photo syncs to Google Photos; a copy goes to the Synology every Sunday.", place: "remember", section: "Tech" },
  { kind: "meaning", question: "where do I get my hair cut", text: "Barber is Salim at Jawed Habib, Kondapur; ask for a number 3 on the sides.", place: "remember", section: "Other" },
  { kind: "meaning", question: "the company's yearly revenue", text: "Tidewell closed FY2025-26 at ₹6.4 crore in billings, up 31%.", place: "remember", section: "Work", at: Date.UTC(2026, 3, 3) },
  { kind: "meaning", question: "how many people work at my firm", text: "We are 14 at Tidewell now, after Shreya joined as a designer.", place: "remember", section: "Work", at: Date.UTC(2026, 6, 1) },
  { kind: "meaning", question: "am I afraid of anything", text: "Heights make me dizzy; skip glass bridges and open lifts.", place: "remember", section: "Health" },
  { kind: "meaning", question: "what languages does my son speak", text: "Aditya understands Telugu and English, and picks up Hindi from the nanny.", place: "remember", section: "Other" },
  { kind: "meaning", question: "where did we go for our honeymoon", text: "Meera and I spent two weeks in Kerala's backwaters after the wedding in 2014.", place: "remember", section: "Travel" },
  // By words: a rare word or number the question shares with the line.
  { kind: "words", question: "Keychron order", text: "Ordered a Keychron Q1 keyboard on 3 Feb 2025 (order 402-7781234).", place: "journal", at: Date.UTC(2025, 1, 3) },
  { kind: "words", question: "car registration number", text: "The Creta's registration number is TS09 EK 4521.", place: "remember", section: "Home" },
  { kind: "words", question: "Hetzner quote", text: "Hetzner quote: €184 a month for three AX52 servers.", place: "journal", at: Date.UTC(2026, 4, 12) },
  { kind: "words", question: "INV-2025-0412", text: "Invoice INV-2025-0412 to Kotak for ₹4.2 lakh is still unpaid.", place: "journal", at: Date.UTC(2025, 3, 30) },
  { kind: "words", question: "zerodha coin sip date", text: "Zerodha Coin SIP of ₹15,000 goes out on the 7th.", place: "remember", section: "Finance" },
  { kind: "words", question: "where is my PAN card copy", text: "PAN card copy is in the blue folder in the study.", place: "remember", section: "Other" },
  { kind: "words", question: "aadhaar address update", text: "Aadhaar address update request URN 0123-4567-8901 submitted on 12 May 2024.", place: "journal", at: Date.UTC(2024, 4, 12) },
  { kind: "words", question: "bharatanatyam class", text: "Kavya's Bharatanatyam class is with Guru Sudha at Nritya Kala, Saturdays 4 pm.", place: "remember", section: "Other" },
  { kind: "words", question: "6E 2134", text: "Flight 6E 2134 to Goa departs 06:05 on 19 Dec 2025.", place: "journal", at: Date.UTC(2025, 11, 10) },
  { kind: "words", question: "max_connections ledgerly", text: "Raised Postgres max_connections to 400 on the Ledgerly prod box.", place: "journal", at: Date.UTC(2024, 7, 22) },
  { kind: "words", question: "Synology DS920 disk", text: "Replaced disk 2 in the Synology DS920+ with a 4 TB WD Red Plus.", place: "journal", at: Date.UTC(2024, 10, 2) },
  { kind: "words", question: "Kumon fees", text: "Kumon fees for Kavya are ₹2,400 a month per subject.", place: "remember", section: "Finance" },
  { kind: "words", question: "Daikin AC model", text: "Bedroom AC is a Daikin FTKF50 1.5 ton, installed Apr 2023.", place: "remember", section: "Home" },
  { kind: "words", question: "GSTIN of Tidewell", text: "Tidewell's GSTIN is 36ABCDE1234F1Z5.", place: "remember", section: "Work" },
  { kind: "words", question: "Notion migration", text: "Moved the company wiki from Confluence to Notion over the Diwali week.", place: "journal", at: Date.UTC(2024, 9, 31) },
  { kind: "words", question: "Lamakaan open mic", text: "Read two poems at the Lamakaan open mic; Meera filmed it.", place: "journal", at: Date.UTC(2023, 11, 16) },
  { kind: "words", question: "Mahindra Thar test drive", text: "Took a Mahindra Thar for a test drive; too bumpy for Amma.", place: "journal", at: Date.UTC(2024, 1, 24) },
  { kind: "words", question: "Ananthagiri campsite", text: "Booked the Ananthagiri campsite (Tent 6) for the Tidewell offsite on 14 Feb.", place: "journal", at: Date.UTC(2026, 0, 20) },
  { kind: "words", question: "Figma seat count", text: "We pay for 6 Figma seats; drop one when Varun leaves.", place: "remember", section: "Work" },
  // A day, week or month named in the question, and nothing else of the line's words.
  { kind: "dated", question: "what did we do with the kids on 15 March 2025?", text: "Took Kavya and Aditya to the Nehru Zoological Park; Aditya cried at the lion enclosure.", place: "journal", at: Date.UTC(2025, 2, 15, 9) },
  { kind: "dated", question: "what did I do on the evening of 2 Nov 2024?", text: "Went to Lamakaan for a Carnatic concert with Meera; T. M. Krishna sang.", place: "journal", at: Date.UTC(2024, 10, 2, 9) },
  { kind: "dated", question: "what did I fix last week?", text: "Fixed the flaky payments test that kept failing on CI since August.", place: "journal", at: Date.UTC(2026, 8, 26, 9) },
  { kind: "dated", question: "what book did I start in July 2025?", text: "Started Klara and the Sun on the train to Vizag.", place: "journal", at: Date.UTC(2025, 6, 12, 9) },
  { kind: "dated", question: "what new cuisine did I try in June 2024?", text: "Tried a Burmese place in Jubilee Hills; the khow suey was excellent.", place: "journal", at: Date.UTC(2024, 5, 18, 9) },
  { kind: "dated", question: "who visited us in December 2023?", text: "Uncle Prabhakar and Aunt Sarala stayed with us for three days.", place: "journal", at: Date.UTC(2023, 11, 22, 9) },
  // Across languages: Hindi or Telugu on one side.
  { kind: "languages", question: "does mom take any medicine every day?", text: "माँ को हर सुबह थायरॉइड की दवा लेनी होती है।", place: "remember", section: "Health" },
  { kind: "languages", question: "when is dad's birthday?", text: "నాన్నగారి పుట్టినరోజు మార్చి 18న.", place: "remember", section: "People" },
  { kind: "languages", question: "दादी का गाँव कहाँ है?", text: "Grandmother's village is Peddapuram, near Kakinada.", place: "remember", section: "People" },
  { kind: "languages", question: "plans to paint the house", text: "अगले महीने घर की पुताई करवानी है।", place: "journal", at: Date.UTC(2026, 7, 28) },
  { kind: "languages", question: "కరెంటు బిల్లు ఎలా కడతాను?", text: "The electricity bill is paid automatically from the SBI account.", place: "remember", section: "Finance" },
  { kind: "languages", question: "मेरी बहन कहाँ रहती है?", text: "Divya lives in Pune, in Baner, since 2022.", place: "remember", section: "People" },
  { kind: "languages", question: "what does amma like to eat", text: "అమ్మకి గోంగూర పచ్చడి అంటే చాలా ఇష్టం.", place: "remember", section: "People" },
  { kind: "languages", question: "బ్యాంకు లాకర్ ఎక్కడ ఉంది?", text: "The bank locker is at SBI Madhapur, number 214.", place: "remember", section: "Finance" },
  { kind: "languages", question: "kids' vaccination", text: "आदित्य का अगला टीका जनवरी में है।", place: "remember", section: "Health" },
  { kind: "languages", question: "who is our family doctor", text: "మా ఫ్యామిలీ డాక్టర్ డా. ప్రసాద్, అమీర్‌పేట్.", place: "remember", section: "Health" },
];
// The latest of several: the question wants the newest; the older ones are there too.
const LATEST: Array<{ question: string; make: (at: number) => string; times: number[] }> = [
  { question: "when did I last go to the dentist?", make: (at) => `Dentist at Partha Dental on ${human(at)}: ${pick(["cleaning", "a filling", "check-up", "x-ray"])}.`, times: [Date.UTC(2024, 1, 5), Date.UTC(2024, 9, 2), Date.UTC(2025, 5, 18), Date.UTC(2026, 7, 14)] },
  { question: "latest blood test results", make: (at) => `Blood test on ${human(at)}: HbA1c ${(5 + random()).toFixed(1)}, cholesterol ${int(160, 220)}.`, times: [Date.UTC(2024, 0, 9), Date.UTC(2025, 0, 14), Date.UTC(2026, 0, 12)] },
  { question: "when was the car last serviced?", make: (at) => `Car service at Hyundai Kondapur on ${human(at)}; ${int(18, 52)},000 km.`, times: [Date.UTC(2023, 11, 3), Date.UTC(2024, 11, 7), Date.UTC(2025, 11, 6)] },
  { question: "what was my last half marathon time", make: (at) => `Half marathon on ${human(at)}: ${pick(["2:14", "2:09", "2:03", "1:58"])}.`, times: [Date.UTC(2023, 11, 10), Date.UTC(2024, 7, 25), Date.UTC(2025, 7, 24), Date.UTC(2026, 7, 30)] },
  { question: "when did Amma last visit us", make: (at) => `Amma came to stay with us on ${human(at)} for ${int(5, 20)} days.`, times: [Date.UTC(2024, 3, 1), Date.UTC(2025, 2, 20), Date.UTC(2026, 6, 8)] },
  { question: "last salary revision for the team", make: (at) => `Salary revision for the team on ${human(at)}: ${int(6, 14)}% on average.`, times: [Date.UTC(2024, 3, 1), Date.UTC(2025, 3, 1), Date.UTC(2026, 3, 1)] },
];
for (const series of LATEST) {
  series.times.forEach((at, index) => NEEDLES.push({ kind: "latest", question: index === series.times.length - 1 ? series.question : "", text: series.make(at), place: "journal", at }));
}
// Facts on someone's page.
const strangers = people.filter((person) => !person.close);
for (let i = 0; i < Math.min(40, strangers.length); i++) {
  const person = strangers[(i * 7) % strangers.length];
  const name = first(person.name);
  const pet = pick(PETS);
  const facts: Array<[string, string]> = [
    [`What's the name of ${person.name}'s dog?`, `${name}'s dog is a ${pick(BREEDS)} named ${pet}, adopted in ${monthYear(when())}.`],
    [`Which cricket side does ${person.name} support?`, `${name} is a die-hard ${pick(TEAMS)} fan and never misses a home game.`],
    [`What car does ${person.name} drive now?`, `${name} sold the old car and bought a ${pick(CARS)} last ${pick(MONTHS)}.`],
    [`What is ${person.name}'s daughter called?`, `${name}'s daughter is called ${pick(["Ira", "Tara", "Siya", "Anvi", "Myra", "Riya"])}, she's ${int(3, 12)}.`],
    [`What instrument does ${person.name} play?`, `${name} has been playing ${pick(INSTRUMENTS)} for ten years.`],
  ];
  const [question, text] = facts[i % facts.length];
  NEEDLES.push({ kind: "person", question, text, place: `person:${person.name}` });
}

const labels: Array<{ kind: string; question: string; text: string; ids: string[] }> = [];
const planted: Array<{ needle: Needle; line: Line }> = [];
for (const needle of NEEDLES) {
  let target: Page | undefined;
  let at = needle.at ?? when();
  if (needle.place === "journal") {
    at = needle.at ?? when();
    target = byKey.get(`journal:${dayOf(at)}`);
  } else target = byKey.get(needle.place);
  if (!target) throw new Error(`no page for ${needle.place}`);
  const line: Line = { text: needle.text, section: needle.section, at, label: needle.question || undefined };
  target.lines.splice(int(0, target.lines.length), 0, line);
  planted.push({ needle, line });
}

// --- Rows, as Perry at main writes them ---------------------------------------------------------------------------

mkdirSync(home, { recursive: true });
const file = join(home, "perry.sqlite");
for (const suffix of ["", "-wal", "-shm"]) if (existsSync(file + suffix)) rmSync(file + suffix);
const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;");
db.exec(`CREATE TABLE IF NOT EXISTS _ids (id TEXT PRIMARY KEY, tbl TEXT NOT NULL) WITHOUT ROWID`);
for (const table of ["notes", "memories", "projects"]) db.exec(`CREATE TABLE IF NOT EXISTS "doc_${table}" (_id TEXT PRIMARY KEY, _creationTime REAL NOT NULL, doc TEXT NOT NULL)`);
const insertId = db.prepare("INSERT INTO _ids (id, tbl) VALUES (?, ?)");
const inserts: Record<string, ReturnType<DatabaseSync["prepare"]>> = {};
for (const table of ["notes", "memories", "projects"]) inserts[table] = db.prepare(`INSERT INTO "doc_${table}" (_id, _creationTime, doc) VALUES (?, ?, ?)`);
let lastCreation = 0;
const creation = (at: number) => (lastCreation = at > lastCreation ? at : lastCreation + 0.001);
const insert = (table: string, doc: Record<string, unknown>, at: number) => {
  const id = newId();
  insertId.run(id, table);
  inserts[table].run(id, creation(at), JSON.stringify(doc));
  return id;
};

const LINE_KIND = { about: "profile", remember: "core", journal: "daily", person: "core" } as const;
const markdown = (lines: Line[]) => {
  const out: string[] = [];
  let section: string | undefined;
  for (const line of lines) {
    if (line.section !== section && line.section) out.push(`${out.length ? "\n" : ""}## ${line.section}\n`);
    section = line.section;
    out.push(`- ${line.text}`);
  }
  return `${out.join("\n")}\n`;
};

// Lines of a section stay together under one heading, as a page reads them back.
for (const made of pages) {
  const order = [...new Set(made.lines.map((line) => line.section ?? ""))];
  made.lines.sort((a, b) => order.indexOf(a.section ?? "") - order.indexOf(b.section ?? ""));
}

type Row = { id?: string; page: Page; line: Line; order: number; doc: Record<string, unknown> };
const rows: Row[] = [];
db.exec("BEGIN");
const projectIds = new Map<string, string>();
for (const name of projectsOf) projectIds.set(name, insert("projects", { name, instructions: "", createdAt: START, updatedAt: START }, START));
const pageIds = new Map<Page, string>();
for (const made of pages) {
  const content = markdown(made.lines);
  const at = Math.min(...made.lines.map((line) => line.at), END);
  const updated = Math.max(...made.lines.map((line) => line.at), at);
  const projectId = made.project ? projectIds.get(made.project) : undefined;
  const id = insert("notes", {
    title: made.title, content, revision: 1, search: `${made.title}\n\n${content}`, by: made.by, linesAt: 1,
    ...(projectId ? { projectId } : {}), ...(made.kind ? { kind: made.kind } : {}), ...(made.day ? { day: made.day } : {}), ...(made.person ? { person: made.person } : {}),
    createdAt: at, updatedAt: updated,
  }, at);
  pageIds.set(made, id);
  made.lines.forEach((line, order) => {
    const by = made.kind ? (made.kind === "about" ? "owner" : "assistant") : "owner";
    rows.push({ page: made, line, order, doc: {
      text: line.text, tags: [], source: "page", createdAt: line.at, kind: made.kind ? LINE_KIND[made.kind] : "page", pageId: id, order,
      ...(line.section ? { section: line.section } : {}), by,
      ...(projectId ? { projectId } : {}), ...(made.day ? { day: made.day } : {}), ...(made.kind === "person" ? { about: [made.title] } : {}),
      ...(made.kind && by === "owner" ? { origin: "owner" } : {}),
    } });
  });
}

// Vectors as main keeps them: base64 float32 inside each row, from the sentence model main uses.
if (VECTORS) {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = VECTORS;
  const extractor = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
  const started = Date.now();
  const BATCH = 64;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vectors = (await extractor(batch.map((row) => row.line.text), { pooling: "mean", normalize: true })).tolist() as number[][];
    batch.forEach((row, index) => { row.doc.vector = Buffer.from(new Float32Array(vectors[index]).buffer).toString("base64"); row.doc.vectorModel = MODEL; });
    if (i % (BATCH * 100) === 0) console.log(`vectors: ${i} of ${rows.length}, ${Math.round((Date.now() - started) / 1000)} s`);
  }
}
for (const row of rows.sort((a, b) => a.line.at - b.line.at)) row.id = insert("memories", row.doc, row.line.at);
db.exec("COMMIT");
db.close();

for (const { needle, line } of planted) {
  if (!needle.question) continue;
  const row = rows.find((item) => item.line === line)!;
  labels.push({ kind: needle.kind, question: needle.question, text: needle.text, ids: [row.id!] });
}
const count = (kind?: string) => rows.filter((row) => (kind === undefined ? true : (row.page.kind ?? "page") === kind)).length;
const stats = {
  seed: SEED, scale: SCALE, model: VECTORS ? MODEL : null, from: dayOf(START), to: dayOf(END),
  lines: rows.length, pages: pages.length, people: people.length, days: days.length,
  byKind: { about: count("about"), remember: count("remember"), journal: count("journal"), person: count("person"), page: count("page") },
  thingsToRemember: remember.lines.length, labelled: labels.length,
};
writeFileSync(join(home, "labels.json"), `${JSON.stringify(labels, null, 2)}\n`);
writeFileSync(join(home, "stats.json"), `${JSON.stringify(stats, null, 2)}\n`);
console.log(JSON.stringify(stats));
