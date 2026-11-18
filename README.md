# Trip Planner

Enter a destination and dates to generate stays, sights, food recommendations and a day-by-day itinerary.

## Research architecture

The Pages Function orchestrates specialised research agents rather than asking one model call to create the entire report:

1. A route architect selects overnight bases and distributes nights.
2. For each base, separate stay, attractions and dining researchers work independently.
3. Flight, local transport, and practical-guide/budget researchers run alongside them.
4. Once research is complete, one day planner is launched for each travel date. Day planners use the selected route and researched attractions.
5. Tasks run with bounded concurrency, individual validation, progress events and a shared retry budget. The final report is assembled only after completeness checks pass.

The browser receives Server-Sent Events for stage, agent, search and heartbeat progress. The report renderer and dynamic budget calculator remain browser-side.

### Live Google Search grounding

The form includes an optional **Use Google Search for each specialist researcher** checkbox. It is off by default. When enabled, the route, hotel, attraction, dining, flight, transport and practical-guide agents can use Gemini's built-in Google Search grounding. This may incur usage charges and requires a billing-enabled Gemini API project for Gemini 3.8 Flash. Day planners use the already researched attractions and do not issue redundant searches.

When Search is off, agents still work independently but use the model's existing knowledge rather than live web grounding. Treat their prices and availability as indicative, not live quotes.

## Project structure

- `public/index.html`: browser interface, stream reader, report renderer and dynamic budget calculation
- `functions/api/plan.js`: Cloudflare Pages Function for `POST /api/plan`; orchestrates Gemini Interactions API agents and SSE
- `wrangler.toml`: Cloudflare Pages project configuration

## Deploy with Cloudflare Pages

1. Connect this GitHub repository to a Cloudflare Pages project.
2. Set the build command to **none** and the build output directory to `public`.
3. In **Settings → Variables and Secrets**, add `GEMINI_API_KEY` as an encrypted secret.
4. Optionally set `MODEL` as a plain-text environment variable. The default is `gemini-3.8-flash`.
5. Deploy or trigger a new deployment after adding the secret.

Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/app/apikey). Keep it server-side as a Cloudflare secret; do not add it to the HTML or commit it to the repository.

Gemini API availability, free-tier quotas and pricing depend on Google's current model and account policies. For production, configure rate limiting for `/api/plan` and monitor API usage.
