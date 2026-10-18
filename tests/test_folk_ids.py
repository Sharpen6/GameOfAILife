"""Townsfolk ids everywhere a named id can go (PLAN 2.2): three days in the region with the 1,000, every controller
and God query each day, named and townsperson pages, fork messages about a townsperson, an invite to and a text to a
townsperson, a named death with townsfolk friends, and a named child's play fork while the child has a townsperson
classmate tie (forks._playmate). Nothing raises; sim.invites never holds a townsperson; every place a named is sent
to for a date or an invite is in Millbrook."""

from __future__ import annotations

import json
import unittest

from gameofailife import forks, people, social
from gameofailife.agent import RelationKind
from gameofailife.server import GameServer
from gameofailife.sim import Simulation

DAY = 24 * 60
FRIEND = RelationKind.FRIEND
WHATS = ("possessions", "attributes", "relationships", "memory", "inbox", "world", "people", "market")


class FolkIdsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sim = sim = Simulation(1, world="region", folk=1000)
        cls.server = GameServer(sim, speed=0)
        cls.mb = sim.town.millbrook_ids
        living = sim.folk.living()
        adults = [p for p in living if p.age >= 25 and p.alive]
        cls.adults = sorted(adults, key=lambda p: social.partner_of(sim, p) is not None)  # singles first
        cls.kids = [p for p in living if 6 <= p.age <= 12]
        # Ties a few named have to townsfolk, made here so every path below has one to walk.
        people.set_rel(sim, "tom", cls.adults[0].id, FRIEND, 55)
        people.set_rel(sim, "ari", cls.adults[1].id, FRIEND, 45)
        people.set_rel(sim, "hila", cls.adults[2].id, FRIEND, 60)
        people.set_rel(sim, "hila", cls.adults[3].id, FRIEND, 50)
        people.set_rel(sim, "noa", cls.kids[0].id, FRIEND, 50)  # a classmate
        assert sim.claim("tom", "c1")

    def check_invites(self):
        sim = self.sim
        for inv in sim.invites.values():
            self.assertFalse(people.is_folk_id(inv["from"]) or people.is_folk_id(inv["to"]), inv)
            self.assertIn(inv["place"], self.mb)
        for inv in sim.social.folk_invites.values():
            self.assertIn(inv["place"], self.mb)
            self.assertFalse(people.is_folk_id(inv["from"]))
        for a in sim.agents.values():
            for q in (a.life.pending if a.life is not None else []):
                if q["kind"] == "date":
                    self.assertIn(q["ctx"]["place"], self.mb)

    def queries(self, day):
        sim, server = self.sim, self.server
        fid = self.adults[0].id
        for aid in ("tom", "hila", fid, self.adults[2].id, self.kids[0].id, "f99999", "nobody"):
            out = server._god({"type": "get_agent", "agent_id": aid})
            json.dumps(out)
            if aid in sim.agents or sim.folk.person(aid) is not None:
                self.assertEqual(out["type"], "agent", aid)
                self.assertEqual(out["agent"]["kind"], "named" if aid in sim.agents else "folk")
            for oid, row in (out.get("agent") or {}).get("relationships", {}).items():
                self.assertEqual(row["named"], not people.is_folk_id(oid))
        for msg in ({"type": "get_stats"}, {"type": "get_decisions", "agent_id": "tom"},
                    {"type": "get_decisions", "agent_id": fid}, {"type": "get_decisions"},
                    {"type": "get_home", "home_id": sim.households[sim.agents["tom"].household_id].home_id},
                    {"type": "set_luck", "agent_id": fid, "luck": 70}, {"type": "set_luck", "agent_id": "ari", "luck": 55},
                    {"type": "set_profile", "agent_id": "tom", "prompt": "Kind and curious."}):
            json.dumps(server._god(msg))
        for what in WHATS:
            out = server._controller("c1", {"type": "query", "agent_id": "tom", "what": what})
            self.assertEqual(out["type"], "answer", what)
            json.dumps(out)
        sent = server._controller("c1", {"type": "send_message", "agent_id": "tom", "to": fid,
                                         "text": f"Hi there, day {day}!"})
        self.assertTrue(sent["ok"], sent)
        self.assertTrue(server._controller("c1", {"type": "send_message", "agent_id": "tom", "to": "ari",
                                                  "text": "Hey"})["ok"])
        stranger = self.adults[-1].id
        self.assertFalse(server._controller("c1", {"type": "send_message", "agent_id": "tom", "to": stranger,
                                                   "text": "Who are you?"})["ok"])
        cafe = sim.nearest(sim.agents["tom"], ("cafe",))
        inv = server._controller("c1", {"type": "invite", "agent_id": "tom", "to": fid, "place": cafe.id})
        self.assertEqual(inv["type"], "invited")
        if inv["ok"]:
            self.assertTrue(inv["invite"]["id"].startswith("fi"))
            self.assertNotIn(inv["invite"]["id"], sim.invites)
        json.dumps(sim.state_json())
        rows = social.talks_json(sim)
        for row in rows:
            self.assertEqual(len(row), 5)

    def test_three_days(self):
        sim = self.sim
        tom = sim.agents["tom"]
        self.assertTrue(people.prompt(sim, tom, "crush", {"with": self.adults[0].id}))
        fork = people.PROMPTS["crush"](sim, tom, {"with": self.adults[0].id})
        msg = sim.fork_message(tom, fork)
        self.assertEqual(len(msg["options"]), 4)
        self.assertTrue(msg["about"][0].startswith(self.adults[0].name))
        json.dumps(msg)
        fork_msgs = 0
        died = False
        for minute in range(3 * DAY):
            sim.step()
            _, _, outbox = sim.drain()
            for _, m in outbox:
                json.dumps(m)
                if m.get("type") == "fork":
                    fork_msgs += 1
                    fork = sim.forks[m["fork_id"]]  # the controller answers at once (no real seconds pass here)
                    self.server._controller("c1", {"type": "choose", "fork_id": m["fork_id"],
                                                   "choice": sim.default_choice(fork), "reason": "fine"})
            if minute % 60 == 0:
                self.check_invites()
            if minute % DAY == 12 * 60:
                self.queries(minute // DAY + 1)
            if minute == DAY + 15 * 60 and not died:
                hila = sim.agents["hila"]
                friends = [oid for oid in hila.relationships if people.is_folk_id(oid)]
                self.assertTrue(friends)
                sim._die(hila, "dies suddenly")
                died = True
                for oid in friends:
                    page = self.server._god({"type": "get_agent", "agent_id": oid})
                    json.dumps(page)
            if minute == 2 * DAY + 16 * 60:
                noa = sim.agents["noa"]
                mate = forks._playmate(sim, noa)  # a townsperson classmate is never a playmate by invite
                self.assertTrue(mate is None or mate.id in sim.agents)
                opt = forks._play(sim, noa)
                self.assertEqual(len(opt.steps), 1)
                for builder in (forks.lonely_fork, forks.free_time_fork):
                    f = builder(sim, noa)
                    if f is not None:
                        json.dumps(sim.fork_message(noa, f))
        self.assertTrue(died)
        self.assertGreater(fork_msgs, 0)
        self.assertGreater(sim.social.counts["talks"], 3 * 1000 * 3)
        self.check_invites()
        for p in people.everyone(sim):
            self.assertLessEqual(len(p.relationships), people.REL_CAP)


if __name__ == "__main__":
    unittest.main()
