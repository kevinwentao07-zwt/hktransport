// DeepSeek client and the rule parser used without a key. A port of TripAssistant.swift.
const FEWER = ['唔想轉車', '不想轉車', '唔轉車', '不轉車', '少轉車', '少啲轉車', '直達', 'fewer transfers', 'no transfers', 'no transfer', 'direct'];
const LESS_WALK = ['唔想行', '少行路', '少啲行', '少行', '不想走路', '少走路', 'less walking', 'walk less'];
const FILLER = ['點樣去', '點去', '怎麼去', '怎樣去', '如何去', '嘅路線', '的路線', '搭咩車', '坐咩車', '坐什麼車', '坐甚麼車', '最快', '快啲', '請問', '我想', '我要', 'fastest', 'quickest', 'how do i get there', 'how to get there', 'please'];
const HERE = new Set(['呢度', '這裡', '這裏', '这里', '我的位置', '目前位置', '現在位置', '而家位置', 'here', 'my location', 'current location']);
const WISHES = ['我想吃', '我想食', '我要吃', '我要食', '想吃', '想食', '想喝', '想飲', '我想買', '想買', '我想搵', '想搵', '附近有冇', '附近有什麼', '附近有甚麼', '附近有咩', 'i want to eat', 'i want', 'looking for', 'find me', 'craving'];

const has = (text, words) => words.some((word) => text.toLowerCase().includes(word));
const strip = (text) => text.replace(/^[\s，,。.？?！!～~、]+|[\s，,。.？?！!～~、]+$/g, '');

export const isCurrentLocation = (text) => HERE.has((text ?? '').trim().toLowerCase());
export const normalizedOrigin = (origin) => {
  const value = (origin ?? '').trim();
  return !value || isCurrentLocation(value) ? null : value;
};

export function parseTrip(input) {
  let working = input.trim();
  if (!working) return null;
  let preference = 'fastest';
  if (has(working, FEWER)) preference = 'fewerTransfers';
  else if (has(working, LESS_WALK)) preference = 'lessWalking';
  for (const word of [...FEWER, ...LESS_WALK, ...FILLER]) {
    working = working.replace(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  }
  working = strip(working);
  const intent = (origin, destination) => {
    const end = (destination ?? '').trim();
    return end ? { origin: normalizedOrigin(origin), destination: end, preference } : null;
  };
  const separator = '(?:去|到|往|至|→|->|\\s+to\\s+)';
  let match = working.match(new RegExp(`^(?:由|從|从|from\\s+)\\s*(.+?)\\s*${separator}\\s*(.+)$`, 'i'));
  if (match) return intent(match[1], match[2]);
  match = working.match(/^(?:去|到|往|to\s+)\s*(.+)$/i);
  if (match) return intent(null, match[1]);
  match = working.match(new RegExp(`^(.+?)\\s*${separator}\\s*(.+)$`, 'i'));
  if (match) return intent(match[1], match[2]);
  return intent(null, working);
}

/** Applies a follow-up to the trip on screen: anything not mentioned stays. */
export function parseFollowUp(text, current) {
  if (!current) return parseTrip(text);
  const preference = has(text, FEWER) ? 'fewerTransfers' : has(text, LESS_WALK) ? 'lessWalking' : current.preference;
  const intent = parseTrip(text);
  if (!intent) return has(text, [...FEWER, ...LESS_WALK]) ? { ...current, preference } : null;
  const mentionsHere = [...HERE].some((word) => text.toLowerCase().includes(word));
  return { ...intent, preference, origin: intent.origin ?? (mentionsHere ? null : current.origin) };
}

/** "我想吃螺螄粉" without the AI: the words after the wish are the search. */
export function parseWish(text) {
  const working = text.trim();
  const prefix = WISHES.find((wish) => working.toLowerCase().startsWith(wish));
  if (!prefix) return null;
  const want = strip(working.slice(prefix.length));
  if (!want) return null;
  return { want, searchTerms: [want], area: null, areaOptions: [] };
}

export function searchMessage(origin, destination, preference) {
  return `Search form\nStart: ${origin ?? 'current location'}\nDestination: ${destination}\nPreference: ${preference}`;
}
export function chatMessage(text, current) {
  if (!current) return text;
  return `Current trip\nStart: ${current.origin ?? 'current location'}\nDestination: ${current.destination}\nPreference: ${current.preference}\nRider says: ${text}`;
}

export const INTENT_PROMPT = `You turn Hong Kong public transport trip requests into JSON for a route planner.
Reply with one JSON object and nothing else:
{"origin": string or null, "destination": string, "preference": "fastest" | "fewerTransfers" | "lessWalking"}
Rules:
- origin is null when the rider starts from their current location or does not say where they start.
- A "Search form" message gives the Start and Destination the rider typed: clean up each one, and keep
  the Preference unless the typed text asks for something else.
- A "Current trip" message is what is on screen, and "Rider says" is the follow-up: change only what the
  rider mentions and keep everything else, e.g. "少行路" keeps both places, "改去機場" keeps the start.
- "current location" as a Start means origin is null.
- Expand nicknames and abbreviations into full place names that a map can find in Hong Kong,
  in Traditional Chinese. Examples: 理大 -> 香港理工大學, 中大 -> 香港中文大學, 港大 -> 香港大學,
  機場 -> 香港國際機場一號客運大樓, 尖東 -> 尖沙咀東, 銅鑼灣時代廣場 -> 時代廣場.
- Keep MTR station names as station names, e.g. 旺角, 九龍塘.
- preference is fewerTransfers when the rider wants no or few changes, lessWalking when they want to
  walk less, otherwise fastest.
- Never suggest routes, times or fares.`;

export const CHAT_PROMPT = `${INTENT_PROMPT}

The rider may instead want to find a kind of place, such as food, a shop or something to do, without
naming one place to go to. Then reply with this JSON object instead:
{"kind": "discover", "want": string, "searchTerms": [string], "area": string or null, "areaOptions": [string]}
- want is a short phrase in Traditional Chinese with typos fixed, e.g. 我想吃螺狮粉 -> 螺螄粉.
- searchTerms are up to four map search terms, most specific first: the item itself, then short shop
  types in Chinese and English that would sell it, e.g. ["螺螄粉", "米線", "mixian", "noodles"].
- area is the district or landmark the rider named, "附近" if they said nearby, otherwise null.
- areaOptions are three or four Hong Kong districts where this kind of place is easy to find.
- Going to a named place is still a trip, e.g. 去時代廣場 or 去理大.`;

export const AREA_PROMPT = `A rider in Hong Kong is narrowing down where to look for a place. Reply with one JSON object and nothing else:
{"area": string, "extra": string or null}
- area is one district or landmark a map can find, in Traditional Chinese, without words such as 附近,
  e.g. 朗豪坊附近 -> 朗豪坊. Use "附近" when the rider means near them.
- extra is any other wish in the message, e.g. 要平啲, otherwise null.`;

export const suggestPrompt = (lang) => `You recommend real shops in Hong Kong from your own knowledge.
Reply with one JSON object and nothing else:
{"places": [{"name": string, "nameEn": string, "reason": string}]}
- Name 6 to 8 specific shops in or near the given area, best first. Every name is checked on a map
  afterwards and the ones not found are dropped, so give your best candidates rather than holding back.
- Start with specialists and places people go to for exactly this. Chains are fine.
- If few shops offer exactly this, fill the list with the closest alternatives, such as a 米線 or
  雲南 restaurant for someone who wants 螺螄粉, and say so in the reason.
- name is the shop's Chinese name and nameEn its English name, as on its sign, without the branch.
- Never make a shop up, and never give a generic description in place of a shop's name.
- Each reason is one short sentence on why it fits. No invented ratings, prices or opening hours.
${lang === 'zh' ? 'Write reasons in Traditional Chinese as used in Hong Kong.' : 'Write reasons in English.'}`;

export const explainPrompt = (lang) => `You help a rider in Hong Kong choose between public transport options computed by a route planner.
In one or two short sentences, recommend the best option for the rider's preference and say why.
Use only the facts given. Do not invent routes, stops, times or fares.
When an option's first departure is marked live, you may mention that it is based on real-time arrivals.
${lang === 'zh' ? 'Write in Traditional Chinese as used in Hong Kong.' : 'Write in English.'} No Markdown, no lists.`;

function jsonObject(reply) {
  const start = reply.indexOf('{'), end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(reply.slice(start, end + 1)); } catch { return null; }
}
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const strings = (value) => (Array.isArray(value) ? value.map(clean).filter(Boolean) : []);
const PREFERENCES = ['fastest', 'fewerTransfers', 'lessWalking'];

export function decodeIntent(reply) {
  const object = jsonObject(reply), destination = clean(object?.destination);
  if (!destination) return null;
  return { origin: normalizedOrigin(object.origin), destination, preference: PREFERENCES.includes(object.preference) ? object.preference : 'fastest' };
}

/** A trip request ({trip}), or a request to find somewhere ({wish}). */
export function decodeChat(reply) {
  const object = jsonObject(reply);
  if (object?.kind !== 'discover') {
    const trip = decodeIntent(reply);
    return trip ? { trip } : null;
  }
  const want = clean(object.want);
  if (!want) return null;
  const terms = strings(object.searchTerms);
  return { wish: { want, searchTerms: terms.length ? terms.slice(0, 4) : [want], area: clean(object.area) || null, areaOptions: strings(object.areaOptions) } };
}

export function decodePlaces(reply) {
  const places = jsonObject(reply)?.places;
  if (!Array.isArray(places)) return [];
  return places.flatMap((place) => {
    const name = clean(place?.name) || clean(place?.nameEn);
    return name ? [{ name, nameEn: clean(place.nameEn) || null, reason: clean(place.reason) || null }] : [];
  });
}

export function parseCompletion(json, status) {
  if (status !== 200) throw new Error(`DeepSeek: ${json?.error?.message ?? `HTTP ${status}`}`);
  const choice = json?.choices?.[0], content = clean(choice?.message?.content);
  if (!content) throw new Error(choice?.finish_reason === 'length' ? 'DeepSeek ran out of tokens before answering' : 'DeepSeek returned an empty answer');
  return content;
}

/** Thinking stays off: it made no difference to the answers and took ten times as long. */
export function deepSeek(apiKey, model = 'deepseek-flash') {
  const complete = async (system, user) => {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0.2, max_tokens: 4000, stream: false, thinking: { type: 'disabled' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    return parseCompletion(await response.json().catch(() => null), response.status);
  };
  return {
    async intent(message) {
      const intent = decodeIntent(await complete(INTENT_PROMPT, message));
      if (!intent) throw new Error('DeepSeek reply was not valid trip JSON');
      return intent;
    },
    async chat(message) {
      const reply = decodeChat(await complete(CHAT_PROMPT, message));
      if (!reply) throw new Error('DeepSeek reply was not valid trip JSON');
      return reply;
    },
    async area(text, want) {
      const object = jsonObject(await complete(AREA_PROMPT, `Looking for: ${want}\nRider says: ${text}`));
      if (!clean(object?.area)) throw new Error('DeepSeek reply was not valid area JSON');
      return { area: clean(object.area), extra: clean(object.extra) || null };
    },
    async suggest(want, area, extra, lang) {
      const lines = [`Looking for: ${want}`, `Area: ${area}`];
      if (extra) lines.push(`Also wants: ${extra}`);
      return decodePlaces(await complete(suggestPrompt(lang), lines.join('\n')));
    },
    explain: (summary, lang) => complete(explainPrompt(lang), summary),
  };
}
