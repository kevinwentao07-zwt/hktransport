# hktransport web

The phone version: a static page with no server, published at
<https://kevinwentao07-zwt.github.io/hktransport/>.

Every data source allows direct browser calls, so nothing needs proxying:
route data from hkbus.app, arrivals from the operators, maps and place search
from the Government, shops from OpenStreetMap's Photon, and AI from DeepSeek
with the rider's own key.

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
(ignored by git) and run `Deploy web.command`.

To publish to GitHub Pages, push `web/` to the `gh-pages` branch:

```bash
git push origin "$(git subtree split --prefix web)":refs/heads/gh-pages --force
```
