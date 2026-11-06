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
/** A rider's message with everything the AI needs to tell a follow-up from a new subject. */
export function chatMessage(text, current, context = {}) {
  const { talk = [], search, question, mayAsk = true } = context, lines = [];
  if (talk.length) lines.push('Conversation so far', ...talk, '');
  if (current) lines.push('Current trip', `Start: ${current.origin ?? 'current location'}`, `Destination: ${current.destination}`, `Preference: ${current.preference}`, '');
  if (search) {
    lines.push('Current search', `Looking for: ${search.want}`, `Query: ${search.query}`);
    if (search.area) lines.push(`Area: ${search.area}`);
    if (search.extra) lines.push(`Also wants: ${search.extra}`);
    if (search.shops?.length) lines.push('Shops on screen:', ...search.shops.map((shop, index) => `${index + 1}. ${shop}`));
    lines.push('');
  }
  if (question) lines.push(`You just asked: ${question}`);
  if (!mayAsk) lines.push('You may not ask anything more, so question must be null.');
  return lines.length ? [...lines, `Rider says: ${text}`].join('\n') : text;
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
- Going to a named place is still a trip, e.g. 去時代廣場 or 去理大.

The message may give the conversation, the current trip, the current search and the shops on screen.
First decide whether "Rider says" continues them or starts something new:
- It continues unless it is clearly a new subject. Short messages almost always continue, e.g. 平啲嘅,
  近啲, 要有得坐, 換銅鑼灣, 唔要太辣, 少行路.
- If you just asked something, the message is the answer, unless it plainly changes the subject.
- Continuing a search: reply with discover. Keep want, query, area and extra, change only what the rider
  mentioned, and put any new wish into query, e.g. 拉麵 in 旺角 + 平啲嘅 -> query 平價 拉麵, area 旺角.
- Continuing a trip: reply with the trip, changing only what the rider mentioned.
- Asking how to get to a shop on screen, e.g. 第一間點去, 去第二間, 呢間點去: reply with a trip whose
  destination is that shop's exact name from the list, and origin null.
- A new subject, e.g. 去機場 while looking at ramen shops, or 我想買手機: ignore the conversation, the
  search and the trip completely.`;

export const rankPrompt = (lang) => `You put shops in Hong Kong in order for a rider, best first, and say why.
Reply with one JSON object and nothing else:
{"ranking": [{"number": number, "reason": string}]}
- Include every shop, using its number from the list.
- Weigh how well it fits what the rider wants first, then the rating and how many people gave it,
  then whether it is open now and how near it is. A high rating from very few people counts for less.
- reason is one or two short sentences saying why this shop is ranked here, using only the facts
  given. Never invent ratings, prices, hours or dishes. If a fact is missing, don't mention it.
- Speak to the person directly as 你, or not at all. Never call them 車手, 乘客 or a rider.
${lang === 'zh' ? 'Write reasons in Traditional Chinese as used in Hong Kong.' : 'Write reasons in English.'}`;

export const explainPrompt = (lang) => `You help a rider in Hong Kong choose between public transport options computed by a route planner.
In one or two short sentences, recommend the best option for the rider's preference and say why.
Use only the facts given. Do not invent routes, stops, times or fares.
When an option's first departure is marked live, you may mention that it is based on real-time arrivals.
${lang === 'zh' ? 'Write in Traditional Chinese as used in Hong Kong.' : 'Write in English.'} No Markdown, no lists.`;

/** Every job the AI does. The server is sent a name from this list, never a prompt. */
export const PROMPTS = {
  intent: INTENT_PROMPT, chat: CHAT_PROMPT,
  rank_zh: rankPrompt('zh'), rank_en: rankPrompt('en'),
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

/** What Google knows about each shop, for the AI to rank. */
export function rankMessage(wish, suggestions) {
  const shops = suggestions.map(({ place }, index) => {
    const facts = [place.kind, place.rating && `rating ${place.rating} from ${place.ratings ?? 0} people`, place.price,
      place.open === true && 'open now', place.open === false && 'closed now', Number.isFinite(place.meters) && `${Math.round(place.meters)} m away`];
    return `${index + 1}. ${place.name}: ${facts.filter(Boolean).join('; ')}`;
  });
  return [`Rider wants: ${wish.want}`, wish.extra && `Also wants: ${wish.extra}`, 'Shops:', ...shops].filter(Boolean).join('\n').slice(0, 3900);
}

/** The AI's order. A number it skips or repeats can't lose or double a shop. */
export function applyRanking(reply, suggestions) {
  const ranking = jsonObject(reply)?.ranking, used = new Set(), ranked = [];
  for (const item of Array.isArray(ranking) ? ranking : []) {
    const index = Number(item?.number) - 1;
    if (!suggestions[index] || used.has(index)) continue;
    used.add(index);
    ranked.push({ ...suggestions[index], reason: clean(item.reason) || suggestions[index].reason });
  }
  return [...ranked, ...suggestions.filter((_, index) => !used.has(index))];
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
    rank: async (wish, suggestions, lang) => applyRanking(await complete(`rank_${lang}`, rankMessage(wish, suggestions)), suggestions),
    explain: (summary, lang) => complete(`explain_${lang}`, summary),
  };
}
