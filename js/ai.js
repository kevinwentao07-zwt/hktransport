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
  return { want, query: want, searchTerms: [want], area: null, extra: null, question: null, options: [] };
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

const DISCOVER_RULES = `{"kind": "discover", "want": string, "query": string, "searchTerms": [string], "area": string or null, "extra": string or null, "question": string or null, "options": [string]}
- You only pick out what matters here. Never name or recommend a shop from your own knowledge.
- want is a short phrase in Traditional Chinese with typos fixed, e.g. 我想吃螺狮粉 -> 螺螄粉.
- query is what to search for this kind of place: only the useful words from the whole
  conversation, without filler such as 我想 and without the area, e.g. 想飲咖啡要靜啲 -> 安靜 咖啡店,
  食拉麵要平啲 -> 平價 拉麵.
- searchTerms are up to four map search terms, most specific first: the item itself, then short shop
  types in Chinese and English that would sell it, e.g. ["螺螄粉", "米線", "mixian", "noodles"].
- area is one district or landmark the rider named, without words such as 附近, e.g. 朗豪坊附近 -> 朗豪坊.
  Use "附近" if they mean near them, otherwise null. With no area, the search covers the rider's own district.
- extra is any other wish, e.g. 要平啲, otherwise null.
- You decide whether to ask the rider anything. Most requests need no question: if a useful search is
  already possible, set question to null and options to [], and the search runs at once.
- Never ask where to look just because no area was given. 我想吃螺螄粉 needs no question.
- Ask only when the answer would really change what to search for, and ask whatever matters most. It need
  not be about the area. For example, 我想食嘢 could ask what kind of food, and 想買禮物 who it is for.
- question is one short, natural question in Traditional Chinese as used in Hong Kong.
- options are two to four short answers the rider can tap, written as the rider would say them.`;

export const CHAT_PROMPT = `${INTENT_PROMPT}

The rider may instead want to find a kind of place, such as food, a shop or something to do, without
naming one place to go to. Then reply with this JSON object instead:
${DISCOVER_RULES}
- Going to a named place is still a trip, e.g. 去時代廣場 or 去理大.`;

export const REFINE_PROMPT = `A rider in Hong Kong is looking for a kind of place. You asked them something and they answered.
Reply with one JSON object and nothing else, keeping what is already known unless the rider changed it:
${DISCOVER_RULES}
- The message says when you may not ask anything more. Then question must be null.`;

export const pickPrompt = (lang) => `You read web search results about places in Hong Kong and pull out the shops they mention.
Reply with one JSON object and nothing else:
{"places": [{"name": string, "reason": string}]}
- Use only the text given. Every shop must be named in it, and never add one from your own knowledge.
- Pick up to four shops that best match what the rider wants and are in or near the area, best first.
- name is the shop's own name as a map would know it, without the branch. Skip articles' titles, areas and websites.
- reason is one short sentence on why it fits, based only on the text. No invented ratings, prices or hours.
- If the text names no suitable shop, reply {"places": []}.
${lang === 'zh' ? 'Write reasons in Traditional Chinese as used in Hong Kong.' : 'Write reasons in English.'}`;

export const explainPrompt = (lang) => `You help a rider in Hong Kong choose between public transport options computed by a route planner.
In one or two short sentences, recommend the best option for the rider's preference and say why.
Use only the facts given. Do not invent routes, stops, times or fares.
When an option's first departure is marked live, you may mention that it is based on real-time arrivals.
${lang === 'zh' ? 'Write in Traditional Chinese as used in Hong Kong.' : 'Write in English.'} No Markdown, no lists.`;

/** Every job the AI does. The server is sent a name from this list, never a prompt. */
export const PROMPTS = {
  intent: INTENT_PROMPT, chat: CHAT_PROMPT, refine: REFINE_PROMPT,
  pick_zh: pickPrompt('zh'), pick_en: pickPrompt('en'),
  explain_zh: explainPrompt('zh'), explain_en: explainPrompt('en'),
};

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
  const wish = decodeWish(object);
  return wish ? { wish } : null;
}

function decodeWish(object) {
  const want = clean(object?.want);
  if (!want) return null;
  const terms = strings(object.searchTerms), question = clean(object.question) || null;
  return {
    want, query: clean(object.query) || want, searchTerms: terms.length ? terms.slice(0, 4) : [want], area: clean(object.area) || null,
    extra: clean(object.extra) || null, question, options: question ? strings(object.options).slice(0, 4) : [],
  };
}

/** What the AI is told about a search it is narrowing down. */
export function refineMessage(wish, answer, mayAsk) {
  const lines = [`Looking for: ${wish.want}`, `Google query: ${wish.query}`, `Search terms: ${wish.searchTerms.join(', ')}`];
  if (wish.area) lines.push(`Area: ${wish.area}`);
  if (wish.extra) lines.push(`Also wants: ${wish.extra}`);
  lines.push(`You asked: ${wish.question ?? 'Where should I look?'}`, `Rider says: ${answer}`);
  if (!mayAsk) lines.push('You may not ask anything more.');
  return lines.join('\n');
}

export function decodePicks(reply) {
  const places = jsonObject(reply)?.places;
  if (!Array.isArray(places)) return [];
  return places.flatMap((place) => {
    const name = clean(place?.name);
    return name ? [{ name, reason: clean(place.reason) || null }] : [];
  }).slice(0, 4);
}

/** What the AI reads from the web, kept inside one request. */
export function pickMessage(want, area, results) {
  const pages = results.map((page, index) => `[${index + 1}] ${page.title}\n${page.content}`).join('\n\n');
  return `Looking for: ${want}\nArea: ${area}\n\nWeb results:\n${pages}`.slice(0, 3900);
}

export function parseCompletion(json, status) {
  if (status !== 200) throw new Error(`DeepSeek: ${json?.error?.message ?? `HTTP ${status}`}`);
  const choice = json?.choices?.[0], content = clean(choice?.message?.content);
  if (!content) throw new Error(choice?.finish_reason === 'length' ? 'DeepSeek ran out of tokens before answering' : 'DeepSeek returned an empty answer');
  return content;
}

/** Thinking stays off: it made no difference to the answers and took ten times as long. */
export function deepSeek(apiKey, model = 'deepseek-flash') {
  return assistant(async (task, user) => {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0.2, max_tokens: 4000, stream: false, thinking: { type: 'disabled' },
        messages: [{ role: 'system', content: PROMPTS[task] }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    return parseCompletion(await response.json().catch(() => null), response.status);
  });
}

/** The AI this site's server provides, which holds the key. */
export function sharedAI() {
  return assistant(async (task, message) => {
    const response = await fetch('api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, message }),
      signal: AbortSignal.timeout(60_000),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.reply) throw new Error(json?.error ?? `HTTP ${response.status}`);
    return json.reply;
  });
}

function assistant(complete) {
  return {
    async intent(message) {
      const intent = decodeIntent(await complete('intent', message));
      if (!intent) throw new Error('DeepSeek reply was not valid trip JSON');
      return intent;
    },
    async chat(message) {
      const reply = decodeChat(await complete('chat', message));
      if (!reply) throw new Error('DeepSeek reply was not valid trip JSON');
      return reply;
    },
    async refine(wish, answer, mayAsk) {
      const refined = decodeWish(jsonObject(await complete('refine', refineMessage(wish, answer, mayAsk))));
      if (!refined) throw new Error('DeepSeek reply was not valid search JSON');
      return refined;
    },
    pick: async (want, area, results, lang) => decodePicks(await complete(`pick_${lang}`, pickMessage(want, area, results))),
    explain: (summary, lang) => complete(`explain_${lang}`, summary),
  };
}
