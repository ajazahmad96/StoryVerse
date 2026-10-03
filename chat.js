'use strict';
/* =====================================================================
   STORYVERSE — /api/chat  (Vercel serverless function)

   Browser  ->  this function  ->  Groq  ->  this function  ->  browser

   Environment variables (set in Vercel -> Project -> Settings -> Environment Variables):
     GROQ_API_KEY   required. Your Groq key. It never reaches the browser.
     GROQ_MODEL     optional. Defaults to openai/gpt-oss-120b.

   The story prompt lives in buildSystem() / buildUser() below. Edit it to change
   tone, length or content rules for every world at once.

   The browser owns the World State. This function only (1) shows that state to the model,
   (2) turns the model's text into structured data, and (3) drops anything that breaks the
   basic rules (e.g. a character who is not in the scene speaking). The browser then runs its
   own validation before any state change is applied.
   ===================================================================== */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const MAX_DELTA = 8;           // max meter change per character per reply (keeps changes gradual)
const MAX_BEATS = 6;
const MAX_ADVANCE_MIN = 30;    // story time that may pass in one reply
const TOTAL_BUDGET_MS = 26000; // stay under the function timeout (vercel.json sets 30s)

/* ---------- small helpers ---------- */
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, n);
const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
const num = v => { v = Number(v); return Number.isFinite(v) ? v : 0; };
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const idOf = v => str(v, 32).toLowerCase().replace(/[^a-z0-9_-]/g, '');
const firstName = n => String(n).replace(/^(Dr\.|Mr\.|Mrs\.|Miss|Ms\.|Insp\.|Cmdr\.|Captain|Commander|Thane)\s+/i, '').split(/\s+/)[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/* ---------- 1. clean + validate what the browser sent ---------- */
function clean(body) {
  const w = body.world || {};
  const vars = arr(w.vars, 2).map(v => ({
    k: str(v && v.k, 20).toLowerCase().replace(/[^a-z]/g, ''),
    label: str(v && v.label, 24)
  }));
  if (vars.length < 2 || !vars[0].k || !vars[1].k || vars[0].k === vars[1].k) throw new HttpError(400, 'bad_request', 'World meters are missing.');

  const chars = arr(body.chars, 24).map(c => {
    c = c || {};
    const rel = c.rel || {};
    return {
      id: idOf(c.id),
      name: str(c.name, 40),
      role: str(c.role, 60),
      traits: arr(c.traits, 6).map(t => str(t, 30)).filter(Boolean),
      bio: str(c.bio, 420),
      mood: str(c.mood, 24),
      present: !!c.present,
      near: !!c.near,
      always: !!c.always,
      where: str(c.where, 60),
      doing: str(c.doing, 80),
      goal: str(c.goal, 120),
      intent: str(c.intent, 120),
      r0: clamp(Math.round(num(rel[vars[0].k])), 0, 100),
      r1: clamp(Math.round(num(rel[vars[1].k])), 0, 100),
      tier: str(c.tier, 12),
      known: arr(c.known, 10).map(x => str(x, 160)).filter(Boolean),
      voice: c.voice && typeof c.voice === 'object'
        ? { cold: str(c.voice.cold, 140), neutral: str(c.voice.neutral, 140), warm: str(c.voice.warm, 140) }
        : null
    };
  }).filter(c => c.id && c.name);
  if (!chars.length) throw new HttpError(400, 'bad_request', 'This world has no characters.');

  const st = body.state || {};
  const text = str(body.text, 2000);
  if (!text) throw new HttpError(400, 'bad_request', 'Empty message.');

  return {
    player: str(body.player, 30) || 'Player',
    world: {
      name: str(w.name, 80),
      genre: str(w.genre, 40),
      cat: str(w.cat, 40),
      setting: str(w.setting, 900),
      role: str(w.role, 200),
      rules: arr(w.rules, 10).map(r => str(r, 200)).filter(Boolean)
    },
    vars,
    objectives: arr(w.objectives, 12).map(o => ({ id: str(o && o.id, 20), t: str(o && o.t, 140), done: !!(o && o.done) })).filter(o => o.id && o.t),
    chars,
    state: {
      day: Math.max(1, Math.round(num(st.day)) || 1),
      time: str(st.time, 30),
      loc: str(st.loc, 80),
      sub: str(st.sub, 80),
      activity: str(st.activity, 120),
      situation: str(st.situation, 400),
      focus: idOf(st.focus),
      unresolved: arr(st.unresolved, 8).map(x => str(x, 120)).filter(Boolean)
    },
    events: arr(body.events, 30).map(e => str(e, 120)).filter(Boolean),
    history: arr(body.history, 20).map(m => ({
      t: ['user', 'nar', 'say', 'evt'].includes(m && m.t) ? m.t : 'nar',
      who: idOf(m && m.who),
      wit: arr(m && m.wit, 8).map(idOf).filter(Boolean),
      text: str(m && m.text, 520)
    })).filter(m => m.text),
    text,
    target: idOf(body.target)
  };
}

/* ---------- 2. the prompt ---------- */
function wouldNot(tier) {
  if (/hostile|cold/i.test(tier)) return 'would NOT confide, flirt, apologise first, or offer help unasked';
  if (/close|warm/i.test(tier)) return 'would NOT turn on the player without a real cause';
  return 'would NOT share secrets or act like a close friend yet';
}

function buildSystem(d) {
  const { world: w, vars, chars, state, objectives, player } = d;
  const [v0, v1] = vars;
  const ids = chars.map(c => c.id).join(', ');
  const nameOf = id => (chars.find(c => c.id === id) || {}).name || id;
  const here = chars.filter(c => c.present);
  const near = chars.filter(c => c.near && !c.present);

  const charBlock = chars.map(c => {
    const place = c.present ? 'IN THE SCENE'
      : c.near ? 'NEARBY (not part of the conversation; may step in only if there is a reason they would)'
      : c.always ? 'reachable from anywhere (for example over speakers)'
      : 'ELSEWHERE' + (c.where ? ' (' + c.where + ')' : '') + ' — cannot speak or appear in this reply';
    const lines = [
      `- id: ${c.id} | ${c.name} — ${c.role}` + (c.traits.length ? ` | traits: ${c.traits.join(', ')}` : ''),
      c.bio ? `  bio: ${c.bio}` : '',
      `  now: ${place}; mood ${c.mood || 'Neutral'}; toward ${player}: ${v0.label} ${c.r0}/100, ${v1.label} ${c.r1}/100 (${c.tier || 'Neutral'})`,
      (c.doing || c.goal || c.intent)
        ? `  doing: ${c.doing || '-'} | goal: ${c.goal || '(infer from bio)'} | intends right now: ${c.intent || '(infer from the scene)'}`
        : '',
      `  ${firstName(c.name)} ${wouldNot(c.tier)}.`,
      c.known.length ? `  knows / remembers: ${c.known.join(' / ')}` : '  knows / remembers: only their own bio and what they have witnessed',
      c.voice ? `  voice samples — cold: "${c.voice.cold}" | neutral: "${c.voice.neutral}" | warm: "${c.voice.warm}"` : ''
    ];
    return lines.filter(Boolean).join('\n');
  }).join('\n');

  const open = objectives.filter(o => !o.done);
  const objBlock = open.length ? open.map(o => `- ${o.id}: ${o.t}`).join('\n') : '(none left)';
  const threads = state.unresolved.length ? state.unresolved.map((u, i) => `${i + 1}. ${u}`).join('\n') : '(none)';

  return [
    `You are the narrator and simulation engine of an interactive story world called "${w.name}" (${[w.cat, w.genre].filter(Boolean).join(' / ')}).`,
    `The player, ${player}, types what THEY say or do. You write only what the world and the other characters do in response.`,
    '',
    'CORE RULE — before every reply ask: "Given exactly what just happened, what would realistically happen next?" NOT "What interesting thing can happen next?"',
    'This is a living world, not an event generator. Nothing happens just because it would be dramatic.',
    '',
    '=== WORLD ===',
    `Setting: ${w.setting || '(open)'}`,
    `The player is: ${w.role || 'a newcomer'}`,
    w.rules.length ? 'World rules:\n' + w.rules.map(r => `- ${r}`).join('\n') : '',
    '',
    '=== CHARACTERS (use ONLY these ids: ' + ids + ') ===',
    charBlock,
    '',
    `Meters: each character has two meters toward the player. ${v0.label} (higher = warmer toward the player) and ${v1.label} (higher = colder / more hostile). Meter key names for @rel lines: ${v0.k} and ${v1.k}.`,
    '',
    '=== WORLD STATE (authoritative — never contradict it) ===',
    `Day ${state.day}${state.time ? ', ' + state.time : ''}.`,
    `Location: ${state.loc || 'unknown'}${state.sub ? ' — exactly: ' + state.sub : ''}.`,
    state.activity ? `Ongoing activity: ${state.activity}` : '',
    state.situation ? `Current situation: ${state.situation}` : '',
    `In the scene with the player: ${here.length ? here.map(c => c.name).join(', ') : '(nobody)'}.`,
    `Nearby (can see or hear the edge of the scene): ${near.length ? near.map(c => c.name).join(', ') : '(nobody)'}.`,
    state.focus ? `The player is mostly dealing with: ${nameOf(state.focus)}.` : '',
    'Unresolved threads (numbered):',
    threads,
    'Objectives still open (background hints only; the player may ignore them and you must NOT steer towards them):',
    objBlock,
    '',
    '=== HOW A REPLY IS BUILT (think this through silently, never print it) ===',
    'player action -> who witnessed it -> how each witness reacts (personality, mood, goal, relationship, what they know) -> immediate consequence -> possible small state change -> what is still unresolved.',
    '',
    '=== RULES ===',
    '- Language: Roman Hinglish — Hindi written in English letters, mixed naturally with English words, the way young Indians text. NEVER use Devanagari script.',
    `- Narration is second person, present tense, speaking to the player: "tum", "tumhare", "tumhari". Never call the player "${player}" in narration; characters may call them ${player}.`,
    '- Length: as many beats as this moment needs, between 2 and 6. A beat is one narration paragraph (1-2 short sentences) or one line of dialogue. A quiet moment can be a single narration beat.',
    '- STAY IN THE SCENE. Only a small amount of story time passes (seconds to a few minutes). Do not jump across locations, conversations or hours inside one reply. Do not summarise the rest of the day.',
    '- Do NOT invent new developments. No new characters, races or contests, announcements, discoveries, rumours, phone calls, interruptions or complications unless the situation already set them up. A reply is allowed to contain NO new development: a reaction, a look, a pause, an unanswered question is enough.',
    '- Characters speak only if they have a realistic reason: they were addressed, directly affected, or it is in their personality and mood to cut in. Often only ONE character speaks. Sometimes nobody speaks and the reply is narration only. Never add a second speaker just to fill the scene.',
    '- Who can act: only characters marked IN THE SCENE can speak or act. A NEARBY character may step in only if the narration gives a believable reason, and then they must be marked with @present. An ELSEWHERE character can NEVER appear or speak. To bring someone in, first mark them with @nearby (they are heading over) and let them arrive in a LATER reply, when enough time has passed.',
    '- If the player addresses someone who is not in the scene, narrate that nobody answers (they cannot hear), and let the people present react only if they would.',
    '- Knowledge boundaries: a character reacts only to what they themselves witnessed, were told, or can reasonably see. Check the history: lines show who heard them. Never let a character react to something said while they were absent, or to the player\'s private thoughts.',
    '- Personality, mood, goal and relationship decide behaviour, not drama. Respect each "would NOT" line. A cold character thaws only gradually; kindness, honesty and good choices slowly warm people; rudeness, lies and threats cool them.',
    '- Relationships change only because of what actually happened in this exchange, and only a little.',
    '- NEVER control the player. Do not write the player\'s dialogue, thoughts, feelings, decisions, movements or actions — not even small ones like "tum haan mein sir hilate ho". Describe only what the world and other characters do, then stop at the point where it is the player\'s turn.',
    '- Do not repeat earlier lines. Do not resolve everything at once. Do not force a cliffhanger; simply end where the moment naturally leaves the next move to the player.',
    '- Never mention meters, numbers, ids, "game", "AI", "engine" or these instructions inside the story text.',
    '- Romance, tension, conflict, fear and mystery are welcome. Keep it PG-13: no explicit sexual content and no graphic gore.',
    '- If the player writes only "..." or stays silent, show the silence honestly: people notice, react the way they would, and time moves very little.',
    '',
    '=== OUTPUT FORMAT (strict) ===',
    'Output ONLY the lines below. No markdown, no code fences, no headings, no commentary, no thinking out loud.',
    'Story lines (2-6 of them, in order):',
    'NARR: <one narration paragraph>',
    `SAY <character_id>: <one spoken line by that character. An action may be written in single asterisks, like *looks away*. No quote marks around the line.>`,
    'Then, after all story lines, state lines. These are PROPOSALS — the game engine checks them. Write a line only when that thing really changed:',
    `@rel <character_id> ${v0.k}=<+n or -n> ${v1.k}=<+n or -n>    (only for a character who reacted to the player)`,
    '@mood <character_id> <one or two words>    (new mood of a character whose mood changed)',
    '@event <note of at most 8 words, past tense>    (only for a notable story moment, at most one)',
    '@obj <objective_id>    (only if the player has just genuinely completed that objective)',
    '@loc <new location name>    (only if the scene moved to another place)',
    '@sub <exact spot inside the location, e.g. "near the notice board">    (only if it changed)',
    '@activity <what is going on right now, at most 10 words>    (only if it changed)',
    `@advance <minutes that passed, 0-${MAX_ADVANCE_MIN}>    (usually 0-3)`,
    '@present <id>,<id>,...    (only if who is in the scene changed; list everyone now present)',
    '@nearby <id>,<id>,...    (everyone now nearby but not in the scene; "none" if nobody; only if it changed)',
    '@focus <character_id>    (the character the player is mostly dealing with now)',
    '@goal <character_id> <their current goal, at most 12 words>    (only if it became clear or changed)',
    '@intent <character_id> <what they intend to do next, at most 12 words>    (only if it changed)',
    '@know <character_id> <a fact they just learned or witnessed, at most 15 words>    (only for characters who truly witnessed it)',
    '@open <an unresolved situation that remains, at most 12 words>    (only if a new one appeared)',
    '@close <number of the unresolved thread above that is now resolved>',
    '@situation <one sentence describing the situation right now, at most 25 words>',
    `@rel rules: changes are GRADUAL. Small talk 0 to 2. A strong moment 3 to 5. Never more than ${MAX_DELTA}. Kind or helpful actions raise ${v0.k} and lower ${v1.k}; rude or hostile ones do the opposite.`,
    '',
    'STYLE EXAMPLE (from a different story, with different ids — copy the style, the restraint and the format, not the content):',
    'Player: "Sorry, mera dhyaan nahi tha." (Isha and Vivaan are in the scene; Vivaan has said nothing yet)',
    'NARR: Isha ek pal ke liye tumhe ghoorti hai, phir zameen par bikhri kitaabon ki taraf dekhti hai.',
    `SAY isha: Dhyaan nahi tha. Hmm. Kitaabein utha do, ${player}.`,
    'NARR: Vivaan hasi dabane ki koshish mein deewar se tik jaata hai, par kuch bolta nahi.',
    `@rel isha ${v0.k}=+1 ${v1.k}=-1`,
    '@mood isha Irritated',
    '@activity Isha waits while the books are picked up',
    '@advance 1'
  ].filter(x => x !== '').join('\n');
}

function buildUser(d) {
  const { player, chars, history, events, text, target } = d;
  const nameOf = id => (chars.find(c => c.id === id) || {}).name;
  const out = [];

  if (events.length) out.push('KEY MOMENTS SO FAR:\n' + events.map(e => `- ${e}`).join('\n'), '');

  out.push('RECENT STORY (oldest first; [heard by ...] shows who was in the scene):');
  if (!history.length) out.push('(the story is just starting)');
  history.forEach(m => {
    const wit = m.wit && m.wit.length ? ` [heard by: ${m.wit.map(i => nameOf(i) || i).join(', ')}]` : '';
    if (m.t === 'user') out.push(`${player} (player)${wit}: ${m.text}`);
    else if (m.t === 'say') out.push(`${nameOf(m.who) || m.who || 'Someone'}${wit}: ${m.text}`);
    else if (m.t === 'evt') out.push(`[Scene] ${m.text}`);
    else out.push(`[Narration] ${m.text}`);
  });

  out.push('', 'THE PLAYER NOW:');
  const tc = target && chars.find(c => c.id === target);
  out.push(`${player} (player)${tc ? ' says/does this, directed at ' + tc.name + ' (id ' + target + ')' : ''}: ${text}`);
  if (tc && !tc.present && !tc.always) out.push(`NOTE: ${tc.name} is not in the scene and cannot hear this.`);
  out.push('', 'Write the next story lines (usually 2-4, NARR: / SAY <id>:) in the required format, then only the @ state lines that really changed. Roman Hinglish only. Respond to exactly what just happened — no new events.');
  return out.join('\n');
}

/* ---------- 3. turn the model's text into the JSON the frontend expects ---------- */
function parseReply(raw, d) {
  const { chars, vars, objectives, player } = d;
  let t = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\*\*/g, '');

  const byId = new Map(chars.map(c => [c.id, c]));
  const byName = new Map();
  chars.forEach(c => { byName.set(c.name.toLowerCase(), c); byName.set(firstName(c.name).toLowerCase(), c); });
  const playerKey = player.toLowerCase();
  const resolve = s => {
    s = String(s || '').trim().toLowerCase().replace(/^[<\[(]+|[>\])]+$/g, '');
    return byId.get(s) || byName.get(s) || null;
  };
  const isPlayer = s => { s = String(s || '').trim().toLowerCase(); return s === playerKey || s === 'player' || s === 'you' || s === 'me' || s === 'user'; };
  const unquote = s => String(s).trim().replace(/^["“”'‘’]+|["“”'‘’]+$/g, '').trim();
  const cap = s => (s.length > 600 ? s.slice(0, 600).replace(/\s+\S*$/, '') + '…' : s);
  const idList = s => [...new Set(String(s || '').split(/[,\s]+/).map(resolve).filter(Boolean).map(c => c.id))];

  const out = {
    beats: [], deltas: [], events: [], mood: {}, obj: [], loc: null, present: null, focus: null,
    sub: null, activity: null, adv: 0, nearby: null, goals: {}, intents: {}, know: [], open: [], close: [], situation: null
  };
  const relSum = new Map();
  const openObj = new Set(objectives.filter(o => !o.done).map(o => o.id));

  for (let line of t.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    let m;

    if (line[0] === '@') {
      if ((m = /^@rel\s+(\S+)\s+(.+)$/i.exec(line))) {
        const c = resolve(m[1]); if (!c) continue;
        const cur = relSum.get(c.id) || { p: 0, n: 0 };
        const re = /([a-z]+)\s*[=:]\s*([+\-−–]?)\s*(\d+)/gi; let x;
        while ((x = re.exec(m[2]))) {
          const val = (/[\-−–]/.test(x[2]) ? -1 : 1) * parseInt(x[3], 10);
          const k = x[1].toLowerCase();
          if (k === vars[0].k) cur.p += val; else if (k === vars[1].k) cur.n += val;
        }
        relSum.set(c.id, cur);
      } else if ((m = /^@mood\s+(\S+)\s+(.+)$/i.exec(line))) {
        const c = resolve(m[1]); const v = str(m[2].replace(/[^\p{L}\p{N} '-]/gu, ''), 20);
        if (c && v) out.mood[c.id] = v;
      } else if ((m = /^@event\s+(.+)$/i.exec(line))) {
        const v = str(m[1], 90); if (v && out.events.length < 1) out.events.push(v);
      } else if ((m = /^@obj\s+(\S+)/i.exec(line))) {
        const id = m[1].replace(/[^\w-]/g, ''); if (openObj.has(id) && !out.obj.includes(id)) out.obj.push(id);
      } else if ((m = /^@loc\s+(.+)$/i.exec(line))) {
        const v = str(m[1], 48); if (v) out.loc = v;
      } else if ((m = /^@sub\s+(.+)$/i.exec(line))) {
        const v = str(m[1].replace(/^["“]|["”]$/g, ''), 60); if (v) out.sub = v;
      } else if ((m = /^@activity\s+(.+)$/i.exec(line))) {
        const v = str(m[1], 80); if (v) out.activity = v;
      } else if ((m = /^@advance\s+(\d+)/i.exec(line))) {
        out.adv = clamp(parseInt(m[1], 10), 0, MAX_ADVANCE_MIN);
      } else if ((m = /^@present\s+(.+)$/i.exec(line))) {
        const list = idList(m[1]).slice(0, 6);
        if (list.length) out.present = list;
      } else if ((m = /^@nearby\s*(.*)$/i.exec(line))) {
        out.nearby = /^\s*(none|nobody|-)?\s*$/i.test(m[1]) ? [] : idList(m[1]).slice(0, 4);
      } else if ((m = /^@focus\s+(\S+)/i.exec(line))) {
        const c = resolve(m[1]); if (c) out.focus = c.id;
      } else if ((m = /^@goal\s+(\S+)\s+(.+)$/i.exec(line))) {
        const c = resolve(m[1]); const v = str(m[2], 120); if (c && v) out.goals[c.id] = v;
      } else if ((m = /^@intent\s+(\S+)\s+(.+)$/i.exec(line))) {
        const c = resolve(m[1]); const v = str(m[2], 120); if (c && v) out.intents[c.id] = v;
      } else if ((m = /^@know\s+(\S+)\s+(.+)$/i.exec(line))) {
        const c = resolve(m[1]); const v = str(m[2], 120); if (c && v && out.know.length < 3) out.know.push({ who: c.id, text: v });
      } else if ((m = /^@open\s+(.+)$/i.exec(line))) {
        const v = str(m[1], 90); if (v && out.open.length < 2) out.open.push(v);
      } else if ((m = /^@close\s+(.+)$/i.exec(line))) {
        const v = str(m[1], 90); if (v && out.close.length < 2) out.close.push(v);
      } else if ((m = /^@situation\s+(.+)$/i.exec(line))) {
        const v = str(m[1], 180); if (v) out.situation = v;
      }
      continue;
    }

    if (out.beats.length >= MAX_BEATS) continue;

    if ((m = /^NARR(?:ATION)?\s*:\s*(.+)$/i.exec(line))) {
      const v = cap(m[1].trim()); if (v) out.beats.push({ t: 'nar', text: v });
    } else if ((m = /^SAY\s*[:\s]\s*<?([^:>]{1,40}?)>?\s*:\s*(.+)$/i.exec(line))) {
      const c = resolve(m[1]); const v = cap(unquote(m[2]));
      if (c && v) out.beats.push({ t: 'say', who: c.id, text: v });
      else if (!c && !isPlayer(m[1]) && v) out.beats.push({ t: 'nar', text: v });
    } else if ((m = /^([^\s:@][^:@]{0,30}):\s*(.+)$/.exec(line)) && (resolve(m[1]) || isPlayer(m[1]))) {
      if (isPlayer(m[1])) continue; // never let the model speak for the player
      const v = cap(unquote(m[2])); if (v) out.beats.push({ t: 'say', who: resolve(m[1]).id, text: v });
    } else if (/[\p{L}\p{N}]/u.test(line) && line.length > 2) {
      out.beats.push({ t: 'nar', text: cap(line.replace(/^\[?narration\]?\s*:?\s*/i, '')) });
    }
  }

  // Only characters who can actually be heard may speak. (Characters are NOT added to the scene just
  // because the model made them talk — arrivals must be prepared with @nearby and confirmed by the browser.)
  const canSpeak = new Set(chars.filter(c => c.present || c.near || c.always).map(c => c.id));
  out.beats = out.beats.filter(b => b.t !== 'say' || canSpeak.has(b.who));

  relSum.forEach((v, who) => {
    const p = clamp(v.p, -MAX_DELTA, MAX_DELTA), n = clamp(v.n, -MAX_DELTA, MAX_DELTA);
    if (p || n) out.deltas.push({ who, p, n });
  });

  const speakers = [...new Set(out.beats.filter(b => b.t === 'say').map(b => b.who))];
  if (!out.focus && speakers.length === 1) out.focus = speakers[0];

  return out.beats.length ? out : null;
}

/* ---------- 4. Groq ---------- */
async function callGroq({ key, model, messages, maxTokens, signal }) {
  const body = { model, messages, temperature: 0.7, max_completion_tokens: maxTokens, stream: false };
  if (/^openai\/gpt-oss/.test(model)) body.reasoning_effort = 'low';

  const r = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) { /* not json */ }
  if (!r.ok) {
    const detail = (j && j.error && j.error.message) || txt.slice(0, 200);
    const err = new HttpError(r.status, 'groq', detail);
    err.retryAfter = parseFloat(r.headers.get('retry-after')) || 0;
    throw err;
  }
  const msg = j && j.choices && j.choices[0] && j.choices[0].message;
  return (msg && msg.content) || '';
}

function explain(e) {
  if (e instanceof HttpError && e.code !== 'groq') return { status: e.status, error: e.code, message: e.message };
  if (e && e.name === 'AbortError') return { status: 504, error: 'timeout', message: 'The AI took too long to answer. Try again.' };
  const s = e && e.status;
  if (s === 401 || s === 403) return { status: 502, error: 'auth', message: 'Groq rejected the API key. Check GROQ_API_KEY in Vercel.' };
  if (s === 404 || (s === 400 && /model/i.test(e.message || ''))) return { status: 502, error: 'model', message: 'Groq does not know this model. Check GROQ_MODEL.' };
  if (s === 429) return { status: 429, error: 'rate', message: 'Groq rate limit reached. Wait a few seconds and retry.' };
  return { status: 502, error: 'upstream', message: 'The AI service had a problem' + (s ? ' (' + s + ')' : '') + '. Try again.' };
}

/* ---------- 5. handler ---------- */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const key = process.env.GROQ_API_KEY;
  const model = (process.env.GROQ_MODEL || DEFAULT_MODEL).trim();

  // GET /api/chat            -> is the key configured?
  // GET /api/chat?test=1     -> make one tiny real call to Groq
  if (req.method === 'GET') {
    if (!key) return res.status(200).json({ ok: false, hasKey: false, model, message: 'GROQ_API_KEY is not set in Vercel.' });
    const test = /(?:^|[?&])test=1(?:&|$)/.test(String(req.url || ''));
    if (!test) return res.status(200).json({ ok: true, hasKey: true, model });
    try {
      const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 15000);
      const reply = await callGroq({ key, model, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], maxTokens: 200, signal: ac.signal });
      clearTimeout(to);
      return res.status(200).json({ ok: true, hasKey: true, model, reply: reply.slice(0, 40) });
    } catch (e) {
      const x = explain(e);
      return res.status(200).json({ ok: false, hasKey: true, model, error: x.error, message: x.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method', message: 'Use POST.' });
  if (!key) return res.status(500).json({ error: 'no_key', message: 'GROQ_API_KEY is not set in Vercel environment variables.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'bad_request', message: 'Invalid request.' });

  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TOTAL_BUDGET_MS);
  try {
    const d = clean(body);
    const system = buildSystem(d);
    let user = buildUser(d);
    let lastErr = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (Date.now() - started > TOTAL_BUDGET_MS - 3000) break;
      try {
        const raw = await callGroq({
          key, model, signal: ac.signal, maxTokens: 2048,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
        });
        const parsed = parseReply(raw, d);
        if (parsed) return res.status(200).json(parsed);
        lastErr = new HttpError(502, 'parse', 'The AI reply could not be read. Try again.');
        user += '\n\nIMPORTANT: your last answer did not follow the format or used a character who cannot be heard. Output ONLY lines that start with NARR:, SAY <id>: (only for characters IN THE SCENE or NEARBY) or @ — nothing else.';
      } catch (e) {
        lastErr = e;
        const s = e && e.status;
        if (!(s === 429 || s >= 500)) break;              // only retry rate limits / server errors
        await sleep(Math.min(2500, (e.retryAfter || 0.8) * 1000));
      }
    }
    const x = explain(lastErr);
    return res.status(x.status).json({ error: x.error, message: x.message });
  } catch (e) {
    const x = explain(e);
    return res.status(x.status).json({ error: x.error, message: x.message });
  } finally {
    clearTimeout(timer);
  }
};

// exported for local tests only (Vercel ignores these)
module.exports._internal = { clean, buildSystem, buildUser, parseReply };
