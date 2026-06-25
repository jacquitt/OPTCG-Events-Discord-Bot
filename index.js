import { chromium } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CALENDAR_URL = process.env.CALENDAR_URL || "https://www.cardkaizoku.com/eventcalendar";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const STATE_FILE = process.env.STATE_FILE || "data/seen-events.json";

// false = first run saves the current list but does NOT spam Discord.
// true = first run announces everything currently on the calendar.
const POST_EXISTING = String(process.env.POST_EXISTING || "false").toLowerCase() === "true";

// Safety cap so a bad parse does not spam the channel.
const MAX_POSTS_PER_RUN = Number(process.env.MAX_POSTS_PER_RUN || 10);

function clean(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function eventId(event) {
  return crypto
    .createHash("sha256")
    .update(`${event.date}|${event.title}|${event.series}|${event.type}|${event.region || ""}`)
    .digest("hex");
}

async function readSeenIds() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

async function writeSeenIds(ids) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify([...ids].sort(), null, 2) + "\n");
}

function parseEventsFromLines(lines) {
  const month = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)";
  const datePattern = `${month}\\.?\\s+\\d{1,2},\\s+\\d{4}(?:\\s*[-–]\\s*${month}\\.?\\s+\\d{1,2},\\s+\\d{4})?`;
  const dateRegex = new RegExp(datePattern, "i");

  const events = [];

  // First try line-by-line parsing.
  for (let i = 0; i < lines.length; i++) {
    const line = clean(lines[i]);
    const dateMatch = line.match(new RegExp(`^${datePattern}`, "i"));
    if (!dateMatch) continue;

    const date = clean(dateMatch[0]);
    const rest = clean(line.slice(dateMatch[0].length).replace(/^,/, ""));

    let title = rest || clean(lines[i + 1] || "") || "Untitled Event";
    let series = clean(lines[i + 2] || "");
    let type = clean(lines[i + 3] || "");

    if (title.includes("·")) {
      const parts = title.split("·").map(clean);
      title = parts[0] || title;
      const rightSide = parts.slice(1).join(" · ");
      const rightParts = rightSide.split(",").map(clean).filter(Boolean);
      series = rightParts[0] || series;
      type = rightParts[1] || type;
    }

    if (/current|upcoming|past events|event calendar/i.test(title)) continue;

    events.push({ date, title, series, type, url: CALENDAR_URL });
  }

  // Backup parser: Card Kaizoku sometimes renders everything as one big text blob.
  const allText = clean(lines.join(" ; "));
  const upcomingOnly = allText
    .replace(/^.*?Current & Upcoming Events/i, "")
    .replace(/Past Events.*$/i, "");

  const chunkRegex = new RegExp(`(${datePattern})\\s*,?\\s*(.*?)(?=${datePattern}|$)`, "gi");
  let match;

  while ((match = chunkRegex.exec(upcomingOnly)) !== null) {
    const date = clean(match[1]);
    let chunk = clean(match[match.length - 1]);

    if (!date || !chunk) continue;
    if (/you need to enable javascript/i.test(chunk)) continue;

    chunk = chunk
      .replace(/^Current & Upcoming Events/i, "")
      .replace(/^\s*[-–—:;,]+/, "")
      .trim();

    let title = "Untitled Event";
    let series = "";
    let type = "";

    if (chunk.includes("·")) {
      const [left, ...right] = chunk.split("·").map(clean);
      title = left || title;

      const rightText = right.join(" · ");
      const pieces = rightText.split(",").map(clean).filter(Boolean);
      series = pieces[0] || "";
      type = pieces[1] || "";
    } else {
      const pieces = chunk.split(",").map(clean).filter(Boolean);
      title = pieces[0] || title;
      series = pieces[1] || "";
      type = pieces[2] || "";
    }

    if (/current|upcoming|past events|event calendar/i.test(title)) continue;

    events.push({ date, title, series, type, url: CALENDAR_URL });
  }

  return events;
}

async function scrapeEvents() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  await page.goto(CALENDAR_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});

  // Card Kaizoku is a JS-rendered page, so give React/calendar content time to render.
  await page.waitForFunction(
    () => !document.body.innerText.includes("You need to enable JavaScript"),
    { timeout: 20000 }
  ).catch(() => {});
  await page.waitForTimeout(3000);

  const extracted = await page.evaluate(() => {
    const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();

    const tableEvents = [];
    for (const row of Array.from(document.querySelectorAll("tr"))) {
      const cells = Array.from(row.querySelectorAll("th, td"))
        .map((cell) => clean(cell.innerText))
        .filter(Boolean);

      if (cells.length >= 3 && /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2},\s+\d{4}/i.test(cells[0])) {
        tableEvents.push({
          date: cells[0],
          title: cells[1] || "Untitled Event",
          series: cells[2] || "",
          type: cells[3] || "",
          url: window.location.href,
        });
      }
    }

    const lines = document.body.innerText
      .split("\n")
      .map(clean)
      .filter(Boolean);

    return { tableEvents, lines };
  });

  await browser.close();

  let events = extracted.tableEvents;
  if (!events.length) {
    events = parseEventsFromLines(extracted.lines);
  }

  // Deduplicate and remove obvious junk.
  const byId = new Map();
  for (const event of events) {
    event.date = clean(event.date);
    event.title = clean(event.title);
    event.series = clean(event.series);
    event.type = clean(event.type);

    if (!event.date || !event.title) continue;
    if (/you need to enable javascript/i.test(`${event.date} ${event.title}`)) continue;

    byId.set(eventId(event), event);
  }

  return [...byId.values()];
}

function discordPayload(event) {
  const descriptionParts = [];
  if (event.series) descriptionParts.push(`**Series:** ${event.series}`);
  if (event.type) descriptionParts.push(`**Type:** ${event.type}`);

  return {
    username: "Card Kaizoku Events",
    embeds: [
      {
        title: `🏴‍☠️ ${event.title}`,
        url: event.url,
        description: descriptionParts.join("\n") || "New event added.",
        fields: [
          {
            name: "Date",
            value: event.date,
            inline: true,
          },
        ],
        footer: {
          text: "Source: Card Kaizoku Event Calendar",
        },
      },
    ],
  };
}

async function postToDiscord(event) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("[DRY RUN] No DISCORD_WEBHOOK_URL set. Would post:");
    console.log(JSON.stringify(discordPayload(event), null, 2));
    return;
  }

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(discordPayload(event)),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Discord webhook failed: ${response.status} ${response.statusText} ${body}`);
  }
}

async function main() {
  const seenIds = await readSeenIds();
  const hadExistingState = seenIds.size > 0;

  const events = await scrapeEvents();
  console.log(`Found ${events.length} events.`);

  if (!events.length) {
    console.log("No events found. Not updating seen file, because the page may have changed.");
    process.exitCode = 1;
    return;
  }

  const newEvents = events.filter((event) => !seenIds.has(eventId(event)));
  console.log(`New events: ${newEvents.length}`);

  if (!hadExistingState && !POST_EXISTING) {
    console.log("First run: saving current events as baseline without posting.");
    for (const event of events) seenIds.add(eventId(event));
    await writeSeenIds(seenIds);
    return;
  }

  const toPost = newEvents.slice(0, MAX_POSTS_PER_RUN);
  for (const event of toPost) {
    await postToDiscord(event);
    seenIds.add(eventId(event));
    console.log(`Posted: ${event.date} - ${event.title}`);
  }

  // Add all currently known events after successful run so old calendar items do not repost.
  for (const event of events) seenIds.add(eventId(event));
  await writeSeenIds(seenIds);

  if (newEvents.length > toPost.length) {
    console.log(`Skipped ${newEvents.length - toPost.length} events due to MAX_POSTS_PER_RUN.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
