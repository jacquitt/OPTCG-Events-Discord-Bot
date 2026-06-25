import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const EVENTS_URL = process.env.EVENTS_URL || "https://en.onepiece-cardgame.com/events/";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const STATE_FILE = process.env.STATE_FILE || "data/seen-events.json";

const POST_EXISTING = String(process.env.POST_EXISTING || "false").toLowerCase() === "true";
const MAX_POSTS_PER_RUN = Number(process.env.MAX_POSTS_PER_RUN || 10);

// Default: only North America.
// You can override this in GitHub Actions with ALLOWED_REGIONS.
const ALLOWED_REGIONS = new Set(
  String(process.env.ALLOWED_REGIONS || "North America")
    .split(",")
    .map((region) => region.trim().toLowerCase())
    .filter(Boolean)
);

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

function absoluteUrl(href, baseUrl = EVENTS_URL) {
  return new URL(href, baseUrl).toString();
}

function stripHtmlToLines(html, baseUrl = EVENTS_URL) {
  const htmlWithLinksPreserved = html.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, inner) => {
      const label = clean(inner.replace(/<[^>]+>/g, " "));
      const url = absoluteUrl(decodeHtml(href), baseUrl);
      return label ? `${label} ${url}` : url;
    }
  );

  const text = decodeHtml(
    htmlWithLinksPreserved
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

function standardRegion(region) {
  const cleaned = clean(region);

  if (/^north america$/i.test(cleaned)) return "North America";
  if (/^europe$/i.test(cleaned)) return "Europe";
  if (/^oceania$/i.test(cleaned)) return "Oceania";
  if (/^latin america$/i.test(cleaned)) return "Latin America";
  if (/^middle east$/i.test(cleaned)) return "Middle East";
  if (/^asia$/i.test(cleaned)) return "Asia";
  if (/^online$/i.test(cleaned)) return "Online";

  return cleaned;
}

function isAllowedRegion(region) {
  if (!ALLOWED_REGIONS.size) return true;
  return ALLOWED_REGIONS.has(clean(region).toLowerCase());
}

function getFirstMonthFromDate(dateText) {
  const match = String(dateText || "").match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i
  );

  if (!match) return "";
  return match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
}

function parseApplicationInfo(lines) {
  const monthSignupDates = {};
  const regionSignupTimes = {};

  const startIndex = lines.findIndex((line) => /^Application Period$/i.test(line));

  if (startIndex === -1) {
    return { monthSignupDates, regionSignupTimes };
  }

  const stopRegex = /^(Prize|Side Event|Tournament Rules|Notes|Important Notes|Products|VIEW ALL EVENTS)$/i;

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    if (stopRegex.test(line)) break;

    const monthMatch = line.match(/^For\s+(.+?)\s+Events?:\s*(.+)$/i);
    if (monthMatch) {
      const month = clean(monthMatch[1]);
      const signupDate = clean(monthMatch[2]);
      monthSignupDates[month] = signupDate;
      continue;
    }

    const regionMatch = line.match(/^(North America|Europe|Oceania|Latin America|Middle East|Asia|Online):\s*(.+)$/i);
    if (regionMatch) {
      const region = standardRegion(regionMatch[1]);
      const time = clean(regionMatch[2]);
      regionSignupTimes[region] = time;
      continue;
    }
  }

  return { monthSignupDates, regionSignupTimes };
}

function getSignupGuide(event, applicationInfo) {
  const month = getFirstMonthFromDate(event.date);
  const signupDate = applicationInfo.monthSignupDates[month] || "";
  const signupTime = applicationInfo.regionSignupTimes[event.region] || "";

  if (signupDate && signupTime) {
    return `${signupDate} at ${signupTime}`;
  }

  if (signupDate) return signupDate;
  if (signupTime) return signupTime;

  return "";
}

function getFirstUrl(text) {
  const match = String(text || "").match(/https?:\/\/\S+/i);
  return match ? match[0] : "";
}

function eventId(event) {
  return crypto
    .createHash("sha256")
    .update(`${event.source}|${event.date}|${event.title}|${event.region || ""}|${event.venue || ""}|${event.signupGuide || ""}`)
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
  const lines = stripHtmlToLines(html, detailUrl);

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const title = clean(
      decodeHtml(titleMatch[1])
        .replace("| ONE PIECE CARD GAME - Official Web Site", "")
        .replace("｜ONE PIECE CARD GAME - Official Web Site", "")
    );

    if (title) return title;
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
    signupGuide: "",
    source: detailUrl,
  };
}

function parseDetailedSchedule(html, pageTitle, detailUrl) {
  const lines = stripHtmlToLines(html, detailUrl);
  const applicationInfo = parseApplicationInfo(lines);
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
      currentRegion = standardRegion(line);
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
        }
      }

      const event = {
        title: currentOrganizer ? `${pageTitle} - ${currentOrganizer}` : pageTitle,
        date,
        venue,
        region: currentRegion,
        registration,
        signupGuide: "",
        source: detailUrl,
      };

      event.signupGuide = getSignupGuide(event, applicationInfo);

      events.push(event);
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

const MONTHS = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

function parseEventStartDate(dateText) {
  const text = clean(String(dateText || "").replace(/\u200b/g, ""));

  const yearMatch = text.match(/\b(20\d{2})\b/);
  const monthMatch = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i
  );

  if (!yearMatch || !monthMatch) return null;

  const year = Number(yearMatch[1]);
  const monthName = monthMatch[1].toLowerCase();
  const month = MONTHS[monthName];

  const afterMonth = text.slice(monthMatch.index + monthMatch[0].length);
  const dayMatch = afterMonth.match(/\s+(\d{1,2})/);

  // If the official site says something like "August - September 2026",
  // treat it as the 1st of the first month for sorting/filtering.
  const day = dayMatch ? Number(dayMatch[1]) : 1;

  return new Date(year, month, day);
}

function isFutureOrUpcomingEvent(dateText) {
  const eventDate = parseEventStartDate(dateText);

  if (!eventDate) {
    return true; // Keep TBA/unknown dates instead of accidentally hiding them.
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return eventDate >= today;
}

function normalizeEventFields(event) {
  let date = clean(event.date);
  let venue = clean(event.venue);
  let registration = clean(event.registration);

  // Fix cases where the site gets read as:
  // Date: June 27, 2026 Venue: ... Link: Registration ...
  const venueFromDate = date.match(/\s+Venue:\s*(.*?)(?:\s+Link:\s*|$)/i);
  if (!venue && venueFromDate) {
    venue = clean(venueFromDate[1]);
  }

  const linkFromDate = date.match(/\s+Link:\s*(.*)$/i);
  if (!registration && linkFromDate) {
    registration = clean(linkFromDate[1]);
  }

  date = clean(date.replace(/\s+Venue:.*$/i, "").replace(/\s+Link:.*$/i, ""));

  // Fix cases where venue contains the registration link.
  const linkFromVenue = venue.match(/\s+Link:\s*(.*)$/i);
  if (linkFromVenue) {
    if (!registration) registration = clean(linkFromVenue[1]);
    venue = clean(venue.replace(/\s+Link:.*$/i, ""));
  }

  return {
    ...event,
    date,
    venue,
    registration,
  };
}

function compareEventsChronologically(a, b) {
  const dateA = parseEventStartDate(a.date);
  const dateB = parseEventStartDate(b.date);

  if (dateA && dateB) {
    const diff = dateA.getTime() - dateB.getTime();
    if (diff !== 0) return diff;
  }

  if (dateA && !dateB) return -1;
  if (!dateA && dateB) return 1;

  return `${a.title} ${a.venue}`.localeCompare(`${b.title} ${b.venue}`);
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

  const filteredEvents = allEvents
  .map(normalizeEventFields)
  .filter((event) => {
    return event.region && isAllowedRegion(event.region) && isFutureOrUpcomingEvent(event.date);
  })
  .sort(compareEventsChronologically);

  const byId = new Map();
  for (const event of filteredEvents) {
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
    {
      name: "Region",
      value: event.region || "TBA",
      inline: true,
    },
  ];

  if (event.signupGuide) {
    fields.push({
      name: "Sign-up guide",
      value: `${event.signupGuide}\nExact time may vary by organizer.`,
      inline: false,
    });
  }

  if (event.venue) {
    fields.push({
      name: "Venue",
      value: event.venue.slice(0, 1024),
      inline: false,
    });
  }

  if (event.registration) {
    const registrationUrl = getFirstUrl(event.registration);
    fields.push({
      name: "Registration",
      value: registrationUrl ? `[Registration link](${registrationUrl})` : event.registration.slice(0, 1024),
      inline: false,
    });
  }

  return {
    username: "ONE PIECE Events",
    embeds: [
      {
        title: `🏴‍☠️ ${event.title}`,
        url: event.source,
        description: "New North America official ONE PIECE CARD GAME event found.",
        fields,
        footer: {
          text: "Source: Official ONE PIECE CARD GAME website",
        },
      },
    ],
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postToDiscord(event) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("[DRY RUN] No DISCORD_WEBHOOK_URL set. Would post:");
    console.log(JSON.stringify(discordPayload(event), null, 2));
    return;
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(discordPayload(event)),
    });

    if (response.ok) {
      // Small delay so Discord does not get spammed too fast.
      await sleep(2000);
      return;
    }

    const body = await response.text().catch(() => "");

    if (response.status === 429) {
      let retryAfterMs = 1800;

      try {
        const data = JSON.parse(body);
        if (data.retry_after) {
          retryAfterMs = Math.ceil(Number(data.retry_after) * 1000) + 1000;
        }
      } catch {}

      console.log(`Discord rate limited. Waiting ${retryAfterMs}ms, then retrying...`);
      await sleep(retryAfterMs);
      continue;
    }

    throw new Error(`Discord webhook failed: ${response.status} ${response.statusText} ${body}`);
  }

  throw new Error("Discord webhook failed after too many retry attempts.");
}

async function main() {
  const seenIds = await readSeenIds();
  const hadExistingState = seenIds.size > 0;

  const events = await scrapeEvents();
  console.log(`Found ${events.length} North America official events.`);

  if (!events.length) {
    console.log("No North America events found. Not updating seen file.");
    process.exitCode = 1;
    return;
  }

  const newEvents = events.filter((event) => !seenIds.has(eventId(event)));
  console.log(`New events: ${newEvents.length}`);

  if (!hadExistingState && !POST_EXISTING) {
    console.log("First run: saving current North America official events as baseline without posting.");
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

await writeSeenIds(seenIds);

  if (newEvents.length > toPost.length) {
    console.log(`Skipped ${newEvents.length - toPost.length} events due to MAX_POSTS_PER_RUN.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
