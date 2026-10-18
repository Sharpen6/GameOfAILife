"""What people say (life.md 5.2), pure: a topic for a talk, an opener and a reply, and the answer to a text.

`ctx` is a dict the caller fills: `rain`, `coworkers`, `pupils`, `money`, `family`, `baby`, `health`, `love` (bools)
and the words `place`, `work`, `kid`, `partner`, `illness`, `headline` (strings or None; `headline` set only for a
usable news headline). Lines are `“opener” “reply”`, at most 160 characters, three or more per topic and tone class.
No randomness of its own: `u` is a uniform draw, `rng` an Rng (rng.py), both the caller's.
"""

from __future__ import annotations

TOPICS = ("weather", "work", "school", "money", "family", "health", "news", "love")
TONES = ("warm", "pleasant", "awkward", "argument")
MAX_LINE = 160


def weights(ctx) -> list:
    """The topic weights, in TOPICS order (life.md 5.2)."""
    return [
        1.0 + (2.0 if ctx.get("rain") else 0.0),
        3.0 if ctx.get("coworkers") else 0.0,
        3.0 if ctx.get("pupils") else 0.0,
        3.0 if ctx.get("money") else 0.5,
        (2.0 + (3.0 if ctx.get("baby") else 0.0)) if ctx.get("family") else 0.0,
        3.0 if ctx.get("health") else 0.0,
        2.0 if ctx.get("headline") else 0.0,
        4.0 if ctx.get("love") else 0.0,
    ]


def topic(ctx, u) -> str:
    """The topic for a talk: TOPICS by weight, `u` in [0, 1)."""
    ws = weights(ctx)
    total = 0.0
    for w in ws:
        total += w
    x = u * total
    for name, w in zip(TOPICS, ws):
        if w <= 0:
            continue
        if x < w:
            return name
        x -= w
    return "weather"


LINES = {
    "weather": {
        "warm": [("Lovely out today, isn't it?", "Makes you glad to be alive."),
                 ("Did you see that sky this morning?", "I stopped on the way just to look at it."),
                 ("Rain or shine, it's good to see you.", "You always cheer me up.")],
        "pleasant": [("Another wet one!", "I forgot my umbrella again."),
                     ("They say it clears up later.", "Let's hope so."),
                     ("Cold this morning.", "I almost stayed in bed.")],
        "awkward": [("So... the weather.", "Yes. The weather."),
                    ("Bit grey, isn't it?", "I suppose it is."),
                    ("Rain again.", "Mm.")],
        "argument": [("You left the window open in this weather?", "Don't start, it wasn't me."),
                     ("You never check the forecast.", "And you never stop complaining."),
                     ("It's freezing in {place}.", "Then wear a coat instead of moaning.")],
    },
    "work": {
        "warm": [("You saved my day at {work} today.", "That's what we do for each other."),
                 ("I couldn't do this job without you.", "Same here, honestly."),
                 ("Lunch together tomorrow?", "Wouldn't miss it.")],
        "pleasant": [("Busy shift at {work}.", "Never a quiet day here."),
                     ("Did you hear about the new rota?", "I'll believe it when I see it."),
                     ("Nearly the weekend.", "Can't come soon enough.")],
        "awkward": [("Did you finish that thing?", "Which thing?"),
                     ("Nice... badge.", "We all wear them."),
                     ("Are you on tomorrow?", "I think so. Are you?")],
        "argument": [("You left me the whole mess at {work} again.", "I had my own work to do!"),
                     ("That was my idea and you know it.", "Grow up."),
                     ("You're always late.", "And you're always watching the clock.")],
    },
    "school": {
        "warm": [("Want to sit together tomorrow?", "Yes! Save me a seat."),
                 ("You're the best at drawing.", "You can have my good pencils."),
                 ("Let's play after school.", "Race you to the park!")],
        "pleasant": [("Did you do the homework?", "Most of it."),
                     ("What did you get on the test?", "Better than last time."),
                     ("Lunch was okay today.", "Better than Tuesday.")],
        "awkward": [("Is this your pen?", "No... maybe?"),
                    ("You're in my seat.", "Oh. Sorry."),
                    ("Do you like maths?", "Not really.")],
        "argument": [("You told on me!", "You started it!"),
                     ("That's mine, give it back.", "I had it first!"),
                     ("You're not my friend any more.", "Fine, I don't care.")],
    },
    "money": {
        "warm": [("If you're stuck this month, just say.", "You're a true friend."),
                 ("We'll get through it, money comes and goes.", "Thanks for saying that."),
                 ("Good news about your pay!", "Drinks are on me.")],
        "pleasant": [("Everything costs more these days.", "Don't get me started on rent."),
                     ("Saving up for anything?", "Trying to, anyway."),
                     ("Bills came in today.", "Mine too. Ouch.")],
        "awkward": [("So, about that money...", "Can we not, right now?"),
                    ("Nice shoes. New?", "They were on sale."),
                    ("How's the budget?", "Tight. Thanks for asking.")],
        "argument": [("Where did all the money go?", "Don't look at me like that!"),
                     ("You owe me, remember?", "I said I'd pay you back."),
                     ("You spend like there's no tomorrow.", "And you count every coin.")],
    },
    "family": {
        "warm": [("How is little {kid}?", "Growing so fast, it's a joy."),
                 ("Give {partner} my love.", "I will, they always ask about you."),
                 ("Family is everything, isn't it?", "It really is.")],
        "pleasant": [("How's the family?", "Busy, but good."),
                     ("{kid} has a school play next week.", "You must be proud."),
                     ("We had everyone over on Sunday.", "Sounds lovely.")],
        "awkward": [("And how's... everyone?", "Fine. Everyone's fine."),
                    ("Still seeing {partner}?", "Yes. Why?"),
                    ("Kids, eh?", "Mm.")],
        "argument": [("You never help with {kid}.", "I do more than you think!"),
                     ("Your family always comes first.", "They're my family!"),
                     ("We need to talk about your mother.", "Not this again.")],
    },
    "health": {
        "warm": [("Feeling better? I was worried.", "Much better, thank you."),
                 ("You look well, all things considered.", "Rest does wonders."),
                 ("Take care of yourself, okay?", "I will. You too.")],
        "pleasant": [("Still got that {illness}?", "On the mend."),
                     ("Half the town is ill this week.", "Wash your hands!"),
                     ("Did you see the doctor?", "Yes, nothing serious.")],
        "awkward": [("You look... tired.", "Thanks. I've been ill."),
                    ("Is it catching?", "I hope not."),
                    ("Feeling better?", "Sort of.")],
        "argument": [("You came in sick and gave it to everyone!", "I couldn't afford a day off!"),
                     ("You never look after yourself.", "Stop fussing!"),
                     ("Go home if you're ill.", "Mind your own business.")],
    },
    "news": {
        "warm": [("Did you hear? {headline}", "What a thing. Glad we have each other."),
                 ("Big news: {headline}", "I can hardly believe it."),
                 ("Everyone's talking about it: {headline}", "Let's raise a glass to that.")],
        "pleasant": [("Did you hear? {headline}", "I read about it this morning."),
                     ("Apparently: {headline}", "Well, well."),
                     ("{headline} Can you believe it?", "Small town, big news.")],
        "awkward": [("So... {headline}", "Yes, I heard."),
                    ("Did you hear the news?", "Which news?"),
                    ("{headline} Strange, isn't it?", "If you say so.")],
        "argument": [("{headline} Typical!", "You always see the worst in people."),
                     ("Did you hear? {headline}", "Don't gossip."),
                     ("{headline} I told you so.", "You tell everyone so.")],
    },
    "love": {
        "warm": [("I keep thinking about you.", "Me too, all day."),
                 ("You make {place} feel like home.", "Only because you're here."),
                 ("Dinner, just us, soon?", "I'd love that.")],
        "pleasant": [("Nice to see you here.", "Nice to be seen."),
                     ("You look good today.", "Oh, stop it."),
                     ("Doing anything this weekend?", "Not yet. Why?")],
        "awkward": [("I was just... thinking of you.", "Oh! Right. Okay."),
                    ("So, um, nice evening.", "Yes. Very... evening."),
                    ("Do you come here often?", "I work here.")],
        "argument": [("Where were you last night?", "Out. Is that a crime?"),
                     ("You never listen to me.", "I'm listening now!"),
                     ("Do you even care?", "Of course I care!")],
    },
}

FILL = ("place", "work", "kid", "partner", "illness", "headline")
DEFAULT_FILL = {"place": "town", "work": "work", "kid": "the kids", "partner": "your partner",
                "illness": "cold", "headline": "Something happened in town."}


def _fill(text: str, ctx) -> str:
    for k in FILL:
        token = "{" + k + "}"
        if token in text:
            v = ctx.get(k)
            text = text.replace(token, v if v else DEFAULT_FILL[k])
    return text


def _fits(pair, ctx) -> bool:
    for k in FILL:
        token = "{" + k + "}"
        if (token in pair[0] or token in pair[1]) and not ctx.get(k):
            return False
    return True


def line(topic, tone, ctx, rng) -> str:
    """`“opener” “reply”` for a talk on `topic` in `tone`: a pair whose words the talk can fill, else any."""
    pairs = LINES.get(topic, LINES["weather"]).get(tone) or LINES["weather"]["pleasant"]
    usable = [pr for pr in pairs if _fits(pr, ctx)]
    if usable:
        pairs = usable
    opener, answer = pairs[int(rng.random() * len(pairs))]
    out = f"“{_fill(opener, ctx)}” “{_fill(answer, ctx)}”"
    if len(out) > MAX_LINE:
        out = out[:MAX_LINE - 1] + "”"
    return out


REPLIES = {
    "warm": ["Aw, that made my day!", "So good to hear from you!", "Yes! Let's catch up soon.",
             "You always know what to say."],
    "pleasant": ["Thanks for the message!", "Good to hear from you.", "Sounds good.", "Ha, okay!"],
    "cool": ["Okay.", "Sure.", "Got it.", "Busy now, talk later."],
    "cold": ["Why are you texting me?", "Not now.", "Leave me alone.", "Hm."],
}


def reply(affinity, mood, rng) -> str:
    """A townsperson's answer to a text, by how they feel about the sender and their mood."""
    score = affinity + (mood - 50) * 0.3
    tone = "warm" if score >= 45 else "pleasant" if score >= 15 else "cool" if score >= -10 else "cold"
    options = REPLIES[tone]
    return options[int(rng.random() * len(options))]
