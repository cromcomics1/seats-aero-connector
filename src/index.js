// seats.aero MCP connector for Cloudflare Workers.
// Speaks MCP over Streamable HTTP (stateless JSON responses).
// URL shape:  https://<worker>.workers.dev/mcp/<CONNECTOR_TOKEN>

const API = "https://seats.aero/partnerapi";
const CABIN_CODE = { economy: "Y", premium: "W", business: "J", first: "F" };

const TOOLS = [
  {
    name: "search_award_availability",
    description:
      "Cached award availability for one origin/destination (airport codes or comma-separated list) over a date range. Optionally filter by program, cabin, minimum seats, and the airlines you choose.",
    inputSchema: {
      type: "object",
      properties: {
        origin_airport: { type: "string", description: "e.g. JFK or JFK,EWR,BOS" },
        destination_airport: { type: "string", description: "e.g. CDG or NRT,HND,KIX" },
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD" },
        cabin: { type: "string", enum: ["economy", "premium", "business", "first"] },
        source: { type: "string", description: "Program, e.g. flyingblue, aeroplan, united" },
        min_seats: { type: "integer", description: "Only return days with at least this many seats" },
        carriers: { type: "string", description: "Airlines you want, comma-separated IATA codes, e.g. AF or AF,DL,KL,JL,NH" },
        carrier_match: { type: "string", enum: ["only", "any"], description: "only (default): every airline on the itinerary must be in your list. any: at least one must be." },
        exclude_carriers: { type: "string", description: "Airlines to rule out, comma-separated, e.g. KL" },
        direct_only: { type: "boolean" },
      },
      required: ["origin_airport", "destination_airport", "start_date", "end_date"],
    },
  },
  {
    name: "bulk_availability",
    description: "Broad availability scan for one program across many routes and dates.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        start_date: { type: "string" },
        end_date: { type: "string" },
        cabin: { type: "string", enum: ["economy", "premium", "business", "first"] },
        origin_region: { type: "string", description: "e.g. North America" },
        destination_region: { type: "string", description: "e.g. Asia" },
      },
      required: ["source", "start_date", "end_date"],
    },
  },
  {
    name: "api_debug",
    description: "Debug only: call a seats.aero partner API GET path and return the HTTP status plus the first part of the raw body.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "e.g. /search" },
        params: { type: "string", description: "JSON object of query params" },
        max_chars: { type: "integer", default: 2500 },
      },
      required: ["path"],
    },
  },
  {
    name: "get_trip_details",
    description: "Exact flights, flight numbers, taxes and mileage cost for one availability ID.",
    inputSchema: {
      type: "object",
      properties: { availability_id: { type: "string" } },
      required: ["availability_id"],
    },
  },
  {
    name: "find_awards_by_carrier",
    description:
      "Strict airline-filtered award search. You choose the airlines. Searches each origin x destination leg, keeps days with enough seats, then verifies the real flight numbers via trip details (cached airline fields can be wrong). Use one leg at a time, e.g. NA gateways -> CDG, then CDG -> NRT,HND,KIX. carrier_match 'only' = every flight on your list; 'any' = at least one flight on your list.",
    inputSchema: {
      type: "object",
      properties: {
        origins: { type: "string", description: "Comma-separated airports" },
        destinations: { type: "string", description: "Comma-separated airports" },
        start_date: { type: "string" },
        end_date: { type: "string" },
        carriers: { type: "string", description: "Airlines you want, e.g. AF or AF,JL,NH. Omit for no airline filter." },
        carrier_match: { type: "string", enum: ["only", "any"], default: "only" },
        exclude_carriers: { type: "string", description: "Airlines to rule out, e.g. KL" },
        cabin: { type: "string", enum: ["economy", "premium", "business", "first"], default: "business" },
        min_seats: { type: "integer", default: 1 },
        source: { type: "string", description: "Program to search, e.g. flyingblue, aeroplan, united, virginatlantic", default: "flyingblue" },
        max_verifications: { type: "integer", default: 25, description: "Cap on trip lookups to protect the 1,000/day API limit" },
      },
      required: ["origins", "destinations", "start_date", "end_date"],
    },
  },
];

async function sa(env, path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { "Partner-Authorization": env.SEATS_API_KEY, accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`seats.aero ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function slim(row, code) {
  return {
    id: row.ID,
    date: row.Date,
    route: `${row.Route?.OriginAirport}-${row.Route?.DestinationAirport}`,
    source: row.Source,
    cabin_code: code,
    miles: row[`${code}MileageCostRaw`] ?? row[`${code}MileageCost`],
    taxes: row[`${code}TotalTaxesRaw`] ?? row[`${code}TotalTaxes`],
    seats: row[`${code}RemainingSeatsRaw`] ?? row[`${code}RemainingSeats`],
    airlines: row[`${code}AirlinesRaw`] || row[`${code}Airlines`],
    direct: row[`${code}DirectRaw`] ?? row[`${code}Direct`],
  };
}

async function search(env, a) {
  const cabin = a.cabin || "business";
  const code = CABIN_CODE[cabin];
  const out = [];
  let skip = 0;
  for (let page = 0; page < 5; page++) {
    const r = await sa(env, "/search", {
      origin_airport: a.origin_airport || a.origins,
      destination_airport: a.destination_airport || a.destinations,
      start_date: a.start_date,
      end_date: a.end_date,
      cabins: cabin,
      sources: a.source,
      only_direct_flights: a.direct_only ? "true" : undefined,
      take: 500,
      skip,
    });
    for (const row of r.data || []) {
      if (!row[`${code}AvailableRaw`] && !row[`${code}Available`]) continue;
      out.push(slim(row, code));
    }
    if (!r.hasMore) break;
    skip += (r.data || []).length;
  }
  return out;
}

const codes = (v) => (v || "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);

// airlines: list of IATA codes found on an itinerary
function airlinesOk(found, f) {
  if (f.exclude.some((c) => found.includes(c))) return false;
  if (!f.want.length) return true;
  if (!found.length) return false;
  return f.match === "any" ? found.some((c) => f.want.includes(c)) : found.every((c) => f.want.includes(c));
}
const mkFilter = (a) => ({ want: codes(a.carriers), exclude: codes(a.exclude_carriers), match: a.carrier_match === "any" ? "any" : "only" });

async function byCarrier(env, a) {
  const f = mkFilter(a);
  const minSeats = a.min_seats ?? 1;
  const cap = a.max_verifications ?? 25;
  const cabin = a.cabin || "business";
  const rows = (await search(env, { ...a, source: a.source || "flyingblue", cabin })).filter((r) => {
    if ((r.seats ?? 0) < minSeats) return false;
    const found = codes(r.airlines);
    // cached field is only a pre-filter: for "only" it must at least touch the list; exclusions applied strictly
    if (f.exclude.some((c) => found.includes(c))) return false;
    if (f.want.length && !found.some((c) => f.want.includes(c))) return false;
    return true;
  });
  rows.sort((x, y) => (x.miles ?? 0) - (y.miles ?? 0));
  const verified = [];
  let checked = 0;
  for (const r of rows) {
    if (checked >= cap) break;
    checked++;
    const t = await sa(env, `/trips/${r.id}`);
    for (const trip of t.data || []) {
      const flights = (trip.FlightNumbers || "").split(",").map((x) => x.trim()).filter(Boolean);
      const found = [...new Set(flights.map((x) => x.slice(0, 2).toUpperCase()))];
      if (flights.length && airlinesOk(found, f) && (trip.RemainingSeats ?? 0) >= minSeats) {
        verified.push({
          date: r.date, route: `${trip.OriginAirport}-${trip.DestinationAirport}`, flights, airlines: found,
          departs: trip.DepartsAt, arrives: trip.ArrivesAt, miles: trip.MileageCost,
          taxes: trip.TotalTaxes, seats: trip.RemainingSeats, availability_id: r.id,
        });
      }
    }
  }
  return {
    filter: { carriers: f.want, match: f.match, exclude: f.exclude, min_seats: minSeats },
    candidates_after_prefilter: rows.length,
    trip_lookups_used: checked,
    note: rows.length > cap ? `Only the cheapest ${cap} candidates were verified; raise max_verifications or narrow the dates.` : undefined,
    verified,
  };
}

async function callTool(env, name, a) {
  if (name === "search_award_availability") {
    const cabin = a.cabin || "business";
    let rows = await search(env, a);
    if (a.min_seats) rows = rows.filter((r) => (r.seats ?? 0) >= a.min_seats);
    const f = mkFilter(a);
    rows = rows.filter((r) => airlinesOk(codes(r.airlines), f));
    return { cabin, count: rows.length, results: rows };
  }
  if (name === "bulk_availability") {
    return sa(env, "/availability", {
      source: a.source, start_date: a.start_date, end_date: a.end_date,
      cabin: a.cabin, origin_region: a.origin_region, destination_region: a.destination_region, take: 500,
    });
  }
  if (name === "api_debug") {
    const url = new URL(API + a.path);
    for (const [k, v] of Object.entries(a.params ? JSON.parse(a.params) : {})) url.searchParams.set(k, String(v));
    const res = await fetch(url, { headers: { "Partner-Authorization": env.SEATS_API_KEY, accept: "application/json" } });
    const text = await res.text();
    return { status: res.status, url: url.toString(), length: text.length, body: text.slice(0, a.max_chars || 2500) };
  }
  if (name === "get_trip_details") return sa(env, `/trips/${encodeURIComponent(a.availability_id)}`);
  if (name === "find_awards_by_carrier") return byCarrier(env, a);
  throw new Error(`Unknown tool: ${name}`);
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

async function rpc(env, msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return { jsonrpc: "2.0", id, result: {
      protocolVersion: params?.protocolVersion || "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "seats-aero-connector", version: "1.0.0" } } };
  }
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    try {
      const data = await callTool(env, params.name, params.arguments || {});
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } };
    } catch (e) {
      return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String(e.message || e) }] } };
    }
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (id === undefined) return null; // notification
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      // Reports only whether secrets exist (never their values) to help debug setup.
      return json({
        ok: true,
        has_SEATS_API_KEY: Boolean(env.SEATS_API_KEY),
        has_CONNECTOR_TOKEN: Boolean(env.CONNECTOR_TOKEN),
        connector_token_length: env.CONNECTOR_TOKEN ? env.CONNECTOR_TOKEN.length : 0,
        connector_token_has_whitespace: env.CONNECTOR_TOKEN ? /\s/.test(env.CONNECTOR_TOKEN) : false,
      });
    }
    const [, base, token] = url.pathname.split("/");
    if (base !== "mcp" || !env.CONNECTOR_TOKEN || token !== env.CONNECTOR_TOKEN) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method === "GET") return new Response("Method not allowed", { status: 405 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let body;
    try { body = await request.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => rpc(env, m)))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202 });
    }
    const res = await rpc(env, body);
    return res ? json(res) : new Response(null, { status: 202 });
  },
};
