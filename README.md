# Trip Planner

Enter a destination and dates to generate stays, sights, food recommendations and a day-by-day itinerary.

## Research architecture

The Pages Function orchestrates specialised research agents rather than asking one model call to create the entire report:

1. Route, flights, and practical-guide/budget agents start in parallel.
2. Once the route's overnight bases are known, each base gets its own stay, attractions and dining researchers. A local-transport researcher runs alongside them.
3. After the research pool completes, a separate day planner is launched for each travel date. Day planners use the selected route and researched attractions.
4. Tasks run with bounded concurrency (five at a time), individual validation, progress events, a shared retry budget and final completeness checks. A failed agent is reported by name; other parallel tasks are allowed to finish before the plan is rejected.

The browser receives Server-Sent Events for stage, agent, search and heartbeat progress. The report renderer and dynamic budget calculator remain browser-side.

### Live Google Search grounding

The form includes an optional **Use Google Search for each specialist researcher** checkbox. It is off by default. When enabled, the route, hotel, attraction, dining, flight, transport and practical-guide agents can use Gemini's built-in Google Search grounding. This may incur usage charges and requires a billing-enabled Gemini API project for Gemini 3.8 Flash. Day planners use the already researched attractions and do not issue redundant searches.

When Search is off, agents still work independently but use the model's existing knowledge rather than live web grounding. Treat their prices and availability as indicative, not live quotes.

### Automatic model quota and capacity fallback

The primary model defaults to `gemini-3.8-flash`. Each itinerary uses a shared model chain:

1. `gemini-3.8-flash` (primary)
2. `gemini-3.5-flash-lite` (first fallback)
3. `gemini-3.1-flash-lite` (second fallback)

HTTP 429 quota failures immediately advance to the next model. HTTP 503/high-demand responses and equivalent streaming errors receive one bounded exponential-backoff retry, then advance to the next model if capacity remains unavailable. Concurrent calls share the same current model, so once one researcher switches, waiting and subsequent researchers use the new model. A request gate limits concurrent Gemini calls to two and spaces their starts to reduce burst load.

- Optional Cloudflare variable `MODEL` selects the primary model.
- Optional `FALLBACK_MODEL` and `TERTIARY_MODEL` select the two fallback models.
- When a Free Tier quota response is detected, Google Search grounding is disabled on fallback models because it is unavailable for those models on the Free Tier. The report explains this limitation and records all models used.
- A shared request budget caps each itinerary below 50 Gemini API subrequests on the Cloudflare Workers Free plan.
- If all configured models are quota-limited or unavailable, the app returns a clear error; it cannot guarantee service availability during a provider-wide outage.


## Project structure

- `public/index.html`: browser interface, stream reader, report renderer and dynamic budget calculation
- `functions/api/plan.js`: Cloudflare Pages Function for `POST /api/plan`; orchestrates Gemini Interactions API agents and SSE
- `wrangler.toml`: Cloudflare Pages project configuration

## Deploy with Cloudflare Pages

1. Connect this GitHub repository to a Cloudflare Pages project.
2. Set the build command to **none** and the build output directory to `public`.
3. In **Settings → Variables and Secrets**, add `GEMINI_API_KEY` as an encrypted secret.
4. Optionally set `MODEL` (default `gemini-3.8-flash`), `FALLBACK_MODEL` (default `gemini-3.5-flash-lite`) and `TERTIARY_MODEL` (default `gemini-3.1-flash-lite`) as plain-text Cloudflare variables.
5. Deploy or trigger a new deployment after adding the secret.

Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/app/apikey). Keep it server-side as a Cloudflare secret; do not add it to the HTML or commit it to the repository.

Gemini API availability, free-tier quotas and pricing depend on Google's current model and account policies. For production, configure rate limiting for `/api/plan` and monitor API usage.


## Application versioning

The current release version is maintained in `public/version.json`. The browser reads this manifest and displays the version badge beside the application name at the top of the page. The manifest is served with `Cache-Control: no-store` so the displayed release number does not remain stale after a deployment.

**Every production deployment must include a version bump in `public/version.json` before merging to `main`.** Use semantic versioning:

- **PATCH** (`1.0.0 → 1.0.1`): bug fixes, reliability improvements and small corrections.
- **MINOR** (`1.0.0 → 1.1.0`): backward-compatible features and enhancements.
- **MAJOR** (`1.0.0 → 2.0.0`): breaking changes or substantial incompatible redesigns.

Update `released` to the production release date and `releaseName` to a short description. Keep the version manifest and code change in the same pull request so every production deployment has a traceable version.
