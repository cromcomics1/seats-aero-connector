# seats-aero-connector

A small Cloudflare Worker that exposes seats.aero award search to Claude as a custom connector (MCP).

## Tools
- `search_award_availability` – cached availability, filter by program, cabin, min seats, operating carrier
- `bulk_availability` – broad scan for one program
- `get_trip_details` – exact flights/flight numbers for one availability ID
- `find_carrier_only_awards` – strict "every flight is AF" check, one leg at a time

## Deploy
1. Get your seats.aero Pro API key at https://seats.aero/apikey (never commit it).
2. In Cloudflare: Workers & Pages > Create > Import a repository > pick this repo.
3. In the Worker's Settings > Variables and Secrets, add two **secrets**:
   - `SEATS_API_KEY` = your seats.aero key
   - `CONNECTOR_TOKEN` = a long random string (e.g. 40+ characters)
4. Your connector URL is: `https://seats-aero-connector.<your-subdomain>.workers.dev/mcp/<CONNECTOR_TOKEN>`
5. In Claude: Settings > Connectors > Add custom connector > paste that URL.

Treat the URL as a password: anyone who has it can use your API quota (1,000 calls/day).
