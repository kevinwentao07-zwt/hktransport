# hktransport

A Hong Kong public transport web app: trip planning, live arrivals, buses on the map, and an AI assistant that understands a plain sentence. Open the link and use it, with nothing to install and no sign-in.

**Try it: <https://hk.52-220-124-215.sslip.io/>**

[繁體中文](README.md) | English

## Features

### Trip planning

- **Search places or stops**: suggestions list places and shops first (Google Maps), then stops.
- **Routes at once**: the best route is drawn on the map as soon as you search, framed from end to end. Tap another option to switch.
- **Plan a time**: leave now, leave at a time, or arrive by a time. Arrive-by plans show when to leave and say if you can't make it.
- **Three preferences**: fastest, fewer changes, less walking.
- **Live correction**: estimates are replaced with the operators' real arrival times, and the options reordered.
- **Navigation**: follows your position and tells you the next stop, how many are left and where to get off.
- **Compare route sources**: the app searches Transitous, Google Maps when available, and RAPTOR in parallel. It merges duplicate itineraries and ranks the rest by walking, transfers and arrival time.
- **Up to 10 minutes per walk**: longer walks are shown on request when needed. Transitous and Google plans use street walking times. The built-in planner labels estimates where street data is unavailable.
- Covers buses, minibuses, MTR and Light Rail. The built-in planner searches up to three rides.

### Buses on the map

Each bus is placed from the arrival times at **every stop** on its route, then shown along the real road. Several buses stay apart, and a departure that is only on the timetable isn't shown as a real bus.

### Route lookup

- **Quick keypad**: only keys that lead to a real route work, so most routes take three or four presses.
- **One card per route**: both directions and special services sit behind one card.
- **Reverse**: one tap switches direction. The map stays still, the buses change with it, and a chosen stop moves to the one across the road.
- **Swipe a stop** to start or end a trip there.
- Recent routes are kept, with the direction you last looked at.

### Stops and saved stops

Search a stop or place to see every bus, minibus, MTR and Light Rail stop around it, by type and distance, and save the ones you use.

### AI assistant

It **reads sentences** and **keeps the conversation**, then passes the two places and the preference to the planner. Google finds and ranks shop results.

| You say | What happens |
| --- | --- |
| Tsim Sha Tsui to Central, less walking | Plans the trip |
| Ramen in Mong Kok | Finds shops on Google Maps |
| How do I get to the first one? | Plans a trip to that shop |
| What about the second? | Changes to the second shop |
| Start from Tsim Sha Tsui | Changes only the start |

Choose a provider and model, then verify and save your own API key in Settings → AI API. The same configuration enables the chat assistant and AI suggestions for nearby places.

### Also

- Add the website to your home screen (PWA).
- Traditional Chinese, Simplified Chinese and English. Dark mode follows your device.
- Saved stops and history stay on your device.

## How it's built

| Part | Approach |
| --- | --- |
| Web | Static PWA in plain ES modules, with no framework or build step |
| Trip planning | Compares Transitous, Google Routes API and RAPTOR in a Web Worker |
| Places and walks | Google's place search and walking routes, then Government GIS, OpenStreetMap and straight-line estimates after the allowance |
| Arrivals | Straight from the browser to KMB/LWB, Citybus, NLB, green minibuses, MTR and Light Rail |
| Map | Google Maps, moving to OpenFreeMap once the allowance runs out |
| AI | OpenAI, Claude, Gemini, DeepSeek, OpenRouter, and custom OpenAI Chat Completions, OpenAI Responses or Anthropic Messages endpoints through [`server/ai_proxy.py`](server/ai_proxy.py) |
| Server | Python's standard library behind Caddy |

### Security and cost

- Your browser stores your AI API key. The server forwards it to your chosen provider with each request. Server-side Google keys stay on the server.
- The map key has to reach the browser, so it is limited by domain and API.
- The AI endpoint accepts only the app's own tasks and returns only short JSON, so it can't serve as a free chatbot.
- Settings → AI API shows the estimated daily cost of this browser’s usage on this site. Google use stays inside the free allowance, and the site falls back to free services at the limit.

## Development

```bash
python3 -m http.server 8642 --directory web   # Preview locally
node --test web/test/core.test.mjs            # Web tests
cd server && python3 -m unittest test_ai_proxy # Server tests
```

To deploy to your own server, see [`web/README.md`](web/README.md).

## Sources and licence

Route data comes from [hkbus.app](https://hkbus.app/), and arrivals from the operators' open data. The arrival fetchers draw on [HK Bus ETA](https://github.com/hkbus/hk-independent-bus-eta).

Licensed under **GPL-3.0**: see [`LICENSE`](LICENSE). Sources are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
