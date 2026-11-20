# hktransport web

The web app: a static page, live at <https://hk.52-220-124-215.sslip.io/>.

Route data comes from hkbus.app and arrivals come straight from the operators. The site's server
handles Transitous, Google and DeepSeek requests. The planner compares the results of Transitous,
RAPTOR and Google (when Google Maps is active) for the same search. The app defaults to less walking and only shows walks over 10
minutes on request. On a static host such as GitHub Pages, the built-in planner and free map are
available without the server.

| File | Purpose |
| --- | --- |
| `js/transit.js` | Route data, RAPTOR search, journey ranking and navigation maths |
| `js/google-transit.js`, `js/transitous.js` | Direction requests and journey conversion by provider |
| `js/transit-provider.js` | Shared scheduled journeys and stop matching for operator ETAs |
| `js/eta.js` | Per-operator arrival fetchers and parsers |
| `js/ai.js` | DeepSeek client, prompts and rule parser |
| `js/places.js` | Place search and walking routes: Google through the server, then the free sources |
| `js/hans.js` | Traditional to Simplified Chinese |
| `js/planner.worker.js` | Runs the route search off the main thread |
| `js/app.js` | The page |

Run the tests with `node --test web/test/core.test.mjs`. To try it locally:

```bash
python3 -m http.server 8642 --directory web
```

To publish to your own server, put `DEPLOY_HOST`, `DEPLOY_KEY` and `DEPLOY_DOMAIN` in `.env.deploy`
(ignored by git) and run `Deploy web.command`. Users enter their own DeepSeek key in Settings → AI API.
Run `Set routes key.command` for walking and transit routes, and `Set Google keys.command` to add
Google's map and place keys. The server caps usage at 5,000 walking requests and 4,000 transit
requests per month. Google transit runs with Google Maps active. Browsers can see the map key, so
limit it to your domain and set daily quotas in Google Cloud.

Transitous is enabled on the server by default. Set `TRANSITOUS_ENABLED=0`
in the service environment to disable it. The proxy identifies the application to Transitous
and caps usage at 300 requests per day across the site.

Explore nearby uses Google Places and Wikivoyage. To enable Brave web search, set
`BRAVE_SEARCH_API_KEY` in the server's `/etc/hktransport/search.env` and restart
`hktransport-ai`. The service uses Wikivoyage when Brave is unavailable.

To publish to GitHub Pages, push `web/` to the `gh-pages` branch:

```bash
git push origin "$(git subtree split --prefix web)":refs/heads/gh-pages --force
```
