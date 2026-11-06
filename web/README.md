# hktransport web

The phone version: a static page, published at <https://kevinwentao07-zwt.github.io/hktransport/>.

Every data source allows direct browser calls, so only the AI goes through a server:
route data from hkbus.app, arrivals from the operators, maps from Google on your own server and OpenFreeMap elsewhere, place
search from the Government, shops from OpenStreetMap's Photon, and AI from DeepSeek.
On your own server, `server/ai_proxy.py` holds the DeepSeek key and every visitor can use the AI.
Without it, as on GitHub Pages, riders add their own key in Settings.

| File | Purpose |
| --- | --- |
| `js/transit.js` | Route data, RAPTOR search, journeys and navigation maths |
| `js/eta.js` | Per-operator arrival fetchers and parsers |
| `js/ai.js` | DeepSeek client, prompts and the rule parser used without a key |
| `js/places.js` | Place search and checking AI recommendations on the map |
| `js/planner.worker.js` | Runs the route search off the main thread |
| `js/app.js` | The page |

Run the tests with `node --test web/test/core.test.mjs`. To try it locally:

```bash
python3 -m http.server 8642 --directory web
```

To publish to your own server, put `DEPLOY_HOST`, `DEPLOY_KEY` and `DEPLOY_DOMAIN` in `.env.deploy`
(ignored by git) and run `Deploy web.command`. Run `Set AI key.command` once to put the DeepSeek key
on the server. It never goes into the repository or the web folder. Run `Set Google keys.command` to add
Google's map and place keys. The server counts each map load and place search on disk, and stops
at 300 and 150 a day, and 9,000 and 4,500 a month, so use stays inside Google's free allowance. At the
limit, the site goes back to OpenFreeMap and its free search. Browsers can see the map key, so limit it
to your domain and set daily quotas in Google Cloud too.

To publish to GitHub Pages, push `web/` to the `gh-pages` branch:

```bash
git push origin "$(git subtree split --prefix web)":refs/heads/gh-pages --force
```
