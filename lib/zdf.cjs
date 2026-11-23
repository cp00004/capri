/**
 * STORIES // cinematic explainer shorts in the Zack D. Films mold: one calm
 * hook, a hyper-real miniature scene per beat, and a payoff a few seconds in.
 * The LLM writes the beat sheet; the renderer draws every frame locally.
 */
const { askJson } = require("./toon.cjs");

const TYPES = { whatif: "What If", how: "How It Works", truestory: "True Story" };
const ENVS = ["city", "room", "street", "ocean", "desert", "space", "body", "machine", "jungle", "ice", "volcano", "lab", "sky", "crowd"];
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

function fallbackScript(topic, type, seconds) {
  const cleanTopic = clean(topic, 240) || "you wake up and gravity switches off";
  const seed = hash(cleanTopic);
  const count = seconds <= 15 ? 4 : seconds <= 25 ? 5 : 7;
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
  const envs = [env, env, pick(ENVS, seed, "e2"), env, pick(ENVS, seed, "e3"), env, env];
  const captions = t === "whatif"
    ? ["WHAT IF", "DAY ONE", "THE SHIFT", "MINUTE TWO", "LAST CHANCE", "NO WARNING", "PART 2"]
    : t === "how"
      ? ["HOW IT WORKS", "STEP 1", "PRESSURE", "THE CATCH", "STEP 3", "WHY IT WORKS", "THE FLAW"]
      : ["TRUE STORY", "THE REPORT", "THE DETAIL", "THE TURN", "THE RECORD", "THE TRUTH", "AGAIN"];
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
  const scenes = (Array.isArray(raw.scenes) ? raw.scenes : []).slice(0, 10).map((s) => ({
    narration: clean(s?.narration, 110) || fallback.scenes[0].narration,
    visual: ENVS.includes(String(s?.visual)) ? String(s.visual) : fallback.scenes[0].visual,
    symbol: SYMBOLS.includes(String(s?.symbol)) ? String(s.symbol) : fallback.scenes[0].symbol,
    focus: clean(s?.focus, 22) || fallback.scenes[0].focus,
    caption: clean(s?.caption, 24) || clean(s?.focus, 24) || fallback.scenes[0].caption,
  }));
  return {
    title: clean(raw.title, 44) || fallback.title,
    tag: TYPES[t],
    type: t,
    hook: clean(raw.hook, 70) || fallback.hook,
    scenes: scenes.length ? scenes : fallback.scenes,
    source: "llm",
    seed: hash(String(topic)),
  };
}

async function script({ topic, type, seconds }) {
  const secs = Math.min(45, Math.max(12, Number(seconds) || 20));
  const t = TYPES[type] ? type : "whatif";
  const count = secs <= 15 ? 4 : secs <= 25 ? 5 : 7;
  const cleanTopic = clean(topic, 600);
  if (!cleanTopic) return fallbackScript("you wake up and gravity switches off", t, secs);
  const style = t === "whatif"
    ? "The What If format: take one ordinary thing and push it to an extreme consequence. Calm, factual, slightly ominous."
    : t === "how"
      ? "The How It Works format: open the object up like a cutaway diagram and explain its mechanism in clear steps."
      : "The True Story format: a real, documented event retold like a documentary. Stay accurate; do not invent named people or fake statistics.";
  const system = [
    "You write and direct realistic 3D explainer shorts in the style of miniature CGI channels: hyper-real lighting, tiny figures, one dramatic idea per shot, calm narration.",
    `Format: ${TYPES[t]}. ${style}`,
    `Write exactly ${count} scenes for a ${secs}-second vertical short.`,
    "Scene 1 is the hook: a direct question or impossible claim in under 40 characters. No emoji, no hashtags.",
    "Narration: one sentence per scene, second person or report voice, present tense, under 90 characters. Never repeat the same sentence.",
    "Every scene gets a central visual object (symbol), an environment (visual), a 1-3 word on-screen kicker (focus) and a short caption.",
    "Return ONLY JSON with this shape:",
    '{"title":"<=44 chars","hook":"<=40 chars","scenes":[{"narration":"...","visual":"' + ENVS.slice(0, 8).join("|") + '|' + ENVS.slice(8).join("|") + '","symbol":"' + SYMBOLS.join("|") + '","focus":"1-3 words","caption":"1-3 words"}]}',
    "Keep it cinematic and grounded. No cartoon tone, no jokes in True Story.",
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
