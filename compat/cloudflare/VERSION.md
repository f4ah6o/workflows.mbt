# Cloudflare compatibility oracle

Cloudflare Workflows API checked: **2026-09-26**

Relevant upstream documentation:

- Workers API: https://developers.cloudflare.com/workflows/build/workers-api/
- Sleeping and retrying: https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/
- Events and parameters: https://developers.cloudflare.com/workflows/build/events-and-parameters/
- Rules of Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/
- Workflows REST API: https://developers.cloudflare.com/api/resources/workflows/

Behavior pinned by the v0.1 compatibility tests:

- retry defaults: 5 retries, 10 second initial delay, exponential backoff
- retry `limit` counts retries, so `limit: 5` allows 6 total attempts
- `waitForEvent` default timeout: 24 hours
- step count is 1-origin for repeated same-name/same-type steps
- restart selection defaults to `count: 1`, `type: "do"`
- an event may arrive before the workflow reaches its matching `waitForEvent`

This project is a clean-room compatibility implementation. Cloudflare source code is
not copied into the runtime.
