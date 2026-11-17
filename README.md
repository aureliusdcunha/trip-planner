# Trip Planner

Single-file HTML app. Enter destination + dates, get a report: stays, sights, food, day-by-day plan.

## Status
Runs inside claude.ai as an Artifact. It uses the `window.claude` `sample` capability to generate reports.
That API does NOT exist on GitHub Pages or any other host.

## To run it standalone
Replace the `sample(...)` call in `index.html` with a `fetch` to your own backend
(for example a Cloudflare Worker that holds an Anthropic API key and returns the JSON).
Never put an API key in the page.

## Deploy (GitHub Pages)
Settings > Pages > Deploy from branch > main / root.
