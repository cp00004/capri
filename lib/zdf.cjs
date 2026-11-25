/**
 * STORIES // cinematic explainer shorts in the Zack D. Films mold: one calm
 * hook, a hyper-real miniature scene per beat, and a payoff a few seconds in.
 * The LLM writes the beat sheet; the renderer draws every frame locally.
 */
const { askJson } = require("./toon.cjs");

const TYPES = { whatif: "What If", how: "How It Works", truestory: "True Story" };
const ENVS = [
  "city", "room", "street", "ocean", "desert", "space", "body", "machine",
  "jungle", "ice", "volcano", "lab", "sky", "crowd", "tunnel", "harbor",
  "arena", "server",
];
const SYMBOLS = [
  "person", "sphere", "cube", "ring", "wave", "flame", "bolt", "phone", "drop",
  "tree", "building", "money", "clock", "rocket", "skull", "heart",
];

function hash(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(text).length; i += 1) {
    h ^= String(text).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick(list, seed, salt) {
  return list[hash(`${seed}|${salt}`) % list.length];
}

function clean(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function sceneSet(topic, type, seed) {
  const lower = topic.toLowerCase();
  const env = /(space|moon|planet|asteroid)/.test(lower) ? "space"
    : /(ocean|sea|ship|shark|tsunami|wave|underwater)/.test(lower) ? "ocean"
      : /(desert|sand|cactus|dune)/.test(lower) ? "desert"
        : /(ice|snow|glacier|arctic|antarctic)/.test(lower) ? "ice"
          : /(volcano|lava|eruption)/.test(lower) ? "volcano"
            : /(body|brain|heart|blood|virus|cell|stomach)/.test(lower) ? "body"
              : /(money|bank|economy|dollar|inflation)/.test(lower) ? "city"
                : /(phone|internet|ai|computer|wifi|data)/.test(lower) ? "machine"
                  : /(jungle|forest|animal|snake|spider)/.test(lower) ? "jungle"
                    : /(plane|sky|fall|gravity|cloud)/.test(lower) ? "sky"
                      : /(street|road|city|traffic|building)/.test(lower) ? "city" : "room";
  const symbol = /(money|dollar|rich|bank)/.test(lower) ? "money"
    : /(phone|internet|screen)/.test(lower) ? "phone"
      : /(water|ocean|flood|tsunami|rain)/.test(lower) ? "wave"
        : /(fire|volcano|lava|heat)/.test(lower) ? "flame"
          : /(electric|lightning|power|energy)/.test(lower) ? "bolt"
            : /(brain|heart|virus|body|blood|cell)/.test(lower) ? "sphere"
              : /(space|moon|planet|asteroid)/.test(lower) ? "sphere"
                : /(time|clock|hour|minute)/.test(lower) ? "clock"
                  : /(rocket|launch|ship|plane)/.test(lower) ? "rocket"
                    : /(tree|jungle|forest|plant)/.test(lower) ? "tree"
                      : /(building|city|skyscraper)/.test(lower) ? "building"
                        : /(death|danger|dead|kill)/.test(lower) ? "skull" : pick(SYMBOLS, seed, "sym");
  const focus = clean(topic.split(/[,.!?]/)[0], 26) || "this";
  return { env, symbol, focus };
}

function targetScenes(seconds) {
  if (seconds <= 15) return 4;
  if (seconds <= 25) return 5;
  return Math.min(40, Math.max(6, Math.round(seconds / 6)));
}

function extendScenes(list, count, seed) {
  const out = list.slice(0, count);
  if (!out.length) return out;
  const filler = ["And it gets stranger.", "Then one detail changes everything.", "Nobody expected this part.", "The next minute decides it.", "This is where it breaks.", "The final piece falls into place."];
  let i = 0;
  while (out.length < count) {
    const base = list[i % list.length];
    out.push({
      ...base,
      narration: i % 4 === 0 ? filler[(seed + i) % filler.length] : base.narration,
      visual: i % 2 ? base.visual : pick(ENVS, seed, `e${i}`),
      symbol: i % 3 === 0 ? pick(SYMBOLS, seed, `s${i}`) : base.symbol,
    });
    i += 1;
  }
  return out;
}

function fallbackScript(topic, type, seconds) {
  const cleanTopic = clean(topic, 240) || "you wake up and gravity switches off";
  const seed = hash(cleanTopic);
  const count = targetScenes(seconds);
  const t = TYPES[type] ? type : "whatif";
  const { env, symbol, focus } = sceneSet(cleanTopic, t, seed);
  const short = focus.replace(/[.!?]+$/, "");
  const lower = short.toLowerCase();
  const beats = t === "whatif"
    ? [
      `What if ${lower} happened right now?`,
      "It starts with one small change.",
      "Then the whole world reacts.",
      "The real danger is not the first minute.",
      "You would have seconds to get it right.",
      "And nobody would see it coming.",
      "That is the part they never tell you.",
    ]
    : t === "how"
      ? [
        `This is how ${lower} actually works.`,
        "Step one: it begins smaller than you think.",
        "Then pressure builds in one narrow place.",
        "That pressure is what makes it visible.",
        "One last mechanism locks it all together.",
        "And that is why it never seems to fail.",
        "Until one part finally does.",
      ]
      : [
        `${short} - and it really happened.`,
        "The first reports sounded impossible.",
        "Investigators found one detail nobody expected.",
        "That detail changed the entire outcome.",
        "The records were sealed for years.",
        "The real explanation is simpler, and stranger.",
        "And it could happen again.",
      ];
  const envs = [env];
  for (let i = 1; i < count; i += 1) {
    let e = pick(ENVS, seed, `e${i}`);
    if (e === envs[i - 1]) e = ENVS[(ENVS.indexOf(e) + 1 + (seed % 3)) % ENVS.length];
    envs.push(e);
  }
  const captions = t === "whatif"
    ? ["WHAT IF", "DAY ONE", "THE SHIFT", "MINUTE TWO", "LAST CHANCE", "NO WARNING", "THE PAYOFF"]
    : t === "how"
      ? ["HOW IT WORKS", "STEP 1", "PRESSURE", "THE CATCH", "STEP 3", "WHY IT WORKS", "THE FLAW"]
      : ["TRUE STORY", "THE REPORT", "THE DETAIL", "THE TURN", "THE RECORD", "THE TRUTH", "AFTERMATH"];
  const scenes = [];
  for (let i = 0; i < count; i += 1) {
    scenes.push({
      narration: clean(beats[i % beats.length], 92),
      visual: envs[i % envs.length],
      symbol,
      focus: clean(captions[i % captions.length], 20),
      caption: clean(captions[i % captions.length], 20),
    });
  }
  return {
    title: clean(short, 40),
    tag: TYPES[t],
    type: t,
    hook: clean(beats[0], 60),
    scenes,
    source: "template",
    seed,
  };
}

function normalize(raw, topic, type, seconds) {
  const fallback = fallbackScript(topic, type, seconds);
  if (!raw || typeof raw !== "object") return fallback;
  const t = TYPES[type] ? type : "whatif";
  const target = targetScenes(seconds);
  const seed = hash(String(topic));
  let prevVisual = "";
  const seen = new Set();
  const scenes = (Array.isArray(raw.scenes) ? raw.scenes : []).slice(0, target).map((s, i) => {
    let visual = ENVS.includes(String(s?.visual)) ? String(s.visual) : fallback.scenes[0].visual;
    if (visual === prevVisual) {
      const fresh = ENVS.filter((e) => e !== prevVisual && !seen.has(e));
      visual = fresh.length ? fresh[(seed + i) % fresh.length] : ENVS.find((e) => e !== prevVisual);
    }
    prevVisual = visual;
    seen.add(visual);
    return {
      narration: clean(s?.narration, 110) || fallback.scenes[0].narration,
      visual,
      symbol: SYMBOLS.includes(String(s?.symbol)) ? String(s.symbol) : fallback.scenes[0].symbol,
      focus: clean(s?.focus, 22) || fallback.scenes[0].focus,
      caption: clean(s?.caption, 24) || clean(s?.focus, 24) || fallback.scenes[0].caption,
    };
  });
  const full = scenes.length ? extendScenes(scenes, target, hash(String(topic))) : [];
  return {
    title: clean(raw.title, 44) || fallback.title,
    tag: TYPES[t],
    type: t,
    hook: clean(raw.hook, 70) || fallback.hook,
    scenes: full.length ? full : fallback.scenes,
    source: "llm",
    seed: hash(String(topic)),
  };
}

async function script({ topic, type, seconds }) {
  const secs = Math.min(180, Math.max(12, Number(seconds) || 20));
  const t = TYPES[type] ? type : "whatif";
  const count = Math.min(20, targetScenes(secs));
  const cleanTopic = clean(topic, 600);
  if (!cleanTopic) return fallbackScript("you wake up and gravity switches off", t, secs);
  const style = t === "whatif"
    ? "The What If format: take one ordinary thing and push it to an extreme consequence. Calm, factual, slightly ominous."
    : t === "how"
      ? "The How It Works format: open the object up like a cutaway diagram and explain its mechanism in clear steps."
      : "The True Story format: a real, documented event retold like a documentary. Stay accurate; do not invent named people or fake statistics.";
  const system = [
    "You write and direct realistic 3D explainer shorts in the style of miniature CGI channels: hyper-real lighting, tiny figures, one dramatic idea per shot, calm documentary narration.",
    `Format: ${TYPES[t]}. ${style}`,
    `Write exactly ${count} scenes for a ${secs}-second vertical short.`,
    "Scene 1 is the hook: a direct question or impossible claim with a concrete number, under 40 characters. No emoji, no hashtags, never 'part 2'.",
    "Narration: one sentence per scene, second person or report voice, present tense, under 90 characters. Every sentence adds new information; never restate the previous scene and never reuse a sentence.",
    "Use specific, vivid detail (numbers, sounds, textures, places) instead of generic filler like 'it gets stranger'.",
    "Build real tension: setup, escalation, a turn nobody expects, then a concrete payoff in the last two scenes.",
    secs > 40 ? "This is a long explainer: pace the reveal over every scene and land the payoff in the final lines." : "",
    "Every scene gets a central visual object (symbol), an environment (visual), a 1-3 word on-screen kicker (focus) and a short caption.",
    "Design every shot fresh: never use the same environment in two consecutive scenes, use at least four different environments per short, and rotate the symbol so nothing looks like a rerun.",
    `Choose visual from: ${ENVS.join("|")}.`,
    "Return ONLY JSON with this shape:",
    '{"title":"<=44 chars","hook":"<=40 chars","scenes":[{"narration":"...","visual":"' + ENVS.slice(0, 9).join("|") + '|' + ENVS.slice(9).join("|") + '","symbol":"' + SYMBOLS.join("|") + '","focus":"1-3 words","caption":"1-3 words"}]}',
    "Keep it cinematic and grounded. No cartoon tone, no jokes in True Story, no sequel hooks.",
  ].join("\n");
  const user = `Topic: ${cleanTopic}\nFormat: ${TYPES[t]}\nLength: ${secs}s, vertical 9:16.`;
  try {
    const raw = await askJson(system, user);
    return normalize(raw, cleanTopic, t, secs);
  } catch {
    return fallbackScript(cleanTopic, t, secs);
  }
}

module.exports = { script, TYPES, ENVS, SYMBOLS };
