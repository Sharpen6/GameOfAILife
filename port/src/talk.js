// Port of gameofailife/talk.py: what people say (life.md 5.2), pure. The tables are talk.py's, generated.
(function (G) {
  "use strict";
  const { hasOwn } = G.py;

  const TOPICS = ["weather", "work", "school", "money", "family", "health", "news", "love"];
  const TONES = ["warm", "pleasant", "awkward", "argument"];
  const MAX_LINE = 160;

  const get = (ctx, k) => (hasOwn(ctx, k) ? ctx[k] : null);

  // The topic weights, in TOPICS order (life.md 5.2).
  function weights(ctx) {
    return [
      1.0 + (get(ctx, "rain") ? 2.0 : 0.0),
      get(ctx, "coworkers") ? 3.0 : 0.0,
      get(ctx, "pupils") ? 3.0 : 0.0,
      get(ctx, "money") ? 3.0 : 0.5,
      get(ctx, "family") ? 2.0 + (get(ctx, "baby") ? 3.0 : 0.0) : 0.0,
      get(ctx, "health") ? 3.0 : 0.0,
      get(ctx, "headline") ? 2.0 : 0.0,
      get(ctx, "love") ? 4.0 : 0.0,
    ];
  }

  // The topic for a talk: TOPICS by weight, `u` in [0, 1).
  function topic(ctx, u) {
    const ws = weights(ctx);
    let total = 0.0;
    for (const w of ws) total += w;
    let x = u * total;
    for (let i = 0; i < TOPICS.length; i++) {
      const w = ws[i];
      if (w <= 0) continue;
      if (x < w) return TOPICS[i];
      x -= w;
    }
    return "weather";
  }

  const LINES = {
    weather: {
      warm: [
        ["Lovely out today, isn't it?", "Makes you glad to be alive."],
        ["Did you see that sky this morning?", "I stopped on the way just to look at it."],
        ["Rain or shine, it's good to see you.", "You always cheer me up."],
      ],
      pleasant: [
        ["Another wet one!", "I forgot my umbrella again."],
        ["They say it clears up later.", "Let's hope so."],
        ["Cold this morning.", "I almost stayed in bed."],
      ],
      awkward: [
        ["So... the weather.", "Yes. The weather."],
        ["Bit grey, isn't it?", "I suppose it is."],
        ["Rain again.", "Mm."],
      ],
      argument: [
        ["You left the window open in this weather?", "Don't start, it wasn't me."],
        ["You never check the forecast.", "And you never stop complaining."],
        ["It's freezing in {place}.", "Then wear a coat instead of moaning."],
      ],
    },
    work: {
      warm: [
        ["You saved my day at {work} today.", "That's what we do for each other."],
        ["I couldn't do this job without you.", "Same here, honestly."],
        ["Lunch together tomorrow?", "Wouldn't miss it."],
      ],
      pleasant: [
        ["Busy shift at {work}.", "Never a quiet day here."],
        ["Did you hear about the new rota?", "I'll believe it when I see it."],
        ["Nearly the weekend.", "Can't come soon enough."],
      ],
      awkward: [
        ["Did you finish that thing?", "Which thing?"],
        ["Nice... badge.", "We all wear them."],
        ["Are you on tomorrow?", "I think so. Are you?"],
      ],
      argument: [
        ["You left me the whole mess at {work} again.", "I had my own work to do!"],
        ["That was my idea and you know it.", "Grow up."],
        ["You're always late.", "And you're always watching the clock."],
      ],
    },
    school: {
      warm: [
        ["Want to sit together tomorrow?", "Yes! Save me a seat."],
        ["You're the best at drawing.", "You can have my good pencils."],
        ["Let's play after school.", "Race you to the park!"],
      ],
      pleasant: [
        ["Did you do the homework?", "Most of it."],
        ["What did you get on the test?", "Better than last time."],
        ["Lunch was okay today.", "Better than Tuesday."],
      ],
      awkward: [
        ["Is this your pen?", "No... maybe?"],
        ["You're in my seat.", "Oh. Sorry."],
        ["Do you like maths?", "Not really."],
      ],
      argument: [
        ["You told on me!", "You started it!"],
        ["That's mine, give it back.", "I had it first!"],
        ["You're not my friend any more.", "Fine, I don't care."],
      ],
    },
    money: {
      warm: [
        ["If you're stuck this month, just say.", "You're a true friend."],
        ["We'll get through it, money comes and goes.", "Thanks for saying that."],
        ["Good news about your pay!", "Drinks are on me."],
      ],
      pleasant: [
        ["Everything costs more these days.", "Don't get me started on rent."],
        ["Saving up for anything?", "Trying to, anyway."],
        ["Bills came in today.", "Mine too. Ouch."],
      ],
      awkward: [
        ["So, about that money...", "Can we not, right now?"],
        ["Nice shoes. New?", "They were on sale."],
        ["How's the budget?", "Tight. Thanks for asking."],
      ],
      argument: [
        ["Where did all the money go?", "Don't look at me like that!"],
        ["You owe me, remember?", "I said I'd pay you back."],
        ["You spend like there's no tomorrow.", "And you count every coin."],
      ],
    },
    family: {
      warm: [
        ["How is little {kid}?", "Growing so fast, it's a joy."],
        ["Give {partner} my love.", "I will, they always ask about you."],
        ["Family is everything, isn't it?", "It really is."],
      ],
      pleasant: [
        ["How's the family?", "Busy, but good."],
        ["Is {kid} in the school play next week?", "Yes, we're so proud."],
        ["We had everyone over on Sunday.", "Sounds lovely."],
      ],
      awkward: [
        ["And how's... everyone?", "Fine. Everyone's fine."],
        ["Still seeing {partner}?", "Yes. Why?"],
        ["Kids, eh?", "Mm."],
      ],
      argument: [
        ["You're never there for {kid}.", "I do more than you think!"],
        ["Your family always comes first.", "They're my family!"],
        ["We need to talk about your mother.", "Not this again."],
      ],
    },
    health: {
      warm: [
        ["Feeling better? I was worried.", "Much better, thank you."],
        ["You look well, all things considered.", "Rest does wonders."],
        ["Take care of yourself, okay?", "I will. You too."],
      ],
      pleasant: [
        ["Still got that {illness}?", "On the mend."],
        ["Half the town is ill this week.", "Wash your hands!"],
        ["Did you see the doctor?", "Yes, nothing serious."],
      ],
      awkward: [
        ["You look... tired.", "Thanks. I've been ill."],
        ["Is it catching?", "I hope not."],
        ["Feeling better?", "Sort of."],
      ],
      argument: [
        ["You came in sick and gave it to everyone!", "I couldn't afford a day off!"],
        ["You never look after yourself.", "Stop fussing!"],
        ["Go home if you're ill.", "Mind your own business."],
      ],
    },
    news: {
      warm: [
        ["Did you hear? {headline}", "What a thing. Glad we have each other."],
        ["Big news: {headline}", "I can hardly believe it."],
        ["Everyone's talking about it: {headline}", "Let's raise a glass to that."],
      ],
      pleasant: [
        ["Did you hear? {headline}", "I read about it this morning."],
        ["Apparently: {headline}", "Well, well."],
        ["{headline} Can you believe it?", "Small town, big news."],
      ],
      awkward: [
        ["So... {headline}", "Yes, I heard."],
        ["Did you hear the news?", "Which news?"],
        ["{headline} Strange, isn't it?", "If you say so."],
      ],
      argument: [
        ["{headline} Typical!", "You always see the worst in people."],
        ["Did you hear? {headline}", "Don't gossip."],
        ["{headline} I told you so.", "You tell everyone so."],
      ],
    },
    love: {
      warm: [
        ["I keep thinking about you.", "Me too, all day."],
        ["You make {place} feel like home.", "Only because you're here."],
        ["Dinner, just us, soon?", "I'd love that."],
      ],
      pleasant: [
        ["Nice to see you here.", "Nice to be seen."],
        ["You look good today.", "Oh, stop it."],
        ["Doing anything this weekend?", "Not yet. Why?"],
      ],
      awkward: [
        ["I was just... thinking of you.", "Oh! Right. Okay."],
        ["So, um, nice evening.", "Yes. Very... evening."],
        ["Do you come here often?", "I work here."],
      ],
      argument: [
        ["Where were you last night?", "Out. Is that a crime?"],
        ["You never listen to me.", "I'm listening now!"],
        ["Do you even care?", "Of course I care!"],
      ],
    },
  };

  const FILL = ["place", "work", "kid", "partner", "illness", "headline"];
  const DEFAULT_FILL = {"place": "town", "work": "work", "kid": "the kids", "partner": "your partner", "illness": "cold", "headline": "Something happened in town."};

  function _fill(text, ctx) {
    for (const k of FILL) {
      const token = "{" + k + "}";
      if (text.includes(token)) {
        const v = get(ctx, k);
        text = text.split(token).join(v ? v : DEFAULT_FILL[k]);
      }
    }
    return text;
  }

  function _fits(pair, ctx) {
    for (const k of FILL) {
      const token = "{" + k + "}";
      if ((pair[0].includes(token) || pair[1].includes(token)) && !get(ctx, k)) return false;
    }
    return true;
  }

  // "“opener” “reply”" for a talk on `topic` in `tone`: a pair whose words the talk can fill, else any.
  function line(topic, tone, ctx, rng) {
    let pairs = (hasOwn(LINES, topic) ? LINES[topic] : LINES.weather)[tone] || LINES.weather.pleasant;
    const usable = pairs.filter(pr => _fits(pr, ctx));
    if (usable.length) pairs = usable;
    const [opener, answer] = pairs[Math.floor(rng.random() * pairs.length)];
    let out = `“${_fill(opener, ctx)}” “${_fill(answer, ctx)}”`;
    if (out.length > MAX_LINE) out = out.slice(0, MAX_LINE - 1) + "”";
    return out;
  }

  const REPLIES = {
    warm: ["Aw, that made my day!", "So good to hear from you!", "Yes! Let's catch up soon.", "You always know what to say."],
    pleasant: ["Thanks for the message!", "Good to hear from you.", "Sounds good.", "Ha, okay!"],
    cool: ["Okay.", "Sure.", "Got it.", "Busy now, talk later."],
    cold: ["Why are you texting me?", "Not now.", "Leave me alone.", "Hm."],
  };

  // A townsperson's answer to a text, by how they feel about the sender and their mood.
  function reply(affinity, mood, rng) {
    const score = affinity + (mood - 50) * 0.3;
    const tone = score >= 45 ? "warm" : score >= 15 ? "pleasant" : score >= -10 ? "cool" : "cold";
    const options = REPLIES[tone];
    return options[Math.floor(rng.random() * options.length)];
  }

  G.talk = { TOPICS, TONES, MAX_LINE, weights, topic, LINES, FILL, DEFAULT_FILL, line, REPLIES, reply };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));
