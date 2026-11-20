# hktransport web

The web app: a static page, live at <https://hk.52-220-124-215.sslip.io/>.

Route data comes from hkbus.app and arrivals come straight from the operators. The site's server
handles Google place, walking and public transport requests and DeepSeek. With Google Maps active,
Google transit supplies routes and walking times. The built-in RAPTOR planner supplies alternatives
when Google has no suitable journey. The app defaults to less walking and only shows walks over 10
minutes on request. On a static host such as GitHub Pages, the built-in planner and free map are
available without the server.

| File | Purpose |
| --- | --- |
| `js/transit.js` | Route data, RAPTOR search, journey ranking and navigation maths |
| `js/google-transit.js` | Google transit requests, journey conversion and stop matching for operator ETAs |
| `js/eta.js` | Per-operator arrival fetchers and parsers |
| `js/ai.js` | DeepSeek client, prompts and the rule parser used without a key |
| `js/places.js` | Place search and walking routes: Google through the server, then the free sources |
| `js/hans.js` | Traditional to Simplified Chinese |
| `js/planner.worker.js` | Runs the route search off the main thread |
| `js/app.js` | The page |

Run the tests with `node --test web/test/core.test.mjs`. To try it locally:

```bash
python3 -m http.server 8642 --directory web
```

To publish to your own server, put `DEPLOY_HOST`, `DEPLOY_KEY` and `DEPLOY_DOMAIN` in `.env.deploy`
(ignored by git) and run `Deploy web.command`. Run `Set AI key.command` once to put the DeepSeek key
on the server. It never goes into the repository or the web folder. Run `Set routes key.command` for walking and transit routes, and `Set Google keys.command` to add
Google's map and place keys. The server caps usage at 5,000 walking requests and 4,000 transit
requests per month. Google transit runs with Google Maps active. Browsers can see the map key, so
limit it to your domain and set daily quotas in Google Cloud.

To publish to GitHub Pages, push `web/` to the `gh-pages` branch:

```bash
git push origin "$(git subtree split --prefix web)":refs/heads/gh-pages --force
```
