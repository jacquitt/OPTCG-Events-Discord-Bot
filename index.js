import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const EVENTS_URL = process.env.EVENTS_URL || "https://en.onepiece-cardgame.com/events/";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const STATE_FILE = process.env.STATE_FILE || "data/seen-events.json";

const POST_EXISTING = String(process.env.POST_EXISTING || "false").toLowerCase() === "true";
const MAX_POSTS_PER_RUN = Number(process.env.MAX_POSTS_PER_RUN || 10);

function clean(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&rsquo;/g, "’")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripHtmlToLines(html) {
  const text = decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|tr|td|th)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );

  return text
    .split("\n")
    .map(clean)
    .filter(Boolean);
}

function absoluteUrl(href, baseUrl = EVENTS_URL) {
  return new URL(href, baseUrl).toString();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 Discord event checker",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function eventId(event) {
  return crypto
    .createHash("sha256")
    .update(`${event.source}|${event.date}|${event.title}|${event.region || ""}|${event.venue || ""}`)
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

function parseMainEventLinks(html) {
  const links = [];
  const seen = new Set();

  const anchorRegex = /<a\b[^>]*href=["']([^"']*\/events\/[^"']+\.html|[^"']+\.html)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const href = match[1];
    const inner = match[2];

    const url = absoluteUrl(href);
    if (!url.includes("/events/")) continue;
    if (url.endsWith("/events/")) continue;
    if (seen.has(url)) continue;

    const text = clean(stripHtmlToLines(inner).join(" "));
    if (!text || /view all events|past events/i.test(text)) continue;

    seen.add(url);
    links.push({ url, text });
  }

  return links;
}

function parseTitleFromDetail(html, fallbackText, detailUrl) {
  const lines = stripHtmlToLines(html);

  const eventsIndex = lines.findIndex((line) => /^EVENTS$/i.test(line));
  for (let i = eventsIndex + 1; i < Math.min(lines.length, eventsIndex + 10); i++) {
    const line = lines[i];
    if (
      line &&
      !/^Image/i.test(line) &&
      !/^Championship$/i.test(line) &&
      !/^FOR BEGINNERS$/i.test(line)
    ) {
      return clean(line);
    }
  }

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    return clean(decodeHtml(titleMatch[1]).replace("| ONE PIECE CARD GAME - Official Web Site", ""));
  }

  const fallback = clean(fallbackText.replace(/Event Period:.*$/i, ""));
  return fallback || detailUrl;
}

function parseCardFallback(linkText, detailUrl) {
  const periodMatch = linkText.match(/Event Period:\s*(.*?)(?:Regulation:|$)/i);
  const title = clean(linkText.replace(/Event Period:.*$/i, ""));

  if (!title || !periodMatch) return null;

  return {
    title,
    date: clean(periodMatch[1]),
    venue: "",
    region: "",
    registration: "",
    source: detailUrl,
  };
}

function parseDetailedSchedule(html, pageTitle, detailUrl) {
  const lines = stripHtmlToLines(html);
  const events = [];

  const startIndex = lines.findIndex((line) =>
    /Event Schedule and Tournament Organizer/i.test(line)
  );

  if (startIndex === -1) return events;

  const stopRegex = /^(Advanced Application Method|Application Period|Prize|Side Event|Tournament Rules|Notes|Important Notes|Products|VIEW ALL EVENTS)$/i;
  const regionRegex = /^(North America|Europe|Oceania|Latin America|Middle East|Asia|Online)$/i;

  let currentRegion = "";
  let currentOrganizer = "";

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    if (stopRegex.test(line)) break;

    if (regionRegex.test(line)) {
      currentRegion = line;
      currentOrganizer = "";
      continue;
    }

    if (/^Date:/i.test(line)) {
      const date = clean(line.replace(/^Date:\s*/i, ""));
      let venue = "";
      let registration = "";

      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];

        if (stopRegex.test(next)) break;
        if (regionRegex.test(next)) break;
        if (/^Date:/i.test(next)) break;

        if (/^Venue:/i.test(next)) {
          venue = clean(next.replace(/^Venue:\s*/i, ""));
        } else if (/^Link:/i.test(next)) {
          registration = clean(next.replace(/^Link:\s*/i, ""));
        } else if (
          next &&
          !/^Registration$/i.test(next) &&
          !/^TBA$/i.test(next) &&
          !/:$/.test(next)
        ) {
          // Keep scanning; organizer headings are handled outside this block.
        }
      }

      events.push({
        title: currentOrganizer ? `${pageTitle} - ${currentOrganizer}` : pageTitle,
        date,
        venue,
        region: currentRegion,
        registration,
        source: detailUrl,
      });

      continue;
    }

    if (
      line &&
      !/^Overview$/i.test(line) &&
      !/^Period$/i.test(line) &&
      !/^Format$/i.test(line) &&
      !/^Regulation$/i.test(line) &&
      !/^Date:/i.test(line) &&
      !/^Venue:/i.test(line) &&
      !/^Link:/i.test(line)
    ) {
      currentOrganizer = line;
    }
  }

  return events;
}

async function scrapeEvents() {
  const mainHtml = await fetchText(EVENTS_URL);
  const links = parseMainEventLinks(mainHtml);

  console.log(`Found ${links.length} official event pages.`);

  const allEvents = [];

  for (const link of links) {
    try {
      const detailHtml = await fetchText(link.url);
      const pageTitle = parseTitleFromDetail(detailHtml, link.text, link.url);

      const detailedEvents = parseDetailedSchedule(detailHtml, pageTitle, link.url);

      if (detailedEvents.length) {
        allEvents.push(...detailedEvents);
      } else {
        const fallback = parseCardFallback(link.text, link.url);
        if (fallback) allEvents.push(fallback);
      }
    } catch (error) {
      console.log(`Could not parse ${link.url}: ${error.message}`);
    }
  }

  const byId = new Map();
  for (const event of allEvents) {
    if (!event.title || !event.date) continue;
    byId.set(eventId(event), event);
  }

  return [...byId.values()];
}

function discordPayload(event) {
  const fields = [
    {
      name: "Date",
      value: event.date || "TBA",
      inline: true,
    },
  ];

  if (event.region) {
    fields.push({
      name: "Region",
      value: event.region,
      inline: true,
    });
  }

  if (event.venue) {
    fields.push({
      name: "Venue",
      value: event.venue.slice(0, 1024),
      inline: false,
    });
  }

  return {
    username: "ONE PIECE Events",
    embeds: [
      {
        title: `🏴‍☠️ ${event.title}`,
        url: event.source,
        description: "New official ONE PIECE CARD GAME event found.",
        fields,
        footer: {
          text: "Source: Official ONE PIECE CARD GAME website",
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
  console.log(`Found ${events.length} official events.`);

  if (!events.length) {
    console.log("No events found. Not updating seen file.");
    process.exitCode = 1;
    return;
  }

  const newEvents = events.filter((event) => !seenIds.has(eventId(event)));
  console.log(`New events: ${newEvents.length}`);

  if (!hadExistingState && !POST_EXISTING) {
    console.log("First run: saving current official events as baseline without posting.");
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
