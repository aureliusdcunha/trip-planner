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


### Per-minute rate-limit handling

Gemini Free Tier may return HTTP 429 for a per-minute request limit while the model remains available. The planner parses provider responses such as `15 requests per minute; retry in 55s`, pauses the shared researcher queue until the stated reset plus a one-second safety margin, and retries the same model. Daily quota exhaustion still advances to the next configured model.

A shared request gate limits the planner to two in-flight Gemini requests and spaces request starts by at least 4.3 seconds (under 14 starts per minute). The UI displays the cooldown while researchers wait. A bounded request budget and overall plan deadline still apply; if provider capacity or quota remains unavailable after the allowed attempts, the plan reports that limitation.

### Incomplete Gemini response recovery

Specialist calls use larger output-token budgets appropriate to their structured result sizes (attractions 3,200 tokens, hotels 2,000, flights 2,200, daily plans 2,200, and larger limits for guide/budget output). If Gemini ends with status `incomplete`, the planner first checks whether the JSON is nevertheless complete and passes all required validation. Otherwise it retries the same model once with a doubled output limit (up to 8,192 tokens), then tries the next configured model if needed. This recovery path uses the existing per-itinerary API request ceiling and reports a named task error only after bounded recovery is exhausted.

### Home-currency prices and report detail

All model price fields are returned in destination-local currency. The Worker fetches a daily reference rate from Frankfurter's public API and pins the traveller's selected home currency onto the budget. The report displays home currency first and destination-local currency in brackets (for example, `₹2,350 (THB 1,000)`). If the reference-rate service is unavailable, the app uses the model-estimated rate when available and labels that fallback.

The report follows the structure of the supplied static family itinerary reference: outbound/return flight recommendations, domestic connections where relevant, budget/mid-range/splurge hotel options for each base, family-oriented daily schedules, attraction price comparisons, dining ideas, shopping guide, practical family tips and a smart-mix budget strategy. Destination-specific properties and recommendations are researched per trip; static Thailand names or prices are not copied into other destinations.

### Chat assistant AI providers

The chatbot uses a server-side provider chain. Cloudflare Workers AI is the default first provider when the Pages project has an AI binding named `AI`; if the binding is absent or a request fails, the function continues to the configured external providers. The Cloudflare model is pinned in code to `@cf/zai-org/glm-4.7-flash` rather than accepting a dashboard-supplied model override. It uses the Workers AI binding directly and needs no separate Cloudflare API key.

To enable it for the Pages project:

1. Open **Workers & Pages → your TripPlanner Pages project → Settings**.
2. Under the **Production** environment, open **Bindings → Add → Workers AI**.
3. Set **Variable name** to exactly `AI`, save, and repeat for **Preview** if you want preview deployments to use it.
4. Redeploy the Pages project so the binding is available to Functions.

The chatbot's Cloudflare Workers AI call does not use Google Search grounding and therefore does not return verified live-search citations. It is suitable for general travel help and trip-context questions; time-sensitive facts must be checked against current official sources. Gemini remains in the fallback chain and can provide Google Search grounding when configured.

**Usage and cost:** Workers AI has a daily included Free allocation (currently 10,000 Neurons/day). Usage beyond the included allocation depends on the Cloudflare Workers plan and billing settings; Free-plan requests stop after the daily allocation, while Paid-plan overages may be billed. Check the current [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) before enabling production traffic. Do not assume all models have identical free-tier eligibility. The chatbot pins the model above and does not route through AI Gateway or a third-party paid model as part of the Cloudflare provider.

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


## Flight price search (Google Flights via SerpApi)

The Flights tab is a price-comparison tool only. It does not book flights, create orders, request booking tokens, issue tickets, or collect payments.

The Cloudflare Pages Function at `/api/flights` uses SerpApi's Google Flights and Google Flights Autocomplete engines. It supports airport suggestions, outbound and return one-way price searches, and four cabin classes: Economy, Premium Economy, Business and First. Results include airlines, flight numbers, times, journey duration, stop count, layovers and indicative prices. TripPlanner's cabin and stop filters work locally on the returned results and do not trigger additional API searches.

Configure the encrypted Cloudflare Pages secret `SERPAPI_API_KEY`. Never put the key in browser code or commit it to Git. From a local terminal, Wrangler can set it with:

```bash
npx wrangler pages secret put SERPAPI_API_KEY
```

Then paste the key when prompted and redeploy the Pages project.

SerpApi currently lists a free plan with 250 searches per month and 50 searches per hour. DataCrawler and Perceptlayer have separate account quotas; RapidAPI usage is controlled by the selected API subscription and Perceptlayer's free tier currently advertises 1,000 monthly credits. Each fallback provider is called only after SerpApi quota exhaustion; Perceptlayer is called only if DataCrawler also fails. A full TripPlanner fare search performs eight Google Flights searches (four cabin classes × outbound and return), plus up to two airport-resolution autocomplete requests when the saved departure/destination are city names rather than IATA codes. Cached responses may be served without consuming a search. The free allowance therefore supports up to approximately 25 full fare-search sessions per month in the conservative case where both airport lookups and all eight fare searches count; actual usage can be lower when results are cached. TripPlanner also reads the SerpApi Account API to show live monthly usage and remaining searches; this account-status endpoint is free and does not count against the search quota. Monitor the SerpApi dashboard for actual consumption and plan limits.

Prices are indicative Google Flights results, not guaranteed airline inventory or a final payable quote. The API query is made for one adult so displayed fares are per adult. The TripPlanner budget uses the adult fare as a planning proxy for children and estimates lap infants at 10%; passenger-specific fares may differ. The provider's result should be checked again close to purchase. No booking link or booking flow is implemented.

Official references: [Google Flights API](https://serpapi.com/google-flights-api), [Google Flights Autocomplete API](https://serpapi.com/google-flights-autocomplete-api), [SerpApi pricing](https://serpapi.com/pricing).
