// Port of gameofailife/talk.py: what people say (life.md 5.2), pure. Stub (v3-skel-people).
(function (G) {
  "use strict";

  const topic = (ctx, u) => "weather";
  const line = (topic, tone, ctx, rng) => "";
  const reply = (affinity, mood, rng) => "Thanks!";

  G.talk = { topic, line, reply };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));
