# Trip Planner

Enter a destination and dates to generate stays, sights, food recommendations and a day-by-day itinerary.

## Project structure

- `public/index.html`: browser interface
- `functions/api/plan.js`: Cloudflare Pages Function for `POST /api/plan`; calls the Anthropic Messages API
- `wrangler.toml`: Cloudflare Pages project configuration

## Deploy with Cloudflare Pages

1. In Cloudflare, open **Workers & Pages** and create a Pages project connected to this GitHub repository.
2. Set the build command to **none** and the build output directory to `public`.
3. Add `ANTHROPIC_API_KEY` as an encrypted secret in the Pages project settings. Optionally set `MODEL` as an environment variable.
4. Deploy or trigger a new deployment.

The API key must remain a server-side secret; do not add it to the HTML or commit it to the repository.

For production, configure rate limiting for `/api/plan` and set an API spending limit.
