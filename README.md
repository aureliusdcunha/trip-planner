# Trip Planner

Enter a destination and dates to generate stays, sights, food recommendations and a day-by-day itinerary.

## Project structure

- `public/index.html`: browser interface
- `functions/api/plan.js`: Cloudflare Pages Function for `POST /api/plan`; calls the Google Gemini API
- `wrangler.toml`: Cloudflare Pages project configuration

## Deploy with Cloudflare Pages

1. Connect this GitHub repository to a Cloudflare Pages project.
2. Set the build command to **none** and the build output directory to `public`.
3. In **Settings → Variables and Secrets**, add `GEMINI_API_KEY` as an encrypted secret.
4. Optionally set `MODEL` as a plain-text environment variable. The default is `gemini-3.8-flash`.
5. Deploy or trigger a new deployment after adding the secret.

Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/app/apikey). Keep it server-side as a Cloudflare secret; do not add it to the HTML or commit it to the repository.

Gemini API availability, free-tier quotas and pricing depend on Google's current model and account policies. For production, configure rate limiting for `/api/plan` and monitor API usage.
