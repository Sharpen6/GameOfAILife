// Port of gameofailife/social.py: social life for both tiers (life.md 5.1-5.4). Stub (v3-skel-people).
(function (G) {
  "use strict";

  // sim.social: buckets (10 lists of place ids), talks (ring of 40 [tick, a, b, tone, place]), folk_invites.
  class SocialState {
    constructor() {
      this.buckets = Array.from({ length: 10 }, () => []);
      this.talks = [];
      this.folk_invites = {};
    }
  }

  function init(sim) { sim.social = new SocialState(); }
  function tick(sim) {}
  function on_affinity(sim, a_id, b_id, before, after) {}
  function talks_json(sim) { return []; }
  function message_folk(sim, a, fid, text) { return { ok: false, error: "unknown or dead character" }; }
  function invite_folk(sim, host, guest_id, place_id) { return null; }
  function pick_companion(sim, p, why) { return null; }
  function seed_story(sim) {}

  G.social = { SocialState, init, tick, on_affinity, talks_json, message_folk, invite_folk, pick_companion, seed_story };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));
