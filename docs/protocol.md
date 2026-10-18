# GameOfAILife WebSocket protocol

This is the complete reference for the one WebSocket endpoint the game server
exposes, for this build (v3). The server starts the `region` world by default:
Millbrook (v2's 80 x 50 tile town, its 7 districts, 37 homes, about 60 named
characters and 8 buses) in the north-west corner of a 256 x 192 tile region of
17 districts, two railway lines and about 1,000 townsfolk who live default
lives. `--world millbrook` (or `--folk 0` for a region with nobody else in it)
runs v2's town alone, with the same messages: the region's fields are empty
there, as each section says. Both worlds have God's dashboard (the wealth
ranking, News and the LLM decisions log), the housing market, and v3's social
life, illness, births, deaths, careers and weekly money for everyone.
Everything here is taken from `gameofailife/server.py`, `gameofailife/ws.py`,
`gameofailife/sim.py`, `gameofailife/forks.py`, `gameofailife/housing.py`,
`gameofailife/stats.py`, `gameofailife/chronicle.py`,
`gameofailife/transit.py`, `gameofailife/region.py`, `gameofailife/rail.py`,
`gameofailife/folk.py`, `gameofailife/people.py`, `gameofailife/social.py`,
`gameofailife/life.py`, `gameofailife/career.py` and `gameofailife/money.py`.
If this document and the code disagree, the code is right and this document
has a bug. `tests/test_integration.py` records a session from a running server
and checks that every field name it sees is written down here.

- [Connecting](#connecting)
- [Message basics](#message-basics)
- [Hello and welcome](#hello-and-welcome)
- [God messages](#god-messages)
- [Controller messages](#controller-messages)
- [Server pushes](#server-pushes)
- [Slow clients and coalescing](#slow-clients-and-coalescing)
- [Errors](#errors)
- [Answer windows: 5 seconds and 10 seconds](#answer-windows-5-seconds-and-10-seconds)
- [One God per city](#one-god-per-city)
- [Shared shapes](#shared-shapes)
- [Region map](#region-map)
- [Trains](#trains)
- [Townsfolk](#townsfolk)
- [Life](#life): [Social](#social), [Life, work and money](#life-work-and-money)
- [View data](#view-data)
- [Hidden information](#hidden-information)
- [Worked example](#worked-example)

## Connecting

Start the server with `python3 -m gameofailife` (options: `--host`, default
`127.0.0.1`; `--port`, default `8000`, `0` for any free port; `--seed`,
default `1`; `--speed`, one of `0 1 2 4 8 16`). It prints the address to open.
The same port serves two things:

- `http://host:port/` serves the web client from `client/` (the God view).
- `ws://host:port/ws` is the WebSocket endpoint. Any path other than `/ws`, or a
  request without `Upgrade: websocket`, is treated as a static file request.

The WebSocket is plain RFC 6455 with no subprotocol and no authentication:
anyone who can reach the port can be God or play characters. Only `ws://` is
served (no TLS). `gameofailife/ws.py` has a small stdlib client,
`connect("ws://127.0.0.1:8000/ws")`, that tests and example controllers can use.

The upgrade is checked against other sites' pages and DNS rebinding. Its
`Host` must be `localhost` or an IP address, with any port: an upgrade whose
`Host` is a DNS name, or that has no `Host`, gets `403 Forbidden` and is closed,
since whoever runs a name's DNS could point it at this machine. A browser also
sends an `Origin` header, and the origin's host and port must be exactly the
request's `Host`, or the upgrade gets the same 403. So the God page served from
this port connects, and so do a friend's browser and controllers that use your
IP address (`http://192.168.1.20:8000`, `ws://192.168.1.20:8000/ws`). A page
from another site cannot connect, and neither can anything that comes through a
DNS name such as `mypc.local`: use the IP address instead. Clients that send no
`Origin`, such as the Python and Node controllers, need only the `Host` rule.
When `--host` is a DNS name, the startup message gives the address it resolved
to.

The request line and headers must arrive within 10 seconds, with at most 100
header lines and 16 KiB of them. A slower request is closed. A longer one gets
`431 Request Header Fields Too Large` and is closed. Once the upgrade is done,
the WebSocket session has no time limit.

Two roles share the endpoint. The first message you send picks yours:

| Role         | Who                                  | Can do                                                    |
|--------------|--------------------------------------|-----------------------------------------------------------|
| `god`        | The player's web view                | Watch the whole city, read every page and the statistics, change luck, speed and profiles |
| `controller` | Anything that plays characters (an LLM, a script, a person) | Claim characters, answer their forks, query them, send messages and invites |

## Message basics

- Every message in both directions is one JSON object in one text frame.
  Binary and fragmented frames are accepted and decoded as UTF-8. The server
  reads at most 64 KiB (65,536 bytes) of one message from a client. A bigger
  message, up to 4 MiB, is read past without being unmasked or parsed and gets
  the `message too large` error (see [Errors](#errors)) with no `req_id`, as
  the server never read one; the connection stays open. A frame or message over
  4 MiB gets a close frame with code 1000 and the server closes the connection.
  A single frame over 4 MiB is refused from its header, so the rest of it is
  never read, and closing with that data unread may reset the connection after
  the close frame. A client still sending the frame may see only the reset; one
  that reads while it sends gets the close frame first.
  No client message needs more than a few KB, since the server keeps at most
  1000 characters of a prompt, 500 of a text and 300 of a reason. The server's
  own messages can be bigger: God's welcome passes 100 KB after a few game
  days. The `gameofailife/ws.py` client accepts up to 4 MiB.
- Pings get a pong with the same payload. Control frames (ping, pong, close)
  carry at most 125 bytes and are never fragmented (RFC 6455 5.5): a longer or
  fragmented one fails the connection with close code 1002.
- Every message has a `type` field.
- A frame that is not valid JSON gets `{"type": "error", "error": "messages must be JSON"}`
  and the connection stays open. That includes a frame that is not valid UTF-8,
  a number too long to parse and nesting too deep to parse.
- A frame that is valid JSON but not an object (an array, a number, a string,
  `null`) gets `{"type": "error", "error": "messages must be JSON objects"}` and
  the connection stays open.
- Until you have said `hello`, every message gets
  `{"type": "error", "error": "say hello first"}`.
- **`req_id`**: if a client message has a `req_id` field (any JSON value), the
  server copies it unchanged into the direct reply to that message, errors
  included. That covers the `welcome` and the errors before `hello` too. Only
  `messages must be JSON` and `messages must be JSON objects` never carry one,
  since the server could not read the message. Pushes never carry a `req_id`,
  which is how a `get_stats` reply (with the `req_id` you sent) can be told
  from a [`stats` push](#stats-push) of the same type. The one exception: a
  `req_id` nested too deeply for the server to write back (on Python 3.11, a
  few levels short of the roughly 1000 it can read) is left out, and the reply
  arrives without it. A reply that echoes another field nested that deeply is
  replaced by
  `{"type": "error", "error": "bad message: nested too deeply to echo back"}`.
- A message whose fields have the wrong type usually gets
  `{"type": "error", "error": "bad message: <detail>"}` (the server catches
  `ValueError`, `TypeError`, `KeyError`, `AttributeError` and `OverflowError`,
  so a number too big to use gets this too). A controller `hello` whose
  `characters` is neither a list, `"all"` nor an empty value (for example `5`
  or `"dana"`) gets `{"type": "error", "error": "bad hello: ..."}` and may say
  hello again (see [Bad hello](#bad-hello)). A `set_profile` `prompt` that is
  not a string, or `traits` that is not an object, is ignored.
- Each request gets at most one direct reply, sent right away (paced
  `send_message` and `invite` requests wait their turn first, see below).
  Pushes (state frames, `stats` pushes, forks, messages) are queued by the
  server's frame loop, which runs every 50 ms, and each client's pushes are sent
  in order. So a direct reply can arrive before a push that the same request
  caused: `send_message` replies `sent` before the recipient's controller gets
  the `message` push.
- **Pacing.** `send_message` and `invite` share one allowance per controller
  connection: a burst of 100, then 20 a second (the burst refills at that rate
  while you send fewer). Nothing is refused. Over the pace, the server waits
  before handling the next one and reads nothing else from your connection
  meanwhile, so your other requests, `choose` included, queue behind it. For
  example, 140 texts sent at once get their first 100 replies right away and the
  other 40 over the next 2 seconds.
- **Slow clients.** A slow client never holds up the city or other clients.
  The server hands each push to the connection while the network buffers have
  room, whether or not the client is reading, and keeps the rest queued for
  that client. A state frame or `stats` push still waiting is merged with the
  next one of its kind, texts (`message` pushes) that wait too long are skipped
  and reported with `messages_skipped`, and a client is disconnected only when
  a fork, `invite_answer` or `demoted` push has waited more than 5 seconds, or
  one send has taken that long. See
  [Slow clients and coalescing](#slow-clients-and-coalescing). A disconnected
  client gets no close frame: the server closes its end, and data already in
  the operating system's buffers may still arrive, followed by an EOF. As with
  any disconnect, a dropped controller's characters are released, and if the
  dropped view was God, the city has no God until the next God `hello`.

## Hello and welcome

### God

```json
{"type": "hello", "role": "god"}
```

Reply:

```json
{
  "type": "welcome",
  "role": "god",
  "town": { ...town... },
  "state": { ...state, with lots and homes... },
  "history": [ ...event, up to the last 80... ],
  "news": [ ...event of importance 1 or 2, up to the last 120... ],
  "headlines": [ ...event of importance 2, up to the last 20... ],
  "llm_log": [ ...decided fork, up to the last 80... ],
  "host": {"kind": "server", "controllers": true},
  "stats": { ...stats, full... },
  "speed": 1
}
```

| Field       | Meaning |
|-------------|---------|
| `town`      | The static map, sent once. See [Town](#town). |
| `state`     | The current snapshot, always with `lots` and `homes`. See [State](#state). |
| `history`   | The last 80 [events](#event) of any importance, oldest first, so a new view can fill its log. |
| `news`      | The last 120 events of importance 1 (notable) or 2 (major), oldest first: the News tab. |
| `headlines` | The last 20 events of importance 2, oldest first: the major news the view shows as toasts and in its ticker. |
| `llm_log`   | The last 80 [decided forks](#decided-fork) that a controller was asked about (`decided_by` `model` or `timeout`), oldest first: the LLM decisions log. Older ones come with [`get_decisions`](#get_decisions). |
| `host`      | What the view is talking to: `kind` is always `"server"` here and `controllers` is `true` (this host takes controller connections, so the view shows its AI players' parts). |
| `stats`     | The [stats object](#stats-object) with `full: true`: every kept hourly sample. |
| `speed`     | Current speed multiplier, one of `0 1 2 4 8 16`. |

If another God view is already connected, it is demoted (see
[One God per city](#one-god-per-city)).

### Controller

```json
{"type": "hello", "role": "controller", "name": "my-bot", "model": "claude-haiku-5-5", "characters": ["ari", "tom"]}
```

| Field        | Required | Meaning |
|--------------|----------|---------|
| `name`       | no       | Your controller name, cut to 40 characters. Default `"controller"`. If the name is taken by a connected controller, the server appends `-2`, `-3`, ... until it is free. The final name is in the welcome. |
| `model`      | no       | The model behind the controller (any value, turned into a string and cut to 60 characters). Shown to God only: in `stats.llm.controllers` and in the `model` field of the forks this controller is asked. Characters never see it. A later `claim` keeps it. |
| `characters` | no       | A list of character ids to claim, or the string `"all"` to claim every living character no other controller holds. Default: claim nothing. Characters that are dead, unknown, or held by another controller are skipped without an error. A repeated id counts once. |

Reply:

```json
{
  "type": "welcome",
  "role": "controller",
  "name": "my-bot",
  "characters": ["ari", "tom"],
  "profiles": {
    "ari": "Ari Ben-David, 24, junior developer. Takes work lightly, sticks to routine, careful with money, looks after their health.",
    "tom": "Tom Levi, 29, barista. Values independence, loves company, ignores their health, takes work lightly."
  },
  "answer_seconds": 5,
  "time": "Day 1 Mon 06:01",
  "available": ["dana", "yossi", "noa", "..."]
}
```

| Field            | Meaning |
|------------------|---------|
| `name`           | Your final controller name (possibly with a `-N` suffix). |
| `characters`     | The ids you actually claimed. |
| `profiles`       | For each claimed id, the character's profile prompt: a plain-language description of how they play. |
| `answer_seconds` | Always `5`: real seconds you have to answer a fork. |
| `time`           | Game time, see [Time stamps](#time-stamps). |
| `available`      | Ids of living characters that no controller holds (after your claims). You can `claim` these. |

The controller is registered as soon as it says hello, with or without
characters: it appears in `stats.llm.controllers` until its connection closes.
For the characters the hello claims, the server logs one God-only
[event](#event) for the whole hello, tag `controller_joined`, kind
`controller`, importance 1: `"Ari Ben-David and Tom Levi are now played by my-bot."`
(a long list reads `"Dana Cohen, Yossi Cohen, Noa Cohen and 57 others ..."`).
A hello that claims nothing logs no event.

### Bad hello

Any other `role` gets `{"type": "error", "error": "role must be god or controller"}`
and the server closes the connection (close code 1000). Open a new connection
to try again.

A controller `hello` whose `characters` is not a list or `"all"` and not an
empty value (a number other than 0, a string other than `"all"`, `true`, or a
non-empty object) gets
`{"type": "error", "error": "bad hello: characters must be a list of ids or \"all\""}`
instead. Nothing is claimed or registered, the connection stays open and you
may say `hello` again. A missing `characters`, or one that is `null`, `0`,
`false`, `""` or `{}`, claims nothing, like an empty list: the `welcome` has
`"characters": []`.

Sending `hello` again after the welcome does not change your role; it gets
`unknown message type 'hello'`.

## God messages

Sent by a connection whose hello had `role: "god"`. `get_agent`, `get_home`,
`get_stats`, `get_folk` and `get_decisions` read and change nothing, and also work from a
watching (demoted) view; the others are God's alone (see
[One God per city](#one-god-per-city)).

### `set_luck`

God's only power over a character's life. Luck is 0 to 100 and starts at 50.
It shifts the hidden odds of every good and bad outcome; nobody, including God,
ever sees the odds themselves.

```json
{"type": "set_luck", "agent_id": "dana", "luck": 80}
```

| Field      | Meaning |
|------------|---------|
| `agent_id` | Character id. |
| `luck`     | A JSON number (integer or decimal). Clamped to 0..100. Default 50 if missing. |

Reply:

```json
{"type": "luck_set", "ok": true, "agent_id": "dana", "luck": 80.0}
```

`ok` is `false` and `luck` is `null` for an unknown id. Dead characters still
accept luck. A `luck` that is not a finite JSON number gets
`{"type": "error", "error": "bad message: luck must be a number"}` and changes
nothing: that includes numeric strings such as `"80"`, `true` and `false`,
`null`, `NaN` and `Infinity`. An integer too big to turn into a decimal gets a
`bad message` error too. The new luck shows in the `luck` field of the
character in the next [state frame](#state-frame) and in `stats.city.luck`.

### `set_speed`

```json
{"type": "set_speed", "speed": 4}
```

`speed` must be one of `0 1 2 4 8 16`; any other integer sets speed `1`. A
non-integer string, `NaN` or `Infinity` gets a `bad message` error; a float is
truncated (`2.7` is `2`). Speed `1` is one game day per ten real minutes (2.4
game minutes per real second); `0` is paused.

Reply: `{"type": "speed", "speed": 4}`

### `pause`

```json
{"type": "pause"}
```

Sets speed to 0. Reply: `{"type": "speed", "speed": 0}`

While paused the simulation does not step, but the real-time fork clock keeps
running: forks still time out after 5 seconds. See
[Answer windows](#answer-windows-5-seconds-and-10-seconds).

### `resume`

```json
{"type": "resume"}
```

Sets speed to 1 if it was 0; otherwise leaves it. Reply:
`{"type": "speed", "speed": 1}`. (Pause does not remember the previous speed.)

Speed changes are only replied to the sender. Other viewers see the new speed in
the `speed` field of the next [state frame](#state-frame), which does not come
while paused unless something happens.

### `get_agent`

The full character page.

```json
{"type": "get_agent", "agent_id": "dana"}
```

Reply: `{"type": "agent", "agent": { ...agent page... }}`, see
[Agent page](#agent-page). Unknown id:
`{"type": "error", "error": "unknown character"}`.

### `get_home`

One home's page: who lives there, its condition, listing and history. The view
opens it from the map, from a person's home and from the market.

```json
{"type": "get_home", "home_id": "birch_court_2b"}
```

`home_id` is a home id from `town.homes` (a house's id is its place id, such
as `main_20`; a flat's is the block and unit, such as `birch_court_2b`).
Reply: `{"type": "home", "home": { ...home page... }}`, see
[Home page](#home-page). Unknown id (a block of flats' place id included):
`{"type": "error", "error": "unknown home"}`.

### `get_stats`

The city's statistics now, with every kept sample.

```json
{"type": "get_stats"}
```

Reply: the [stats object](#stats-object) itself, `{"type": "stats", "full": true, ...}`,
the same shape as the welcome's `stats` and the [`stats` push](#stats-push).
Asking does not change what the next push carries.

### `get_folk`

The roster of the townsfolk (see [Townsfolk](#townsfolk)): one row for every
townsperson ever generated, alive or not, in `i` order.

```json
{"type": "get_folk"}
```

Reply: `{"type": "folk", "v": 12, "rows": [ ...rows... ]}`. `v` is the folk
version, the same number as `stats.folk.v`: it goes up when someone is born,
dies, arrives, leaves or moves home, so a view asks again only on a new `v`.
Without townsfolk (`--folk 0` or the `millbrook` world) `v` is 0 and `rows` is
`[]`. Each row:

| Field      | Meaning |
|------------|---------|
| `i`        | The townsperson's index: the `i` of `state.crowd` and the position in the `stats.folk` arrays. |
| `id`       | Their id, `"f"` and `i` (`"f17"`), for `get_agent` and `set_luck`. |
| `name`     | Their full name. |
| `age`      | Age in years. |
| `child`    | `true` under 18. |
| `hh`       | Their household's id (`"fh3"`). |
| `home`     | The household's home id (a `town.homes` id), or `null`. |
| `place`    | The place id they are in or heading for now, or `null`. |
| `district` | The district id of their home, or `null`. |
| `job`      | Job title, or `null`. |
| `work`     | The place id of the job, or `null`. |
| `alive`    | `false` once they have died or left the region. |

### `get_decisions`

A page of the LLM decisions log: decided forks a controller was asked about
(`decided_by` `model` or `timeout`), newest first.

```json
{"type": "get_decisions", "agent_id": "dana", "before": "f812", "limit": 30}
```

| Field      | Meaning |
|------------|---------|
| `agent_id` | Optional. A character id: that character's own log (their last 30 such forks). Missing or `null`: the whole city's log (the last 500). |
| `before`   | Optional fork id: only forks older than it. A fork id that is no longer in the log (or never was) gives an empty page. Must be a string: anything else gets `bad message: before must be a fork id`. |
| `limit`    | Optional number of forks per page, default 30, held to 1..100 (a decimal is truncated). Anything but a finite number (or `null`) gets `bad message: limit must be a number`. |

Reply:

```json
{"type": "decisions", "agent_id": "dana", "forks": [ ...decided fork, newest first... ], "more": true}
```

`agent_id` is the id you asked for (as a string), or `null` for the city's log.
`more` says whether older forks remain: ask again with `before` set to the
last fork's `id`. Unknown `agent_id`: `{"type": "error", "error": "unknown character"}`.

### `set_profile`

Edit a character's default play style. The profile is what the Decision
Director plays when no controller answers.

```json
{"type": "set_profile", "agent_id": "dana", "prompt": "Dana is saving for a house and never eats out.", "traits": {"thrift": 0.9}}
```

| Field      | Meaning |
|------------|---------|
| `agent_id` | Character id. |
| `prompt`   | Optional string. If non-blank it replaces the prompt (trimmed, cut to 1000 characters) and marks the prompt as hand-edited, so it stops being rewritten automatically. `null` or blank leaves the prompt alone. |
| `traits`   | Optional object of trait name to number. Known traits are `thrift`, `family`, `social`, `diligence`, `health`, `adventure`; values are clamped to 0..1. Unknown names are ignored. A value that cannot be read as a number (for example `"lots"` or `null`) gets a `bad message` error, and then no trait changes. If traits change and the prompt was never hand-edited, the prompt is regenerated from the traits. Traits set here are where learning starts from afterwards (learning moves a trait at most 0.25 from them). |

Reply: `{"type": "agent", "agent": { ...agent page... }}` with the updated page.
Unknown id: `{"type": "error", "error": "unknown character"}`.

### God's other messages

Any other `type` gets `{"type": "error", "error": "unknown message type <type>"}`,
where `<type>` is the server's `repr` of the value: quoted for a string
(`unknown message type 'hello'`) and `None` for a message with no `type`.
Controller messages (`choose`, `claim`, `query`, ...) sent on a God connection
get this error too, as does a `type` that is a JSON array or object.

## Controller messages

Sent by a connection whose hello had `role: "controller"`. You can only act for
characters you hold; `query`, `send_message` and `invite` for anyone else get
`{"type": "error", "error": "not your character"}`.

### `choose`

Answer a [fork](#fork).

```json
{"type": "choose", "fork_id": "f5", "choice": 0, "reason": "Ari is a good friend."}
```

| Field     | Meaning |
|-----------|---------|
| `fork_id` | From the fork push. |
| `choice`  | Integer option index, 0 to 3. Must be a JSON integer: `"1"` or `1.0` is rejected. |
| `reason`  | Optional string, cut to 300 characters. Shown to God with the decided fork (in the state frame, the LLM decisions log and the agent page) and saved in what the profile learned. |

Reply is an `ack`. Its fields depend on the result:

| Result | Reply |
|--------|-------|
| In time (within 5 s): the choice is played and teaches the profile. | `{"type": "ack", "fork_id": "f5", "accepted": true, "applied": true}` |
| Late (5 to 10 s, after the default was played), and the first late answer for this fork: the choice is not played but still teaches the profile. | `{"type": "ack", "fork_id": "f5", "accepted": true, "applied": false, "note": "too late to act on; saved to the profile"}` |
| Fork already decided by an earlier answer, a late answer for it was already saved, or the late window is closed. | `{"type": "ack", "fork_id": "f5", "accepted": false, "error": "too late"}` |
| Unknown or forgotten fork id (forks are forgotten 10 s after they were asked). | `{"type": "ack", "fork_id": "f5", "accepted": false, "error": "unknown fork"}` |
| The fork's character is not yours (for example you released it). | `{"type": "ack", "fork_id": "f5", "accepted": false, "error": "not your character"}` |
| The fork's character has died. Nothing is played for the dead: their open fork stops being asked. | `{"type": "ack", "fork_id": "f5", "accepted": false, "error": "character is dead"}` |
| The fork was withdrawn: an `invite` fork whose host died while it was being asked. Nothing is played, and the guest moves on to their next decision. | `{"type": "ack", "fork_id": "f5", "accepted": false, "error": "fork withdrawn"}` |
| `choice` is not an integer 0 to 3. | `{"type": "ack", "fork_id": "f5", "accepted": false, "error": "choice must be 0 to 3"}` |

A withdrawn fork never reaches God's view, since nothing decided it; it is
counted in `stats.llm` as `withdrawn`.

Note that a rejected `choose` is still an `ack` with `accepted: false`, not an
`error` message.

### `claim`

Take over a character.

```json
{"type": "claim", "agent_id": "dana"}
```

Reply:

```json
{"type": "claimed", "agent_id": "dana", "ok": true, "profile": "Dana Cohen, 38, software engineer. ..."}
```

`ok` is `false` and `profile` is `null` if the character is unknown, dead, or
held by another controller. Claiming a character you already hold returns
`ok: true` and changes nothing. Claiming a new one logs a God-only
`controller_joined` event, importance 1: `"Dana Cohen is now played by my-bot."`

### `release`

Give a character back to its profile.

```json
{"type": "release", "agent_id": "dana"}
```

Reply: `{"type": "released", "agent_id": "dana"}`. The reply is the same
whether or not you held the character; only characters you hold are released.
Releasing one logs a God-only `controller_left` event of importance 0
(`"Dana Cohen is no longer played by my-bot."`). If the character was waiting
on a fork, that fork is no longer yours to answer and times out to the default.

All your characters are released when your connection closes, with one
`controller_left` event of importance 1 for all of them, and the controller
leaves `stats.llm.controllers`.

### `query`

Ask what one of your characters owns, is, or knows, or what is on the market.

```json
{"type": "query", "agent_id": "ari", "what": "possessions"}
```

Reply:

```json
{"type": "answer", "agent_id": "ari", "what": "possessions", "data": { ... }}
```

`what` defaults to `"attributes"`. An unknown value gets
`{"type": "error", "error": "what must be one of ['attributes', 'inbox', 'market', 'memory', 'people', 'possessions', 'relationships', 'world']"}`.

| `what`          | `data` |
|-----------------|--------|
| `possessions`   | What the character owns: see [Possessions](#possessions). |
| `attributes`    | `{"age", "health", "mood", "needs": {"hunger", "energy", "social", "fun"}, "reputation", "job": job or null, "traits": {trait: 0..1}}`. Health, mood, needs and reputation are rounded to integers on a 0..100 scale. See [Job](#job). |
| `relationships` | Object of other person id (a character, or a townsperson such as `f17`) to `{"id", "name", "named", "kind", "affinity", "trust", "romance", "married"}`. `named` is false for a townsperson; `kind` is `partner`, `family`, `friend`, `coworker` or `acquaintance` (and the kinds of [Social](#social)); `affinity` is -100..100; `trust` and `romance` are 0..100; `married` is a boolean. |
| `memory`        | List of up to the last 30 memory strings, each `"<time stamp>: <text>"`. |
| `inbox`         | List of up to the last 20 `{"time", "from", "text"}`; `from` is a character id. Messages and invites land here. |
| `world`         | `{"time", "season", "weather", "places": {place id: {"name", "kind", "district", "open": bool}}, "timetable"}`. `district` is a district id (see [Town](#town)); `open` is whether the place is open this hour. See [Timetable](#timetable). |
| `people`        | Object of living character id to full name. |
| `market`        | The vacant homes on the market: `{"for_sale": [{"home", "name", "tier", "district", "bedrooms", "price", "stage_name"}], "for_rent": [{"home", "name", "tier", "district", "bedrooms", "rent", "stage_name"}]}`, in `town.homes` order. `home` is the home id, `price` the asking price in dollars, `rent` the weekly rent, `stage_name` how run-down it is (see [Housing](#housing)). A listing held for someone's offer, or just snapped up by another buyer, is left out. The answer is the same whichever of your characters asks. |

The answer never contains hidden odds. Characters decide to move house through
their `house_hunt` and `housing_trouble` forks, not through a message: `market`
is for reading only.

### `send_message`

One of your characters texts another character.

```json
{"type": "send_message", "agent_id": "ari", "to": "tom", "text": "Coffee later?"}
```

`text` is cut to 500 characters. Reply: `{"type": "sent", "ok": true}`, or
`{"type": "sent", "ok": false, "error": "unknown or dead character"}` when either
side is unknown or dead, or
`{"type": "sent", "ok": false, "error": "can't message yourself"}` when `to` is
the sending character. `send_message` is [paced](#message-basics) together
with `invite`.

On success the text lands in the recipient's inbox (which keeps 30), both
characters gain a little social need, an event of tag `text` (kind `message`)
is logged, and the recipient's controller, if any, gets a [`message`](#message)
push, unless that controller is falling behind (see
[Slow clients and coalescing](#slow-clients-and-coalescing)).

### `invite`

One of your characters invites another to meet at a place.

```json
{"type": "invite", "agent_id": "ari", "to": "tom", "place": "cafe"}
```

`place` is a place id and defaults to `"cafe"`. Reply:

```json
{"type": "invited", "ok": true,
 "invite": {"id": "i1", "from": "ari", "to": "tom", "place": "cafe", "tick": 361, "status": "pending"}}
```

`ok` is `false` and `invite` is `null` if the guest is unknown, dead or the
inviting character itself, if your character is dead, or if the place does not
exist. `invite` is [paced](#message-basics) together with `send_message`.

The guest gets `"Want to meet at <place name>?"` in their inbox. The guest's
controller gets **no** direct push for the invite: the next time the guest is
free, they meet an `invite` fork (accept, decline, suggest another day, ignore),
which reaches their controller as a normal [fork](#fork) unless the Director
decides it from habit. The guest only meets that fork between 06:00 and 22:00
(and before 19:00 for characters under 18, who stay home after curfew), not
while they should be setting off for a shift (counting the trip by way of the
invite's place), and only if the place will be open when they get there. Until
then the invite waits. When the guest decides, your controller gets an
[`invite_answer`](#invite_answer) push. An invite not answered within 120 game
minutes expires silently (`status` becomes `"expired"`; nothing is pushed), so
an invite sent in the evening to a child, or to someone about to leave for
work, often expires before the guest sees it.

If the host dies, their pending invites expire at once, and a guest's `invite`
fork for one of them that is still being asked is withdrawn: its `choose` gets
`fork withdrawn`.

Characters also invite friends on their own. When a payday option to go out for
drinks with a friend or a lonely `"Invite <friend> to <cafe>"` option is chosen
(by habit, default, timeout or a controller), the character invites that friend
to the cafe (the invite's `place`) and heads there. The host's controller first
learns that invite's id from the `invite_answer` push, since the `choose` `ack`
carries none. Such an invite also expires as soon as the host stops hanging out
at the cafe.

### Controller's other messages

Any other `type` gets `{"type": "error", "error": "unknown message type <type>"}`,
where `<type>` is the server's `repr` of the value: quoted for a string
(`unknown message type 'hello'`) and `None` for a message with no `type`.
God messages (`set_luck`, `get_agent`, `get_home`, `get_stats`,
`get_decisions`, ...) sent on a controller connection get this error too.

## Server pushes

Messages the server sends without being asked. Views (God and watchers) get
state frames and `stats` pushes; controllers get forks, messages,
`messages_skipped` and `invite_answer`; a replaced God view gets `demoted`.

### State frame

To God (and watching views) only. Sent from the 50 ms frame loop whenever the
simulation advanced at least one game minute, or new events or decided forks
are waiting. At speed 1 that is about 2.4 frames a second; at higher speeds one
frame can cover several game minutes (at 16x about 20 frames a second, of one or
two minutes each). Nothing is sent while paused unless something happens (for
example a controller sends a message, or a fork times out).

```json
{
  "type": "state",
  "speed": 1,
  "state": { ...state... },
  "events": [ ...event... ],
  "forks": [ ...decided fork... ]
}
```

| Field    | Meaning |
|----------|---------|
| `speed`  | Current speed. |
| `state`  | The snapshot, see [State](#state). `lots` and `homes` are in it only when they changed: see below. |
| `events` | Every [event](#event) since the previous frame (possibly empty), oldest first. |
| `forks`  | Every fork decided since the previous frame, plus every earlier fork that changed since then: one of its hidden outcomes landed (a longer `happened`), or a late answer was saved for it (`late` filled in). See [Decided fork](#decided-fork). God sees forks only once decided, never while a controller is still thinking. A fork id appears at most once in a frame, but can come again in later frames: the later copy supersedes the earlier one. |

**The `lots` and `homes` rule.** The welcome's `state` always has both maps.
In state frames, `state.lots` is present only when it differs from the copy the
views were last sent, and so is `state.homes`; every 40th frame carries both
anyway. A frame without them means "unchanged": keep the last copy you got.
Each map is sent whole, never as a diff. A view that misses frames loses
nothing, since a merged frame keeps the older frame's maps when the newer one
has none (see [Slow clients and coalescing](#slow-clients-and-coalescing)).

### `stats` push

To God (and watching views) only: the city's statistics, for the dashboard's
ranking, charts and AI strip.

```json
{"type": "stats", "full": false, "tick": 1200, "time": "Day 1 Mon 20:00", "day": 0,
 "city": {...}, "llm": {...}, "districts": [...], "households": [...], "people": [...], "samples": [...]}
```

The shape is the [stats object](#stats-object), with `full: false`: `samples`
carries only the hourly samples recorded since the previous push (each sample
goes out in one push only), so append them to the ones from the welcome. All the
other blocks are the whole picture now.

**Cadence.** The frame loop checks every 50 ms. A push goes out when 3 real
seconds have passed since the last one and at least one game minute ran in
between, or as soon as 0.5 seconds have passed when a major event (importance 2)
happened in between. So a running city sends one push about every 3 seconds,
and a headline (a death, a move, a big win) is reflected in the ranking within
about half a second. Nothing is sent while the city is paused and nothing major
happens. All views get the same push. While no view is connected, samples are
not held back for later pushes: the next view's welcome has every kept sample.

### `fork`

To a controller, when one of its characters reaches a decision the Director
does not find obvious. (Obvious decisions are played from habit and never asked.
Characters without a controller play their profile default.)

```json
{
  "type": "fork",
  "fork_id": "f5",
  "agent_id": "tom",
  "kind": "invite",
  "question": "Ari Ben-David invites you to Corner Cafe. What do you do?",
  "options": [
    {"index": 0, "label": "Accept and meet Ari at Corner Cafe", "cost": 0.0, "travel_minutes": 21},
    {"index": 1, "label": "Decline politely", "cost": 0.0},
    {"index": 2, "label": "Suggest another day instead", "cost": 0.0},
    {"index": 3, "label": "Ignore the message", "cost": 0.0}
  ],
  "time": "Day 1 Mon 06:21",
  "deadline_seconds": 5.0,
  "weather": "rain",
  "season": "spring",
  "profile_scores": [0.62, -0.1, 0.35, -0.4],
  "you": {
    "name": "Tom Levi",
    "profile": "Tom Levi, 29, barista. Values independence, loves company, ignores their health, takes work lightly.",
    "money": 250.0,
    "needs": {"hunger": 66, "energy": 60, "social": 83, "fun": 86},
    "health": 90,
    "where": "main_28",
    "groceries_at_home": 8,
    "goal": {"name": "a guitar", "target": 450, "saved": 0.0},
    "recent_memory": [],
    "savings": 0.0,
    "where_name": "28 Main Street",
    "home_name": "28 Main Street",
    "home": {"name": "28 Main Street", "tier": "house", "tenure": "owned", "weekly_cost": 76,
             "condition": 66, "stage_name": "worn", "value": 13650},
    "household_funds": 3750
  }
}
```

| Field              | Meaning |
|--------------------|---------|
| `fork_id`          | Pass back in `choose`. Ids look like `f1`, `f2`, ... |
| `agent_id`         | Which of your characters is deciding. |
| `kind`             | One of `invite`, `work`, `hunger`, `sleep`, `repair`, `payday`, `groceries`, `housing_trouble`, `house_hunt`, `upkeep`, `lonely`, `free_time`. `house_hunt` (buy or rent a better home, haggle, take the cheaper one, or stay; "the cheaper" home costs less cash to move into, its renovation counted, or as much and less a week, and when no other home does, that option is "Keep looking for the right place"; a run-down house is bought with its renovation, done the day it is bought, and its options say so, as in `"Buy 28 River Road (house, neglected) for $14,550 and do it up ($880)"`; for a year after it has downsized, a household is not offered homes with more bedrooms unless it is crowded; an owner household that has outgrown its home, with everyone retired or two bedrooms to spare, is asked instead whether to downsize when nothing better is on the market, once it has lived there a while (from game day 90 for the households that start in their homes, 120 days after a move for the others), then every few weeks, more invitingly the longer it has had it in mind and while no house has been for sale for two weeks: sell up and buy smaller, sell up and rent, keep looking, or stay; a household that has downsized is not asked again for a year; tenants whose let house the landlord is selling are asked instead, in the same household evenings and weekend days, until they have moved: rent the best home to let they can carry, rent a cheaper one they can carry when one costs less a week, buy the house from the landlord when they can afford it (else talk it over and decide another time), or ask for more time, as in `"Rent the cheaper Birch Court, flat 1B (flat) for $220/week"`; every rental offered passes the same affordability gate as any `house_hunt` move, so a household that can carry none is offered to keep looking in those two places. From game day 120, while no house has been for sale for two weeks, the landlord gives one such household two weeks' notice, its sales at least 30 days apart and never to tenants who moved in during the last 120 days; whoever is still there when the notice runs out is moved to the cheapest home to let, and the house goes on the market then. Tenants who buy the house don't put off the landlord's sale: it gives the next let house's tenants notice at once, to move out by the same date, or within a week when less than that is left) and `housing_trouble` (the household is in the red after the week's bills, or its home is falling apart and the renovation costs more than it has) are major forks: the Director settles them by habit only on a clear lead, so they reach controllers more often. `repair` is an emergency at home (a burst pipe, a broken boiler, a leaking roof, an electrical fault) and `upkeep` a home that is looking worn (at weekends, and on weekday evenings too in a household's first week in a run-down home it has just moved into). |
| `question`         | The situation in plain language. |
| `about`            | Lines on who or what the fork is about, such as `["Lina Amar, 27, nurse at City Hospital."]`; often `[]`. |
| `options`          | Always exactly 4. `index` is what you send as `choice`; `label` is the option; `cost` is money spent up front; `travel_minutes` (game minutes, by the option's way of travel: a bus trip counts the walk to the stop, the wait, the ride and the walk from it) is present when the option starts somewhere other than where the character is now, and on an option that stops somewhere on the way to work (a coffee first, at a cafe or at home), where it counts the leg on to work too; an option goes by the character's usual way for that trip unless it says otherwise: the car if it is with them, else the bus when one leaving now saves 5 or more minutes on a walk of over 25 minutes, else on foot, and `travel_minutes` is timed by that way; a work fork offers a coffee only when it fits before the shift ("Have a coffee at work" for someone who works at that cafe), otherwise the cup at home or "Grab a bite to eat, then go"; `household: true` is present when the cost comes out of the household's pooled money (its adults' money and savings) rather than the character's own pocket, as for a move or a repair. Outcome odds are never included. Options only send the character to a place that will be open when they get there, and a paid outing only when the place stays open for all of it. If they reach a shut place anyway (for example because the clock ran on while the fork waited for an answer), nothing is served and the rest of the outing is off, though a shift still stands. A paid outing that would no longer fit before closing is called off the same way (`"finds <place> about to close ($N refunded)."`). When that place is the option's first stop, the `cost` comes back and that choice's hidden outcomes are dropped. |
| `time`             | Game time stamp. |
| `deadline_seconds` | Always `5.0`, real seconds. |
| `weather`          | `"clear"` or `"rain"`. |
| `season`           | `spring`, `summer`, `autumn` or `winter`. |
| `profile_scores`   | One number per option, in option order: how well it fits the character's play-style profile, as the Director scored it (higher fits better; the habit default is the highest). These are not outcome odds. A controller can show them to its model as hints or ignore them. |
| `you.name`, `you.profile` | The character and its profile prompt. |
| `you.money`        | The character's own money, two decimals; can be negative. |
| `you.savings`      | Money put aside (not counting a savings goal's pot), two decimals. |
| `you.household_funds` | The household's pooled money: its living adults' money plus savings, in whole dollars. Moves, repairs and housing costs are paid from it. |
| `you.needs`        | 0..100 each, higher is better (a high `hunger` means well fed). |
| `you.health`       | 0..100, an integer. |
| `you.where`, `you.where_name` | Place id the character is inside, or `"outside"`; and that place's name (or `"outside"`). |
| `you.home_name`    | The name of the character's home, such as `"Birch Court, flat 2B"`. |
| `you.home`         | `{"name", "tier", "tenure", "weekly_cost", "condition", "stage_name", "value"}`: the same fields as in [Possessions](#possessions). |
| `you.groceries_at_home` | Meals' worth of groceries in the household's fridge. |
| `you.goal`         | Savings goal `{"name", "target", "saved"}` or `null`. |
| `you.recent_memory`| Last 5 memory strings. |
| `you.life`         | `{"partner", "children", "conditions", "standing", "jobless_days", "debt"}`: see [Life, work and money](#life-work-and-money). |

While a fork is open the character's `state` and `activity` are `"deciding"`
and the character stands still, except at a work fork, where they set off at
once (see [Decisions](#decisions) below).

Some options move money besides their `cost`. In a `groceries` fork,
`"Ask <name> to do the shopping"` shows `cost` 0, but if that person is free
(idle or doing something leisurely, not asleep, working, deciding or due to
leave for work) they go to a market at once (the `errand` event names it), and
the groceries cost $35, paid by the shopper or, if the shopper has less than
that, by your character. If they are not free, nobody shops and nothing is paid.
A payday `"Put $<amount> toward savings"` option, offered to a character with
no savings goal, moves the money into `savings` (see
[Possessions](#possessions)). A move goes through only if the home is still free
when the household acts on it: otherwise the event says the household was too
late, and nothing is paid. A `"Take the No. <line> bus to work"` (or `to school`) option shows
the fare as its `cost` ($2 for ages 18 to 64, else 0), but the fare is paid only
when the character boards a bus, and not at all if they end up walking.

#### Decisions

These fork message keys, and the rules around them, describe how a character
decides and lives with the clock running while the controller thinks.

| Field | Meaning |
|-------|---------|
| `minutes_per_second` | Game minutes that go by per real second at the server's current speed (19.2 at speed 8). The server (and the browser port's host) tells the simulation its speed (`sim.speed`) when it starts and on `set_speed`, `pause` and `resume`; the field is absent while paused (and when a simulation runs without a server). A page can say "every second you take, about 19 minutes go by". |
| `options[i].home` | `true` when the option's first stop is the character's home. Its `travel_minutes`, if any, is the way home ("home in 12 min"), not a trip out. |
| `you.today` | What today holds, from the job's hours and `workdays`: `"work 09:00-17:00 (in 46 min)"`, `"work 09:00-17:00 (started 5 min ago)"`, `"work 09:00-17:00 (there now)"`, `"work 09:00-17:00 (not going today)"`, `"work done; next shift tomorrow 09:00"`, `"Day off; next shift Tue 16:00"`, or `"No work or school"`. For a pupil the word is `school` (`"Day off; next school Mon 08:00"`). |
| `you.recent` | The character's last 8 decided forks, oldest first, from the same record as [`get_decisions`](#get_decisions): `{"id", "time", "kind", "question", "label", "by", "happened"}`, where `label` is the option played, `by` is `model`, `habit`, `default` or `timeout`, and `happened` lists what came of it (the same strings as a decided fork's `happened`, which fills in as outcomes land, so a fork just decided may still show `[]`). |
| `you.payer` | For a child: `{"name", "money"}` of the household adult who pays for what the child can't cover (the one with the most money), else `null` (an adult, or a child with no adult at home). |

A work fork no longer freezes the character. As it is asked, the character
sets off on the option that matches their usual way to work (the profile's
provisional plan; option 0 when none matches). When the answer lands (or the
5-second window runs out), the decision is re-timed from where the character
now is: already at work means the way they went stands; otherwise the chosen
option plays if it is still on time, else the fastest option still on time (or
the fastest of all), and the decided fork's `reason` gets a note such as
`"already at work by then: Walk to work instead"` or `"too late for that by
then: Run to work instead"`. Hidden outcomes are rolled once, for the option
actually played, with its lateness odds re-timed for the minutes left. The
same rules hold however late the answer lands, so someone already at work keeps
working. A choice to stay home (calling in sick) stands; made after they got
in, it pays the minutes already worked. Other forks still wait with the character standing, but a fork still open when it is
time to leave for work is decided by its profile default (`by` `"timeout"`,
reason `"Time to leave for work; played the default."`).

Other rules in v3: no `lonely` or `free_time` fork opens inside a work fork's
window (from when the work fork can open until the shift starts); a pupil's
work fork offers breakfast at home (or a bite on the way out), never a cafe; a
`free_time` fork on Saturday from 17:00 to 20:00 can be the family's evening
(`"Treat <names> to dinner at <place>"`, only when a member is free and no child
under 10 would be left at home alone); a weekend `free_time` fork can offer
`"Buy something nice at <shop>"` ($40); a payday fork offers `"Buy <goal>
now"` when the cash on hand covers what is left of the goal (the goal is then
cleared, with a `goal_reached` event); and an invite's `"Ignore the message"`
scores below `"Decline politely"`, whose answer goes into the host's memory
(`"<name> declines my invite to <place>."`). A choice teaches the profile what
sets it apart from the fork's other options (its tags less the four options'
mean), not its own tags. In the event log, common outcomes read several ways,
and a routine good night, meal, rest or family dinner is kept only in the
decided fork's `happened` (a dinner out is its one `family_dinner` line, of
importance 0 like an accepted invite: the log, not the News).

### `message`

To the controller of the character that received a `send_message`.

```json
{"type": "message", "from": "ari", "from_name": "Ari Ben-David", "to": "tom",
 "text": "Coffee later?", "time": "Day 1 Mon 06:01", "agent_id": "tom"}
```

`agent_id` (equal to `to`) is the character of yours the push is for.

A controller that falls behind may not get every `message` push; see
[Slow clients and coalescing](#slow-clients-and-coalescing). The text is in the
character's inbox either way.

### `messages_skipped`

To a controller, after `message` pushes for one of its characters were skipped
because it was falling behind.

```json
{"type": "messages_skipped", "agent_id": "tom", "count": 37}
```

`count` texts to `agent_id` were not pushed since the last report. They are in
the character's inbox: `query` with `"what": "inbox"` returns the last 20, and
the inbox keeps the last 30, so with a `count` over 20 some of them can no
longer be read.

### `invite_answer`

To the controller of a character whose invite was just answered, including an
invite the character made on its own from a fork (see [`invite`](#invite)).

```json
{"type": "invite_answer", "invite_id": "i1", "from": "tom", "answer": "accept", "agent_id": "ari"}
```

`from` is the guest; `agent_id` is your character, the host. `answer` is
`accept`, `decline`, `later` or `ignore`.

### `demoted`

To the God view that has just been replaced by a newer one.

```json
{"type": "demoted", "reason": "another God view took over"}
```

The connection stays open and keeps receiving state frames and `stats`
pushes. See [One God per city](#one-god-per-city).

### `ack`

The reply to `choose`, described [above](#choose). Listed here because it is
the message a controller must watch for to learn whether its choice was played.

## Slow clients and coalescing

Each client's pushes are sent in order from that client's own queue, and a slow
client only holds up itself. The server hands a push to the connection while
the network buffers have room (it keeps at most 16 KiB unsent in the operating
system and in its own write buffer), and keeps the rest queued. A client that
falls behind is treated like this:

- **State frames merge.** A new state frame for a client that still has an
  unsent state frame queued is merged into it instead of queued behind it. The
  merged frame is the newer frame (its `speed` and `state`), with the older
  frame's `events` before the newer frame's, the older frame's `forks` with the
  newer copies replacing older copies of the same id in place (new ids
  appended), and the older frame's `state.lots` and `state.homes` kept when the
  newer frame has none. So a view that reads slowly gets fewer, fresher frames,
  has at most one waiting, and still sees every event and every fork.
- **`stats` pushes merge** the same way: the newer push, with the `samples` of
  both (one per tick, oldest first) and `full: true` if either was full.
- **Texts are skipped.** A `message` push is skipped instead of sent once it
  has waited 2.5 s, or 0.5 s with a push that matters (such as a fork) waiting
  behind it, so a fork does not wait behind a flood of texts. While the client
  is still taking a push queued 5 s ago, new texts are skipped at once. Skipped
  texts are reported with [`messages_skipped`](#messages_skipped) before the
  next push, or as soon as nothing else is waiting.
- **The 5 second rule.** Any other push (forks, `invite_answer`, `demoted`) is
  never skipped. A client is disconnected when one of those is still unsent
  after 5 s, or when a single send has taken more than 5 s while a push that
  matters (a state frame or `stats` push included) is being sent or waits, and
  a controller's characters are released. `message` pushes alone never get a
  client disconnected, and state frames and `stats` pushes waiting their turn
  never count against a client by themselves, so a view is not dropped for
  merely reading slowly.

A God view gets every text as an event in its state frames, which are never
skipped (only merged), so flooding controllers only make those frames longer.

## Errors

```json
{"type": "error", "error": "<human-readable reason>"}
```

Sent as the direct reply to a bad request (with its `req_id`, if any). The
connection stays open, except after a bad hello role. All error strings:

| `error` | When |
|---------|------|
| `messages must be JSON` | A frame was not valid JSON: also bad UTF-8, a number too long to parse, or nesting too deep. Never carries a `req_id`. |
| `messages must be JSON objects` | Valid JSON that is not an object (an array, a number, a string, `null`). Never carries a `req_id`. |
| `message too large: the most the server reads is 65,536 bytes, so it was dropped unread` | A message over 64 KiB and not over 4 MiB (see [Message basics](#message-basics)). Nothing in it is done. Never carries a `req_id`. |
| `say hello first` | Any message before `hello`. |
| `bad hello: <detail>` | A controller `hello` whose `characters` is neither a list, `"all"` nor an empty value (for example `5` or `"dana"`; see [Bad hello](#bad-hello)): `bad hello: characters must be a list of ids or "all"`. You may say `hello` again. |
| `role must be god or controller` | Bad hello role; the server closes the connection. |
| `bad message: <detail>` | A field had an unusable value. `<detail>` is the server's own description, for example `luck must be a number` for `"luck": "lots"`, `limit must be a number` and `before must be a fork id` from `get_decisions`, or the error for a number too big to use. |
| `bad message: nested too deeply to echo back` | The reply would echo a field nested too deeply to write (see `req_id` under [Message basics](#message-basics)). |
| `unknown message type <type>` | The type is not one your role can send. `<type>` is the server's Python `repr` of the value: quoted for a string (`unknown message type 'hello'`), `None` for a missing type or `null`, and bare for a number (`unknown message type 5`). |
| `unknown character` | `get_agent`, `get_decisions` or `set_profile` with an unknown id. |
| `unknown home` | `get_home` with an id that is not a home. |
| `not your character` | `query`, `send_message` or `invite` for a character you do not hold. |
| `what must be one of [...]` | `query` with an unknown `what`. |
| `only God can do that; this view is watching` | A watching (demoted) view sent `set_luck`, `set_speed`, `pause`, `resume` or `set_profile`. |

Some refusals are not `error` messages but come in the normal reply, with
`accepted` or `ok` false and an `error` field:

| Reply | `error` | When |
|-------|---------|------|
| `ack` | `unknown fork` | `choose` for an unknown or forgotten fork. |
| `ack` | `not your character` | `choose` for a fork whose character you do not hold. |
| `ack` | `character is dead` | `choose` for a fork whose character has died. |
| `ack` | `fork withdrawn` | `choose` for an `invite` fork whose host died while it was asked. |
| `ack` | `choice must be 0 to 3` | `choice` is not an integer 0 to 3. |
| `ack` | `too late` | The fork was already decided by your answer, already has a saved late answer, or its late window closed. |
| `sent` | `unknown or dead character` | `send_message` where either character is unknown or dead. |
| `sent` | `can't message yourself` | `send_message` to the sending character. |

`claimed` (from `claim`), `invited` (from `invite`) and `luck_set` (from
`set_luck`, for an unknown id) report a refusal with `ok: false` only, and no
`error` field. The frame-level failures in [Message basics](#message-basics) (a
frame or message over 4 MiB, a bad control frame, a push left waiting more than
5 seconds once the network buffers are full) close the connection instead of
sending an error.

## Answer windows: 5 seconds and 10 seconds

Both windows are real (wall-clock) seconds, measured from the moment the
Director asks, not game minutes. They do not depend on speed, and they keep
running while the game is paused.

1. **0 to 5 s.** A valid `choose` is played at once:
   `accepted: true, applied: true`. The fork is decided by `"model"`, the reason
   is kept, the answer's seconds go in `answer_seconds`, and the profile learns
   from the choice (traits move a little towards what sets the option apart from
   the fork's other options, and the prompt is regenerated unless it was
   hand-edited). Each lesson first eases every trait 3% of the way back to where
   it started, and learning never moves a trait more than 0.25 from there, so a
   controller's steady style shows while mixed choices leave the character
   itself.
2. **At 5 s** without an answer, the Director plays the profile default. The
   fork is decided by `"timeout"` and God sees it in the next state frame.
3. **5 to 10 s.** The first `choose` for a fork decided by timeout is not
   played, but it is saved and teaches the profile exactly as an in-time answer
   would: `accepted: true, applied: false`. The next fork of that kind is then
   more likely to go the way the controller wanted, even if the controller is
   slow. God sees it too: the fork comes again in the next state frame with
   `late` filled in (`{"choice", "reason", "seconds"}`), and it is counted in
   `stats.llm` as `late`.
4. **After 10 s** the server forgets the fork: `choose` gets `"unknown fork"`.

Only the first answer counts. A second `choose` for a fork already decided by
your earlier answer, or for one whose late answer was already saved, gets
`"too late"` and teaches nothing.

`decided_by` in a [decided fork](#decided-fork) tells God who made each call:

| `decided_by` | Meaning |
|--------------|---------|
| `habit`   | Obvious from the character's habits; nobody was asked. |
| `default` | No controller; played from the profile. |
| `model`   | The controller answered in time. |
| `timeout` | A controller was asked and did not answer in 5 s; the profile default was played. |

The LLM decisions log (`welcome.llm_log` and `get_decisions`) holds the `model`
and `timeout` ones; `stats.llm` counts all four.

## One God per city

There is one God per city. When a God hello arrives while a God view is already
connected, the newest view takes over: the old view is sent
[`demoted`](#demoted), keeps its connection, and keeps receiving state frames
and `stats` pushes as a watcher. When the current God view disconnects, nobody
is promoted; the next God hello takes over.

A watching view can only watch: `set_luck`, `set_speed`, `pause`, `resume` and
`set_profile` from it get `only God can do that; this view is watching` and
change nothing, while `get_agent`, `get_home`, `get_stats`, `get_folk` and
`get_decisions` still work.

Controllers are not limited: any number can connect, each holding its own set of
characters. A character is held by at most one controller at a time.

## Shared shapes

### Time stamps

`time` fields are strings like `"Day 3 Wed 14:05"`: the day number from 1, a
weekday from `Mon` to `Sun`, and the 24-hour time. One tick is one game minute.
The world starts on Day 1, Monday, 05:00 (tick 300), an hour before the earliest shifts. Seasons last 90 days.

### Town

Sent once in the God welcome. The layout and the places are the same for every
seed; the seed moves only the trees.

| Field       | Meaning |
|-------------|---------|
| `w`, `h`    | Map size in tiles: 80 x 50. |
| `tiles`     | `h` strings of `w` characters: `.` grass, `#` road, `B` building, `D` door, `P` park, `T` tree, `e` entry tile, `~` water (the river along the south edge; not walkable). |
| `places`    | Every place, see [Places](#places). |
| `districts` | The 7 districts: `[{"id", "name", "about", "rects"}]`. `about` is a short description; `rects` are the city blocks it covers, each `[x, y, w, h]` in tiles. Ids: `maple_grove`, `hilltop`, `downtown`, `eastgate`, `the_works`, `riverside`, `east_woods`. |
| `streets`   | The named streets: `[{"name", "axis", "at"}]`. A street with `axis` `"row"` runs east-west along `y = at`; one with `"col"` runs north-south along `x = at`. |
| `road_rows`, `road_cols` | The tile rows and columns that are streets. |
| `road_col_end` | The last row of the north-south streets: they stop at the riverbank. |
| `junctions` | The `[x, y]` tiles where streets cross, by row and then column. Each has traffic lights. |
| `homes`     | The 37 homes, see [Homes](#homes). |
| `housing`   | The housing vocabulary, see [Housing](#housing). |
| `stops`     | The bus stops: `[{"id", "name", "x", "y", "lines"}]`; `x`, `y` is the stop's road tile and `lines` the ids of the lines that call there. |
| `timetable` | See [Timetable](#timetable). |

#### Places

`{"id", "name", "kind", "x", "y", "w", "h", "entry", "face", "hours", "district", "style", "floors", "tier", "units"}`

| Field | Meaning |
|-------|---------|
| `id`, `name` | The place id (as used everywhere else) and its name. |
| `kind` | `home`, `office`, `bank`, `townhall`, `school`, `hospital`, `market`, `shop`, `cafe`, `works` or `park`. |
| `x`, `y`, `w`, `h` | The footprint in tiles. |
| `entry` | `[x, y]`: the walkable tile where people arrive; it always touches a road. |
| `face` | The wall with the door: `"n"`, `"s"`, `"e"` or `"w"`; `null` for parks. |
| `hours` | `[open, close]` hours, or `null` for always open (homes, parks, the hospital). |
| `district` | The district id. |
| `style` | The renderer's model: `house`, `big_house`, `apartments`, `tower`, `city_hall`, `bank`, `school`, `hospital`, `market`, `corner_shop`, `bakery`, `cafe`, `diner`, `noodle_bar`, `arcade`, `factory` or `park`. |
| `floors` | Building height in floors; 0 for parks. |
| `tier` | For homes, `flat` (a block of flats), `house` or `big_house`; `null` otherwise. |
| `units` | Homes inside: 1 for a house, 6 for a block of flats, 0 for everything else. |

#### Homes

`town.homes`: `[{"id", "place", "unit", "name", "tier", "bedrooms", "base_value", "rent"}]`.
A house is one home whose `id` is its place id and whose `unit` is `null`; a
block of flats is one place with six homes, ids like `birch_court_2b`, `unit`
like `"2B"` and names like `"Birch Court, flat 2B"`. `base_value` is the value
in kept condition, and `rent` the weekly rent when let (0 for a home the
landlord never lets). What changes (who lives there, the listing, the value) is
in `state.homes`; the condition is per place, in `state.lots`.

#### Housing

`town.housing`: `{"tiers": {tier id: {"label", "rank"}}, "stages": [{"name", "min"}], "landlord"}`.
The tiers are `flat` (rank 1), `house` (2) and `big_house` (3, label
`"big house"`). The stages, best first, are `kept` (condition 80 and up), `worn`
(60), `shabby` (40), `neglected` (20) and `derelict` (0): a place's `stage` is
the index of the first stage whose `min` its condition reaches. `landlord` is
the letting company's name, `"Millbrook Homes"`.

#### Timetable

```json
{"bus": {"lines": [{"id": "1", "name": "No. 1 (clockwise: Main Street east, Park Avenue west)",
                    "corners": [[3, 25], [68, 25], [68, 14], [3, 14]],
                    "stops": ["maple_west", "school", "..."], "lap_minutes": 52, "buses": 4,
                    "every_minutes": 13, "speed": 4, "dwell": 1, "fare": 2}, "..."]},
 "flights": ["08:00 Riverton to Lakeside", "14:00 Riverton to Lakeside", "20:00 Riverton to Lakeside"]}
```

Each bus line has an `id`, a `name`, the `corners` of its loop (tiles, in
driving order), its `stops` in calling order (stop ids), `lap_minutes` for one
loop, how many `buses` run it, a bus `every_minutes` at each stop, `speed` in
tiles a minute, `dwell` minutes at a stop and the `fare` in dollars. There are
two lines of four buses, round the same loop in opposite directions. `flights`
are the daily planes overhead, as text. The same timetable is in a
controller's `query` `world`.

### State

The live snapshot, in the God welcome and every state frame.

| Field     | Meaning |
|-----------|---------|
| `tick`    | Game minutes since the start of Day 1 00:00. |
| `time`    | [Time stamp](#time-stamps). |
| `minute`  | Minute of the day, 0..1439. |
| `day`     | Day number from 0 (the stamp shows it from 1). |
| `season`  | `spring`, `summer`, `autumn` or `winter`. |
| `weather` | `clear` or `rain`. |
| `lights`  | `{"ns": color, "ew": color}` for every junction: the north-south and east-west lights, each `green`, `yellow` or `red`. |
| `plane`   | `{"progress": 0..1, "from": "Riverton", "to": "Lakeside"}` during a flight, else `null`. |
| `buses`   | The 8 buses: `[{"id", "line", "x", "y", "dir", "at_stop", "riders"}]`. `id` is `1a` to `1d` and `2a` to `2d`; `x`, `y` the road tile; `dir` the heading, `n`, `s`, `e` or `w`; `at_stop` the stop id while it stands at a stop with its doors open, else `null`; `riders` the number of people on board (the characters whose `riding` is that bus). Positions are a pure function of the tick. |
| `agents`  | Every character, living or dead, see below. |
| `trains`  | The region's trains, every frame: `[{"id", "line", "track", "i", "x", "y", "dir", "at_station", "riders"}]` (see [Trains](#trains)); `[]` in the `millbrook` world. |
| `crowd`   | The townsfolk outdoors and not aboard anything, as one flat list of `[i, x, y, k, ...]` quadruples sorted by `i` (see [Townsfolk](#townsfolk)); `[]` with no townsfolk. |
| `occ`     | Who is in each place, townsfolk and named, in `town.places` order (a list of integers). In the welcome, then in a frame now and then (see [Townsfolk](#townsfolk)); a frame without it means unchanged. |
| `folk_n`  | How many townsfolk ids there are (`f0` to `f<folk_n - 1>`); 0 with none. |
| `talks`   | Talks begun in the last 10 game minutes, newest first, at most 20: `[[place_index, a_id, b_id, tone, tick], ...]` (see [Social](#social)); `[]` when nobody is talking. |
| `thinking` | The ids of the played characters whose controller has yet to answer, in `agents` order: standing on the question (`state` `deciding`), or already setting off for work the usual way while the work fork is still asked (see [`fork`](#fork)). The AI chip counts these, as `stats.llm.thinking` does; `[]` when nobody is thinking. |
| `lots`    | Only in the welcome and when changed (see [the rule](#state-frame)). Object of residential place id (a house or a block of flats) to `{"condition", "stage", "works", "moving"}`: `condition` 0..100 (a whole number that agrees with the stage), `stage` 0..4 (see [Housing](#housing)), `works` true while builders are on site (a repair, the landlord repainting, or a home bought run-down being done up) and `moving` true while a moving van stands outside after a move (3 game hours). |
| `homes`   | Only in the welcome and when changed. Object of home id to `{"hh", "owner", "listing", "price", "value", "emergency"}`: `hh` the household id living there or `null` (vacant); `owner` `"landlord"` (let by the landlord), `"market"` (for sale, nobody's yet: a home its owners sold, an estate, or a house the landlord sells when its tenants leave and no other house has been for sale for two weeks, or when the notice it gave its tenants runs out) or the owning household's id; `listing` `"for_sale"`, `"for_rent"` or `null` (also while it is under offer, and while a let house the landlord is selling with notice stands empty until the notice runs out); `price` the asking price for sale or the weekly rent to let, else `null`; `value` the market value in dollars (base value x (0.7 + 0.003 x condition), to the nearest $50); `emergency` the kind of a live emergency (`leak`, `boiler`, `roof` or `electrics`) or `null`. |

An agent in `agents`:
`{"id", "name", "x", "y", "inside", "state", "activity", "vehicle", "mood", "luck", "controller", "alive", "age", "home", "car", "riding", "ill", "stage"}`.

| Field | Meaning |
|-------|---------|
| `x`, `y` | The tile the character is on. |
| `inside` | The place id the character is inside, or `null` (on the map). |
| `state` | `idle`, `deciding`, `travelling`, `busy` or `dead`. |
| `activity` | What they are doing, such as `work` (pupils' school day too), `sleep`, `eat_home`, `hang_out`, `viewing` (a home), `move_house` or `deciding`. |
| `vehicle` | How they are moving: `walk`, `run`, `car`, `taxi`, `ambulance` or `bus` (a bus trip is `bus` from the walk to the stop to the walk from it; on board, `riding` names the bus). |
| `mood`, `luck` | Rounded to integers. |
| `controller` | The controller name, or `null`. |
| `alive`, `age` | As on the [agent page](#agent-page). |
| `home` | The home id of the character's household (see [Homes](#homes)). |
| `car` | Whether the character owns a car. |
| `riding` | The bus id while on board, else `null`. While riding, `x` and `y` are the bus's tile. |
| `ill` | Whether the character has an illness now (see [Life, work and money](#life-work-and-money)). |
| `stage` | The stage of life: `baby` (under 3), `child` (3 to 12), `teen` (13 to 17), `adult` (18 to 64) or `senior` (65 and over). |

### Event

```json
{"seq": 4, "tick": 381, "time": "Day 1 Mon 06:21", "kind": "social", "tag": "invite_accepted",
 "importance": 1, "major": false, "text": "Tom Levi accepts Ari's invite.", "agent": "tom",
 "agents": ["tom", "ari"], "place": "cafe", "at": [14, 24]}
```

| Field | Meaning |
|-------|---------|
| `seq` | 1, 2, 3, ...: every event's own number, in order. |
| `tick`, `time` | When it happened. |
| `kind` | The broad kind: `life`, `weather`, `money`, `health`, `death`, `outcome`, `social`, `goal`, `message`, `home` or `controller`. |
| `tag` | What happened, which sets the kind and importance. For example `death`, `hospital`, `big_money`, `money_swing`, `injury`, `outcome` (a hidden outcome that came true), `goal_reached`, `in_the_red`, `hardship`, `richest`, `first_meet`, `new_friend`, `falling_out`, `invite`, `invite_accepted`, `meetup`, `text`, `weather`, `closed`, `home_bought`, `home_rented`, `home_listed`, `evicted`, `forced_sale`, `neglect`, `falling_apart`, `shabby`, `restored`, `too_late`, `emergency`, `repaint`, `damp_chill`, `controller_joined` and `controller_left`. The full list is `chronicle.EVENT_TAGS`. |
| `importance` | 0 routine (only the log), 1 notable (News), 2 major (headlines, toasts and the ticker). |
| `major` | `importance == 2`. |
| `text` | The line to show. |
| `agent` | The character the event is about, or `null`. |
| `agents` | Everyone it involves, starting with `agent`. |
| `place` | The place id it happened at (or the character was heading for), or `null`. |
| `at` | `[x, y]`: the character's tile when it happened, or `null`. |

Tags `richest`, `controller_joined` and `controller_left` are God-only: those
lines are never written into a character's memory. `richest` is logged when a
new adult becomes the richest person in town (checked every game hour).

### Decided fork

In the `forks` list of state frames, in `welcome.llm_log`, in `get_decisions`
pages and on the agent page.

```json
{"id": "f5", "agent": "tom", "kind": "invite", "tick": 381, "time": "Day 1 Mon 06:21",
 "question": "Ari Ben-David invites you to Corner Cafe. What do you do?",
 "options": ["Accept and meet Ari at Corner Cafe", "Decline politely", "Suggest another day instead", "Ignore the message"],
 "choice": 0, "decided_by": "model", "reason": "Ari is a good friend.", "happened": [],
 "major": false, "controller": "my-bot", "model": "claude-haiku-5-5", "answer_seconds": 0.8,
 "late": null, "profile_choice": 0, "place": "main_28"}
```

| Field | Meaning |
|-------|---------|
| `id`, `agent`, `kind`, `question` | As in the [fork](#fork) push. |
| `tick`, `time` | When it was decided. |
| `options` | The four labels. |
| `choice` | The index played. |
| `decided_by` | `habit`, `default`, `model` or `timeout`, see [Answer windows](#answer-windows-5-seconds-and-10-seconds). |
| `reason` | The controller's reason, or the Director's note (`"Obvious from the character's habits."`, `"Played from the character's profile."`, `"No answer in time; played the default."`). |
| `happened` | The labels of the hidden outcomes that came true. It is usually empty when the fork is first pushed, because outcomes land once the plan is carried out, and some only hours later. When an outcome lands later, the fork is pushed again in the next state frame's `forks`, with the same `id` and the longer `happened` (while it is among the character's last 20 decisions), so keep the latest copy of each id. |
| `major` | A major fork (a move, housing trouble). |
| `controller` | The controller that was asked, or `null` when nobody was. |
| `model` | The `model` that controller declared in its hello, or `null`. |
| `answer_seconds` | Real seconds an in-time answer took, one decimal; `null` unless `decided_by` is `model`. |
| `late` | `null`, or the saved late answer `{"choice", "reason", "seconds"}` (seconds after the fork was asked, one decimal, between 5 and 10). The fork is pushed again when it is filled in. |
| `profile_choice` | The option the character's profile ranks first (what habit or the default would play), so God can see when a controller went against it. |
| `place` | The place id the character was at or heading for when it was decided, or `null`. |

### Job

`{"title", "place", "hourly_wage", "hours": [start_hour, end_hour], "workdays": [0..6, ...]}`.
`place` is a place id; workday 0 is Monday. Pupils have a job at the school
with an `hourly_wage` of 0. `hourly_wage` is before income tax: each shift pays
`hourly_wage` x hours worked x (1 - min(0.45, 0.15 + 0.004 x `hourly_wage`)),
so about 22% is withheld from a cashier's $17 and 43% from a doctor's $70.

### Possessions

`query` `possessions` and the agent page's `possessions`:

```json
{"home": {"id": "birch_court_2b", "place": "birch_court", "name": "Birch Court, flat 2B", "tier": "flat",
          "tier_label": "flat", "district": "eastgate", "bedrooms": 2, "tenure": "rented",
          "landlord": "Millbrook Homes", "weekly_rent": 220, "property_tax": 0, "weekly_cost": 220,
          "value": 8400, "condition": 84, "stage": 0, "stage_name": "kept", "comfort": 1.0,
          "moved_in": null, "emergency": null},
 "car": false, "phone": {"condition": "cracked"}, "money": 412.0, "savings": 2500.0,
 "household_funds": 2912, "savings_goal": {"name": "a new phone", "target": 300, "saved": 0.0},
 "groceries_at_home": 8}
```

| Field | Meaning |
|-------|---------|
| `home.id`, `home.place`, `home.name` | The home id, its place id and its name. |
| `home.tier`, `home.tier_label` | `flat`, `house` or `big_house`, and its label (`"big house"`). |
| `home.district`, `home.bedrooms` | The district id and the number of bedrooms. |
| `home.tenure` | `"owned"` or `"rented"`. |
| `home.landlord` | `"Millbrook Homes"` for a rented home, `null` for an owned one. |
| `home.weekly_rent`, `home.property_tax` | The weekly rent (0 when owned) and the weekly property tax (0 when rented). |
| `home.weekly_cost` | This week's housing charge, paid on Sunday night: the rent (or a reduced hardship rent) for renters, the property tax for owners (0 while it is deferred). |
| `home.value` | The market value now, see `state.homes`. |
| `home.condition`, `home.stage`, `home.stage_name` | How well kept the place is: 0..100, the stage 0..4 and its name (see [Housing](#housing)). |
| `home.comfort` | How good time at home feels, two decimals (about 0.55 to 1.2): better tiers and better kept homes give more, and a crowded one less. |
| `home.moved_in` | When the household moved in, or `null` when it has lived there since the start. |
| `home.emergency` | `null`, or a live emergency `{"kind", "text", "since"}`: `kind` `leak`, `boiler`, `roof` or `electrics`, `text` such as `"The boiler has broken down."`, `since` a time stamp. |
| `car` | Whether the character owns a car. |
| `phone` | `{"condition": "fine" or "cracked"}`. |
| `money` | The character's own money, two decimals; can be negative. |
| `savings` | Money put aside on payday by a character with no goal to save for, two decimals. It is not part of `money`. |
| `household_funds` | The household's pooled money (its living adults' money plus savings), whole dollars. |
| `savings_goal` | `{"name", "target", "saved"}` or `null`. |
| `groceries_at_home` | Meals' worth of groceries in the household's fridge. |

### Agent page

The reply to `get_agent` and `set_profile`.

| Field           | Meaning |
|-----------------|---------|
| `id`, `name`, `age`, `alive` | Identity. |
| `kind`          | `"named"` for the 60 characters; a townsperson's page (`get_agent` with an id like `"f17"`) has `"folk"` and the fields of [Townsfolk](#townsfolk). |
| `state`, `activity` | As in [State](#state). |
| `place`         | Place id of the current activity, or `null`. |
| `inside`        | Place id or `null`. |
| `luck`          | 0..100, one decimal. |
| `money`         | Two decimals; can be negative. |
| `health`        | 0..100, one decimal. |
| `mood`, `reputation` | 0..100, integers. |
| `needs`         | `{"hunger", "energy", "social", "fun"}`, one decimal. |
| `job`           | [Job](#job) or `null`. |
| `controller`    | Controller name or `null`. |
| `profile`       | `{"prompt", "traits", "edited": bool, "learned": [up to 10 notes]}`. `edited` is true once God wrote the prompt by hand. Each learned note looks like `"hunger: chose 'Cook at home' because ..."`. |
| `savings`       | As in [Possessions](#possessions). |
| `household_funds` | As in [Possessions](#possessions). |
| `net_worth`     | What the character is worth, in whole dollars: the sum of `worth_parts`. The dashboard's ranking orders people by it. |
| `worth_parts`   | `{"cash", "savings", "home"}` in whole dollars: the character's money, their savings including a savings goal's pot, and, for an adult in an owned home, their share of its value. A home a household buys is shared by what each adult paid of the price, so buying moves an adult's money into their own share (and a sale pays out in the same shares); the share of an adult who dies passes to the others in proportion. A home the household had at the start is shared equally among its adults. |
| `home_history`  | The household's last 20 moves, oldest first: `[{"time", "event", "home", "name", "price"}]`. `event` is `bought` or `rented` for the home moved into (`price` the price paid, or the weekly rent), and `sold`, `left`, `evicted` or `forced_sale` for the home left (`price` what a sale raised, else `null`); `home` and `name` are the home's id and name. |
| `possessions`   | See [Possessions](#possessions). |
| `relationships` | Same as `query` `relationships`, ordered by affinity, highest first. |
| `memory`        | Last 15 memory strings. |
| `inbox`         | Last 10 inbox entries. |
| `forks`         | Last 10 [decided forks](#decided-fork), oldest first. |
| `household`     | Names of the people in the character's household. |
| `life`          | The life block: `{"stage", "birthday", "partner", "children", "friends", "rivals", "conditions", "chronic", "pregnant", "work", "money", "talks"}`, with `work` `{"standing", "warnings", "days_in_job", "jobless_days", "benefit"}` and `money` `{"lifestyle", "debt", "loans"}`; see [Life, work and money](#life-work-and-money). |

### Home page

The reply to `get_home`:

```json
{"id": "main_20", "place": "main_20", "unit": null, "name": "20 Main Street", "tier": "house", "bedrooms": 3,
 "base_value": 16800, "rent": 420, "district": "maple_grove", "hh": null, "household_name": null,
 "owner": "landlord", "listing": "for_rent", "price": 420, "value": 15900, "emergency": null,
 "condition": 82, "stage": 0, "stage_name": "kept", "residents": [],
 "history": [{"time": "Day 1 Mon 18:09", "event": "left", "household": "cohen", "price": null}]}
```

`id`, `place`, `unit`, `name`, `tier`, `bedrooms`, `base_value` and `rent` are
as in [Homes](#homes); `district` is the district id. `hh`, `owner`,
`listing`, `price` and `value` are as in `state.homes`, and `household_name` is
the household's name (`"The Cohens"`, `"Ari Ben-David"` or `"Dana and Avi"`)
or `null` when it is vacant. `emergency` is `null` or `{"kind", "text", "since"}`
as in [Possessions](#possessions). `condition`, `stage` and `stage_name` are
the place's (a flat shares them with its block). `residents` are the names of
the living people who live there, and `history` the home's last 20 changes of
hands, oldest first: `[{"time", "event", "household", "price"}]`, with `event`
as in the agent page's `home_history` and `household` the household id.

### Stats object

The welcome's `stats`, the `get_stats` reply and every [`stats` push](#stats-push):

| Field | Meaning |
|-------|---------|
| `type` | `"stats"`. |
| `full` | `true` in the welcome and the `get_stats` reply (every kept sample), `false` in a push (only new samples). |
| `tick`, `time`, `day` | When it was taken, as in [State](#state). |
| `city` | The city's numbers, see below. |
| `llm` | The AI players' numbers, see below. |
| `districts` | Every district with homes, in town order: `[{"id", "name", "people", "mood", "median_worth", "homes", "vacant", "shabby_plus"}]`: the people living there, their mean mood, the median adult worth, the number of homes, how many are vacant, and how many of its places are shabby or worse (stage 2 and up). A district counts every home in it, whoever lives there (in the `region` world the townsfolk's too), so its homes can add up to more than `city.homes.total`. |
| `households` | Every household with a living member: `[{"id", "name", "members", "home", "home_name", "place", "tier_label", "tenure", "weekly_cost"}]`: `members` are the living members' ids; `home`, `home_name` and `place` the home id, its name and its place id; `tier_label`, `tenure` and `weekly_cost` as in [Possessions](#possessions). |
| `people` | Every living person, richest first (ties by id): `[{"id", "household", "worth", "worth_24h", "cash", "savings", "home_equity", "job", "health", "llm"}]`. `worth` is the `net_worth` of the agent page, split into `cash`, `savings` and `home_equity` (the `worth_parts`); `worth_24h` is the worth 24 game hours ago (until a day has passed, at the first hourly sample, or now before that); `job` is the job title or `null`; `health` an integer; `llm` how many of the person's forks a controller was asked about since the city began, answered in time or timed out (`decided_by` `"model"` or `"timeout"`). It keeps counting after [`get_decisions`](#get_decisions) for the person stops at their last 30. |
| `samples` | Hourly samples of the city, oldest first, one every whole game hour (the last 168, 7 days, are kept): `[{"tick", "day", "pop", "mood", "health", "wealth", "median", "top10", "in_debt", "working", "owned", "shabby_plus", "asked", "in_time"}]`. `pop`, `mood`, `health`, `working` and `in_debt` are as in `city`; `wealth`, `median` and `top10` are `city.wealth`'s `total`, `median` and `top10_share`; `owned` is `city.homes.owned`; `shabby_plus` the places at stage 2 and up; `asked` and `in_time` the forks asked of controllers and answered in time during that hour. |

`city`:

| Field | Meaning |
|-------|---------|
| `population`, `start_population` | The living people, and everyone the city started with. |
| `deaths`, `births` | The dead, and the born (always 0: nobody is born yet). |
| `adults`, `children` | The living people 18 and over, and under 18. |
| `working`, `students`, `retired`, `out_of_work` | People with a paid job; pupils (a school place with no wage); people of 65 and over without a job; adults under 65 without one. |
| `mood`, `health` | Means over the living, integers. |
| `needs` | `{"hunger", "energy", "social", "fun"}`: means, integers. |
| `wealth` | `{"total", "median", "top10_share", "gini", "in_debt"}`: the total worth of everyone; the median adult worth; the percent of the adults' positive worth held by the richest tenth; the Gini coefficient of adult worth (two decimals); and the adults whose cash plus savings is below zero. |
| `homes` | `{"total", "owned", "rented", "for_sale", "for_rent", "lots_by_stage", "neglected_lived_in"}`: the homes; those lived in by their owners and by tenants; those listed for sale and to let; how many places are at each stage (a list of five counts, `kept` first); and the places at stage 3 or 4 that someone lives in. These are the cast's 37 homes on their 22 places in both worlds: in the `region` world the townsfolk's homes count only in `districts`. |
| `luck` | `{"touched", "raised", "lowered", "mean"}`: the living people whose luck is not 50, above 50 and below 50, and the mean luck (an integer). |
| `recent_deaths` | Up to 5, newest first: `[{"id", "name", "age", "time", "how"}]`. |
| `life` | `{"ill_now", "in_hospital", "couples", "births", "deaths", "jobless", "in_debt", "talks_today", "friendships_today"}`, integers: see [Life, work and money](#life-work-and-money). |

`llm`:

| Field | Meaning |
|-------|---------|
| `controllers` | The connected controllers: `[{"name", "model", "characters"}]`; `model` as declared in the hello, or `null`; `characters` the living characters it plays. |
| `playing`, `thinking` | The living characters a controller plays, and those whose controller has a fork to answer right now: standing on it (`state` `"deciding"`), or already setting off for work the usual way while the work fork is still asked. |
| `today`, `total` | Fork counts since midnight and since the city began: `{"asked", "in_time", "timeouts", "late", "withdrawn", "against_habit", "avg_seconds"}`: forks sent to a controller; answered in time; timed out; answered late (within 10 s); withdrawn; in-time answers that differ from `profile_choice`; and the mean seconds of the in-time answers, one decimal, or `null` when there were none. A fork still waiting for its answer at midnight counts as asked in the new day too, where it is decided, so `asked` = `in_time` + `timeouts` + `withdrawn` + the forks still waiting, in `today` as in `total`. A late answer to a fork that timed out before midnight still counts in the new day's `late`. |
| `habit_today`, `default_today` | Forks today that nobody was asked about: decided by habit, and played from the profile of a character no controller plays. |

## Region map

In region world (`--world region`, the default of the server, `__main__` and the port page) the God welcome's
`town` is the 256 x 192 region with Millbrook in its north-west corner. It keeps every key of [Town](#town) except
`road_rows`, `road_cols` and `road_col_end`, which only the millbrook world sends; `w`, `h` are 256, 192. It adds:

| Field | Meaning |
|-------|---------|
| `world` | `"region"`; the millbrook world (v2's 80 x 50 map) sends `"millbrook"` and none of the keys below. |
| `millbrook` | `[0, 0, 80, 50]`: Millbrook's own 80 x 50 as `[x, y, w, h]`. Tiles at x < 69, y < 50 are exactly the millbrook world's for the same seed. |
| `rail` | `{"lines": [...]}`, the railway, see below. `timetable.train` and `state.trains` are in [Trains](#trains). |
| `highways` | `[{"name", "line", "width"}]`: `line` is the corner tiles `[[x, y], ...]` of the road and `width` its width in tiles (Route 9 along y 155, Route 9 North along x 231). Cars only. |
| `interchanges` | `[[x, y], ...]`: where streets join a highway. |
| `decor` | `[[x, y, w, h, style, floors, variant], ...]`: 656 buildings with no part in the simulation, standing on `B` tiles; `style` is a renderer model as for places, `variant` 0-7. |

More tile codes: `b` road bridge and `x` level crossing (streets, walkable), `F` farmland (walkable), `=` railway,
`r` rail bridge and `S` platform (not walkable), `H` highway and `h` highway bridge (cars only).

`districts` lists Millbrook's 7, then the region's 10: `northgate`, `the_heights`, `north_woods`, `quayside`,
`downtown_riverton`, `midtown`, `ironworks`, `willow_hills`, `southfield`, `greenacre`. A region district also has
`parking_minutes`, the minutes a driver spends parking there (10 Downtown, 8 Midtown, else 0). `junctions` are the
street tiles with three or more street neighbours.

Every place except a home has `capacity`, how many people fit inside at once (no place has it in the millbrook
world). Region places add the kinds `station` and `venue`; a restaurant is kind `cafe` with style `restaurant`.
Region ids are never integer-like and never one of Millbrook's.

A line in `rail.lines`: `{"id", "name", "cars", "tracks", "track_tiles", "stations", "trains", "every", "speed",
"dwell", "layover", "capacity", "fare"}`.

| Field | Meaning |
|-------|---------|
| `id`, `name` | `"R"`, the Riverton Line (6 stations), or `"S"`, the Southfield Line (4). |
| `tracks` | `{"out": [[x, y], ...], "in": [...]}`: each track's corner tiles, buffer to buffer. A train's `i` indexes its track's tiles walked from the first corner. |
| `track_tiles` | `{"out": n, "in": n}`: the tiles on each track. |
| `stations` | In line order, `{"id", "name", "i", "platforms", "exits"}`: `id` is the station's place id; `i` is `{"out": k, "in": k}`, the track index where a train's head stops; `platforms` the platform rects `[x, y, w, h]` beside the out and the in track; `exits` the street tiles where riders come and go, a minute from the trains. |
| `trains` | The line's train ids: `R1` to `R6`, `S1` to `S4`. |
| `every` | Minutes between trains each way. |
| `speed` | Tiles a minute. |
| `dwell`, `layover` | Minutes at a stop and at the end of the line. |
| `cars` | Cars a train draws, the head's at `i` and car k at `i-k` (2 on both lines). |
| `capacity` | Riders a train holds (reported, not enforced): 120. |
| `fare` | Dollars a ride for ages 18-64 (others ride free); the change at Central is free. |

## Trains

The railway runs in the region world only (`town.world` is `"region"`). In
Millbrook `state.trains` is `[]` and the timetable has no `train` key. Everything
here comes from `gameofailife/rail.py`: trains are a pure function of the tick
(no dice, no state), so a client can also compute them from `town.rail` and
`timetable.train`.

Two double-track lines run every 10 minutes each way: the Riverton Line `R`
(`millbrook_station`, `northgate_station`, `quayside_station`,
`central_station`, `midtown_station`, `ironworks_station`; trains `R1` to `R6`)
and the Southfield Line `S` (`central_station`, `southfield_station`,
`fairview_station`, `willow_hills_station`; trains `S1` to `S4`). A train starts
at its first station on the `out` track, moves up to `speed` tiles a minute,
stands `dwell` more minutes with its doors open at each stop, lays over
`layover` minutes at the far end, crosses to the `in` track and runs back. The
round trip is padded to `trains` x `every` minutes (`cycle_minutes`: 60 for `R`,
40 for `S`), and train k is k x `every` minutes ahead of train 1. A rider on a
platform boards the first train on their track with its doors open there, and
gets off at the first stand of that train at their station. Changing lines at
Riverton Central takes 2 minutes (free; the fare is paid once).

### `town.rail`

`{"lines": [line, ...]}`, one line:

| Field | Meaning |
|-------|---------|
| `id`, `name` | `"R"` / `"Riverton Line"`, `"S"` / `"Southfield Line"`. |
| `cars` | Cars a train draws (2): the head at track index `i`, the car behind it at `i-1`. |
| `tracks` | `{"out": corners, "in": corners}`: each track's tile corners `[x, y]` in driving order, buffer to buffer. Every tile between two corners is track; draw them at the tile centres (corner + 0.5). |
| `track_tiles` | `{"out": n, "in": n}`: tiles on each track (index `i` runs 0 to n - 1). |
| `trains` | The train ids, e.g. `["R1", ..., "R6"]`. |
| `every` | Minutes between two trains in each direction (10). |
| `speed`, `dwell`, `layover` | Tiles a minute (10), extra minutes at a stop (1), minutes at each terminus (3). |
| `capacity`, `fare` | Riders a train holds (240; reported, not enforced) and the fare in dollars (3 for ages 18 to 64, else free). |
| `stations` | `[{"id", "name", "i", "platforms", "exits"}]` in `out` order: `i` is `{"out": index, "in": index}`, the track index where a train's head stands with its doors open; `platforms` the platform rectangles `[x, y, w, h]` (the first beside `out`, the second beside `in`); `exits` the street tiles `[x, y]` where riders enter and leave, a minute's walk from the trains. The station's place (same id, kind `station`) is in `town.places`. |

### `state.trains`

Sent in every state frame: one row per train, line `R` first, about 1.2 KB.

```json
{"id": "R3", "line": "R", "track": "out", "i": 91, "x": 126, "y": 68, "dir": "e", "at_station": "central_station", "riders": 4}
```

| Field | Meaning |
|-------|---------|
| `id`, `line` | Train id and line id. |
| `track`, `i` | The track (`out` or `in`) and the head's index on it (`i - 3 >= 0` always). |
| `x`, `y` | The head's tile. |
| `dir` | The heading: `n`, `s`, `e` or `w`. |
| `at_station` | The station id while the train stands there with its doors open, else `null`. |
| `riders` | Townsfolk on board this minute. |

### `timetable.train`

```json
{"lines": [{"id": "R", "name": "Riverton Line", "stations": ["millbrook_station", "northgate_station",
  "quayside_station", "central_station", "midtown_station", "ironworks_station"], "trains": 6,
  "every_minutes": 10, "cycle_minutes": 60, "fare": 3, "capacity": 120,
  "minutes": {"out": [0, 3, 8, 12, 19, 24], "in": [0, 4, 11, 15, 20, 24]}}, "..."],
 "transfer": {"central_station": 2}}
```

Per line: `stations` in `out` order, how many `trains`, a train `every_minutes`
each way, `cycle_minutes` for one train's round trip, `fare`, `capacity`, and
`minutes`: for each track, the minutes from the departure at its first station
(`stations` in order for `out`, reversed for `in`) to the doors opening at each
station. `transfer` gives the minutes to change lines at each station two lines
serve (`central_station`). The longest wait for a train is 8 minutes at a
through station and 9 at a terminus.

## Townsfolk

About 1,000 townsfolk live default lives in the region around Millbrook (`--folk N`, default 1000; none in the
`millbrook` world). No controller plays them and they never get forks. Their ids are `f0`, `f1`, ... (`f` and
digits; the 60 named characters' ids have no digits). God may read a townsperson's page with `get_agent` and change
their luck with `set_luck`, exactly as for a named character.

**Who they are.** The 1,000 live in about 420 households in the region's homes. Ids: `f<i>` for a townsperson (i is their index, newborns continue it) and `fh<j>` for a
household; a region home's `household` is an `fh` id and its `owner` is `"landlord"`, `"market"` or the
household's id. Each townsperson has a unique name across all 1,060, `age`, `sex` (`"f"`/`"m"`), six traits
(thrift, family, social, diligence, health, adventure, 0-1), v2's needs, `health`, `money` and `savings` (dollars,
two decimals), `owns_car`, a `job` (title, place, hourly wage, start and end hour, workdays; pupils are
`"student"` at a school with wage 0) and a `commute` `[place_id, minutes, "walk" | "car" | "train"]`. Folk money:
take-home pay at the end of each shift, the $400 pension on Friday 09:00 to 65+ without a paid job, and on Sunday
23:00 rent or property tax split by the adults plus $80 bills per adult and $40 per car, then saving. Groceries
cost $35 at a grocer in reach, or $8 more delivered to a household with none in reach; someone off sick eats at
home at 12:30 and 18:30 and orders in when the fridge is empty. Three
Sundays in the red move a household to a cheaper rental or out of town (`left_town`, its `agents` the folk ids).
Folk homes have their own damp, chills and emergencies; they are routine, so the residents remember them (a
line in each one's memory) and no event is sent. With `folk_isolated`, no townsperson has a tie to the 60, a
job at Millbrook's places or a seat at Millbrook's school.

| Where | Field | Meaning |
|-------|-------|---------|
| State | `crowd` | `[i, x, y, k, ...]`: one quadruple per townsperson outdoors and not aboard a train or bus, sorted by `i` (the number in the id). `k` is `mode + 8 x child` (child: under 18); mode 0 walk, 1 run, 2 car, 3 bike, 4 taxi, 5 ambulance, 6 waiting, 7 other outdoors. Car passengers are left out. |
| State | `occ` | One integer per place in `town.places` order: the townsfolk and named inside it (or strolling in a park). In the welcome; then in a frame once 10 game minutes have passed since the last one sent, at most every 40th frame. |
| State | `folk_n` | The number of townsfolk ids. |
| Stats | `folk` | Only with townsfolk: `{"v", "worth", "worth_24h", "mood", "health", "luck"}`: `v` the roster version (it changes on births, deaths, moves and new jobs); the rest lists of `folk_n` integers by index, `null` for the dead or gone. `stats.people` and the richest-person headline stay the 60 named. |
| Stats | `region` | Only in the `region` world: `{"population", "named", "folk", "births", "deaths", "births_today", "deaths_today", "jobs", "commute", "train", "bus", "homes"}` with `jobs` `{"total", "filled", "open"}`, `commute` `{"walk", "car", "bus", "train", "bike"}`, `train` `{"riders_now", "riders_today", "lines": [{"id", "riders_today"}]}`, `bus` `{"riders_now", "riders_today"}` and `homes` `city.homes`' keys over every home in the region and the lots they stand on (`city.homes` keeps to the cast's 37). |

`city` and `districts` in the stats count the townsfolk too (the region's districts follow Millbrook's in the
`region` world): the counts (`population`, `adults`, `children`, `working`, `students`, `retired`, `out_of_work`),
the `mood`, `health` and `needs` means, `luck` (God's changes on townsfolk included), and `wealth` (`total` is
everyone's worth; `median`, `top10_share`, `gini` and `in_debt` cover every adult), and each district's `people`,
`mood` and `median_worth`; a district's `homes`, `vacant` and `shabby_plus` count the townsfolk's homes and places in it too. `recent_deaths`, `homes` and `life` keep their own rules: `city.homes` stays the cast's 37 homes and their 22 places (the market the 60 named live in). [`get_folk`](#get_folk) lists every townsperson; a view asks for it again when `stats.folk.v`
changes.

The invariant every frame keeps: `len(crowd) / 4` + the townsfolk inside places + those aboard a train or bus + car
passengers = the townsfolk alive and in the region. In the `region` world, frames compare `lots` and `homes` every
20th frame and send them when they changed or every 200th frame (the `millbrook` world keeps checking every frame
and sending every 40th).

Townsfolk are not characters: no `fork` is ever about one and no controller can `claim` one. A townsperson's page (`get_agent` with a folk id) is
`{"kind": "folk", "luck_settable", "id", "name", "age", "sex", "alive", "gone", "state", "activity", "place",
"inside", "x", "y", "luck", "money", "savings", "worth", "health", "mood", "reputation", "needs", "job", "commute",
"home", "household_id", "household", "vehicle", "relationships", "memory", "choices", "traits", "life"}`: `gone`
is true once they have left the region, `job` as on a named page (a townsperson on a region job keeps their own start: on
its `hours`, or 15 or 30 minutes before or after, finishing as much earlier or later; the region's schools but
Riverton High start at 08:30; Millbrook's jobs and school keep their hours),
`commute` `[work place id, minutes, mode]` or `null`, `home` `{"id", "name", "place"}`,
`household` their household's living members' names, `memory` their last 10 notable moments (`"Day 3 Wed 11:00:
Became friends with ..."`, a date, a food parcel, lateness), `choices` their last 5 settled choices
`[{"time", "kind", "options", "choice", "by"}]` (`time` `"Day 12 21:45"`; the named get forks instead), `life` as on a named page (see [Life](#life)). A named character's page has
`"kind": "named"`.

## Life

How people talk, love, fall ill, work, earn and die, for the named and the townsfolk alike.

### Social

Everyone talks: the named and the townsfolk meet in rooms (a home's residents, a block's or house's visitors, a
workplace, school, cafe or park), about 4 to 9 talks a person a game day. Talk moves both sides' `affinity`;
friendships, falling-outs, rivals, flirting, dating, moving in, engagements, weddings, breakups, loans and rows
follow from it. Romance between a named character and a townsperson stops at dating. Odds are never sent.

**`state.talks`**: the talks begun in the last 10 game minutes, newest first, at most 20 rows:
`[place_index, a_id, b_id, tone, tick]`. `place_index` is the place's position in `town.places` (-1 on a street);
`a_id`, `b_id` the two (named or townsfolk ids); `tone` 1 warm, 0 pleasant, -1 awkward or an argument; `tick` the
minute it began (for de-duplication across frames). Every talk with a named character comes first, then talks
between townsfolk, at most one per place.

**Relationships.** `get_agent` and the controller's `query` `relationships` give, for each other person by id,
`{"id", "name", "named", "kind", "affinity", "trust", "romance", "married"}`: `named` false for a townsperson;
`kind` one of `partner`, `family`, `friend`, `coworker`, `acquaintance`, `dating`, `ex` or `rival`; `affinity`
-100..100 (rounded; a friend from 40, a rival at -15 or below), `trust` 0..100, `romance` 0..100 (this side's), and
`married` true for a married couple. A person keeps at most 60 relationships: a new acquaintance pushes out the
acquaintance or coworker seen longest ago (never a friend, family, partner or date), and an unseen friend slowly
fades.

**Talk lines.** A named character's last 12 talks are kept for their page (see [Life, work and money](#life-work-and-money)
for where the page shows them) as `{"time", "with", "name", "topic", "tone", "text", "place"}`: `topic` one of
`weather`, `work`, `school`, `money`, `family`, `health`, `news`, `love`; `tone` `warm`, `pleasant`, `awkward` or
`argument`; `text` the two lines, `“...” “...”`, at most 160 characters: the first speaker's, then the other's (a
line about a child or a partner asks after the listener's). A `news` talk may quote a recent headline,
never the richest-person headline or a controller's. A townsperson keeps their last 5 talks the same way; a talk
between two townsfolk has `topic` and `text` `null` (no words are drawn for it).

**Events** (see [Event](#event)). Every social event carries `place` and `agents`. Talks and flirts are events only
with a named character, and then only for arguments and for warm, news, love or baby talk away from home, at most one
a pair an hour (a talk event names the first speaker first).

| Tag | Importance | When |
|-----|------------|------|
| `talk` | 0 | "Dana Cohen and Ari Ben-David chat about the news at Corner Cafe: “...” “...”" (or `argue about`). |
| `flirt` | 0 (1 for an ask-out) | Two single adults flirt; "Tom Levi asks Ari Ben-David out to dinner." |
| `new_friend` | 2 between named, 1 with a townsperson | Affinity reached 40. |
| `falling_out` | 2 between named, 1 with a townsperson | A friend or partner's affinity went below 0. |
| `rival` | 1 | Affinity fell to -15: they can't stand each other. |
| `row` | 1 | A weekly incident at work, school or on a block: affinity -15 both. |
| `partner` | 2 | "... are going out!" |
| `meetup` | 0 | A date between a named character and a townsperson. |
| `moved_in`, `engaged`, `wedding` | 2 | Moving in together, an engagement, the wedding (a Saturday at 14:00 in a park). |
| `breakup`, `divorce` | 2 | A couple splits (a married couple divorces, $1,500 each). |
| `loan` | 1 (0 for a repayment) | A loan between family or friends, repaid once the borrower holds three times it. |
| `invite`, `invite_accepted`, `invite_declined` | 0 | Invites, to the named and to townsfolk: the log, not the News. |
| `text` | 0 | A named character texts a townsperson. |

News about townsfolk alone (an event naming a townsperson and no named character, importance 1 or more) is capped
at 60 a game day; the rest are dropped.

**Texts to townsfolk.** `send_message` with a townsperson's id as `to` works only when the sender knows them (else
`{"ok": false, "error": "you don't know them"}`). The townsperson answers at once with a short reply, pushed as a
[`message`](#message) whose `from` is their id and `from_name` their name; both sides' affinity rises by 1. Each
Saturday at 12:00 a townsperson friend (affinity 40+) may text a named friend the same way.

**Invites to townsfolk.** `invite` with a townsperson's id as `to` answers `{"type": "invited", "ok", "invite":
{"id": "fi<n>", "from", "to", "place", "tick", "status"}}` (`ok` false when the townsfolk keep to themselves or the
place is out of reach). The townsperson answers on the next game minute with an [`invite_answer`](#invite_answer)
(`invite_id` the `fi<n>` id, `from` their id, `answer` `accept` or `decline`), and on `accept` heads there for 90
minutes. Townsfolk invites are never in the named characters' invite list and never become an `invite` fork.

**Social forks.** Eight kinds reach a named character as a [`fork`](#fork), each with four options and an `about`
(who the other person is, how long the two have known each other, how often they have talked and how the character
feels about them): `crush` (ask them out, a flirty text, wait, let it go), `asked_out` (yes, a coffee instead, stay
friends, turn them down), `date` (go, coffee tomorrow, not tonight, end it), `move_in` (ask them to move in, move
into their place, look for a place together, not yet), `propose` and `proposal` (the asking and the answer),
`relationship_trouble` (talk it through, a special evening, a week's space, end it), `partner_split` (agree, try
counselling, plead, storm out) and `friend_in_need` (lend it all, lend half, give a quarter, say no). The other
person may be a townsperson (`crush`, `asked_out`, `date`, `relationship_trouble`, `friend_in_need`).

### Life, work and money

Every person, named or townsperson, has the same life: a birthday, illnesses, a job on the one job board, a
weekly money settlement, children and a death. Nothing here sends odds or rolls (see
[Hidden information](#hidden-information)).

**Years and birthdays.** A year is 360 game days. Each person ages by one on their own birthday (`life.birthday`,
a day of the year from 0 to 359), not all on one day. A named child starts school (the `student` job) at 5 and
leaves it at 18 (`came_of_age`), when they look for work.

**Illness.** Each person rolls once a day, in a minute of their own: a cold, the flu, a stomach bug, back pain or
a broken bone (more colds and flu in winter), a heart attack or a stroke (by age), and from 30 a chronic condition
(hypertension, diabetes, arthritis, heart disease). While ill, health is held at 85 or below; each chronic
condition lowers the most a person heals to by 5, and so does age past 55 (0.8 a year). Some go to the doctor
($40), which shortens the illness by 30%. A cold or the flu can spread at home. A broken bone, a heart attack or
a stroke, or health under 25, sends the person to hospital (the `ward` activity, $60 a day, `in_hospital`),
by ambulance for a named character; they cannot work or take forks until discharged (`discharged`). An
illness's `off_work` keeps the person off work or school.

**Births.** A couple may conceive (`expecting`); 90 days later the baby is born at 08:00 (`birth`). A named
couple's baby is a new named character with its own id (its first name, or first name and surname when taken) in
the parents' household: it appears in the state frame and on pages, and has no forks until 5 (`stage` `baby` or
`child`). A townsperson's baby is a townsperson. Day 4 of every new city sees Shira Peretz's baby.

**Deaths.** Each day's odds follow the person's age and their untreated and treated conditions, more with health
under 40 or a heart condition in hospital (`death`, with a cause). A death frees the person's job, widows their
partner (grief for 30 days) and saddens their friends and family.

**Work.** The named and the townsfolk share one job board. A worker's standing (`reputation`, 0 to 100, the
character's `work.standing`) moves after every shift, more for the diligent, and drifts toward 50; a pupil's
moves +0.5 a day at school as in v2. Every 90 days a worker with 30 days in the job has a review: at 50 or
more a 4-7% raise may follow (`raise`); under 25 a warning (`warning`); at 40 or more the warnings clear; under 20
with two warnings they are fired (`job_lost`); at 85 or more after 120 days in the job a promotion may follow
(`promotion`: "senior ", then "head ", at 1.2 times the pay); from 65 a review may end in retirement (`retired`,
certain from 67), after which the person does not look for work. Anyone may be laid off (`job_lost`). A worker
at 50 or more may be offered a job paying 10% to 25% more and take it (`job_new`). A job seeker 18 to 64 has a
daily chance of a job (`job_new`), better with higher standing and better again when a friend (affinity 40 or
more) works where a job is open (for a townsperson, one they can reach), which is then the job taken; otherwise
at no more than 1.25 times their last wage, a named character takes the best paid, a townsperson the nearest.
Raises and promotions belong to the holder: a job left behind is advertised at its own title and pay. A new hire meets up to 4 coworkers there
(`coworker` relationships at 15 to 25). A laid-off or fired person gets $200 a week for 13 weeks while under 65.

**Money.** Each adult's week is settled on Sunday between 09:00 and 19:00, at a minute of their own: the benefit;
lifestyle spending, which rises quickly with pay and falls slowly (none while the household is in the red after
the last Sunday's bills, halved while it tightens its belt); a share of wealth spent; an unexpected `expense`
(a broken appliance only in a home the household owns: a let home's are the landlord's) and an unexpected
`windfall` (importance 1 from $300 and 2 from $2,000 for a named character; from $1,000 and $5,000 for a
townsperson); $15 for each treated chronic condition; the children's costs, paid by the household's richest
adult; and 0.4% interest on debt. Savings cover a negative purse.

| Where | Field | Meaning |
|-------|-------|---------|
| State | `ill`, `stage` | See [State](#state). |
| Agent page | `life` | `{"stage", "birthday", "partner", "children", "friends", "rivals", "conditions", "chronic", "pregnant", "work", "money", "talks"}`. `partner`: `null` or `{"id", "name", "kind", "married", "days"}` (`kind` `partner` or `dating`); `children`: `[{"id", "name", "age"}]`; `friends`: a count; `rivals`: `[{"id", "name"}]`; `conditions`: `[{"id", "label", "days_left", "off_work"}]`; `chronic`: condition ids; `pregnant`: `null` or `{"with", "name", "days_left"}`; `work`: `{"standing", "warnings", "days_in_job", "jobless_days", "benefit"}` (`days_in_job` `null` without a job, `jobless_days` `null` unless looking for work); `money`: `{"lifestyle", "debt", "loans": [{"id", "with", "name", "dir", "amount"}]}` (`dir` `lent` or `borrowed`); `talks`: see [Social](#social). |
| Fork | `you.life` | `{"partner", "children", "conditions", "standing", "jobless_days", "debt"}`: `partner` `null` or `{"id", "name", "kind", "married"}`, `children` a count, `conditions` labels such as `"the flu"`, `debt` whole dollars owed beyond savings. |
| Stats | `city.life` | `{"ill_now", "in_hospital", "couples", "births", "deaths", "jobless", "in_debt", "talks_today", "friendships_today"}`, all integers, over the named and the townsfolk; `births` and `deaths` since the start (`city.births` and `city.deaths` are the same counts). |
| Event | `tag` | Life's tags: `expecting`, `birth`, `ill`, `recovered`, `doctor`, `chronic`, `hospital`, `discharged`, `death`, `came_of_age`, `raise`, `warning`, `promotion`, `retired`, `job_new`, `job_lost`, `expense` and `windfall`. A townsperson's events reach the log only at importance 1 or more. |

## View data

How the God view (`client/view/`, `client/dashboard.js`) reads the region's moving data. Nothing here adds a field:
it says what a host may rely on and what it may leave out. The dev host `client/dev/region_stub.js`
(`RegionStub(window.REGION)`) sends all of it from `client/dev/region_data.js` without a server.

| Field | What the view does with it |
|-------|----------------------------|
| `state.crowd` | Read on every frame with a new `tick` (a repeated tick is ignored). A person present in the last frame glides from where they are shown to the new tile over 1.1 ticks (L-shaped, along the streets; cars keep a lane, walkers a kerb), so a late frame never leaves anyone standing; a move of more than 12 tiles per tick the frame covers (at most 8 ticks), or into or out of a vehicle, is a jump. A newcomer appears in place; a person missing from a frame fades out over 300 ms. People standing on one tile stand in a ring. Mode picks the sprite: car, taxi and ambulance are cars; bike is drawn as a walker with a faster step; walk, run, waiting and other a person (`child` smaller). Near (zoom 0.5 and up) at most 800 sprites a frame, the rest marks; mid zoom marks, far zoom 1 px dots (vehicles in their colour). |
| `state.folk_n` | Sizes the view's per-person arrays (with the highest `i` in `crowd`). |
| `state.occ` | Absent means unchanged; when present, one integer per place in `town.places` order, kept as the scene's occupancy. |
| `state.trains` | One row per train, by `id`. The train glides along its track (`town.rail.lines[].tracks`, the polyline through the tile corners + 0.5) from the last `i` to the new one over 1.1 ticks; a change of `track`, a drop of `i` or a jump of more than 12 tiles per tick the frame covers (at most 8 ticks) is a snap. Car `k` (`0` the head) sits at `i - k`, `town.rail.lines[].cars` cars in the line's colour (R red, S blue); doors are open while `at_station`; `riders` is in the tooltip. |
| `state.talks` | The rows come named first, newest first, and the earlier row wins a place or pair. Each row not seen before (by `a`, `b` and `tick`) shows a ping for 3 s: over the place's sign for `place_index >= 0`, between the two people for `-1` (a townsperson where `crowd` shows them, a named character where the view draws them). Tone `-1` is a jagged bubble, `0` a speech bubble, `1` a speech bubble with a gold rim. |
| events | The view takes the frame's events as `setState(state, speed, events)` or `events(list)`; it reads `seq` (each once), `tag`, `place`, `agents`, `agent` and `at`. `talk`, `flirt`: a bubble 3 s; `new_friend`, `partner`, `engaged`: a heart; `falling_out`, `breakup`, `rival`, `row`: a jagged bubble; `wedding`: rings 10 s; `party`, `birth`: a glow 10 s; other tags draw nothing. A ping sits at `place`, else at the first person in `agents` (or `agent`) the view can place, else at `at`. |

At most 20 pings show at once, newest first, one per place and one per pair, none at far zoom and only those on
screen. A pick or hover on a townsperson gives `{"kind": "agent", "id": "f417", "folk": true}`, on a train
`{"kind": "train", "id", "line", "riders"}`. `focus` also takes `{district}` (the centre of its largest rect),
`{station}` and `{line}`; `select`, `focus({agent})` and `highlight` take folk ids.

The dashboard takes folk ids anywhere an event names people (`agent`, `agents`): News lists the event (with no
person chip for a townsperson), a click on it shows the place on the map and opens no page, and no `get_agent` is
sent for a folk id from a map pick or a News row. A major event raises a toast and a map ping only when it names
nobody, names one of the named characters, or is about the person selected; a major about townsfolk alone stays in
News. The tooltip of a townsperson reads "A townsperson", of a train "Train R1 · 12 riders".

The minimap (240 x 120, 168 x 84 on phones) draws `town.tiles` by kind with district borders once, and at 5 Hz the
named characters (2 px), the townsfolk of `crowd` (1 px), the trains (3 px) and the view box.

## Hidden information

The server never sends, to anyone:

- the odds of any outcome, the outcome tables behind the options, the dice
  rolls, the Director's option scores or an outcome's good or bad valence;
- the luck log (`--luck-log` writes it to a file for analysis; it is never
  sent);
- a home emergency that is on its way but has not happened (only a live
  `emergency` is sent).

`tests/test_integration.py`, `tests/test_server.py` and
`tests/test_dashboard_server.py` walk recorded messages for keys such as `p`,
`odds`, `outcomes`, `probability`, `roll`, `valence`, `due`, `scores` and
`pending_emergency` and fail if any appears.

Characters see less than God. A controller never sees a character's luck, other
characters' pages, the city's statistics, events, or the `model` of any
controller (its own included); God-only events (`richest`,
`controller_joined`, `controller_left`) never reach a character's memory.

## Worked example

A controller plays Tom and Ari; God watches. `>` is client to server, `<` is
server to client. State frames and `stats` pushes to God are trimmed.

```text
# God connects
> {"type": "hello", "role": "god", "req_id": 1}
< {"type": "welcome", "role": "god", "town": {...}, "state": {...}, "history": [...], "news": [...],
   "headlines": [...], "llm_log": [...], "host": {"kind": "server", "controllers": true},
   "stats": {"type": "stats", "full": true, ...}, "speed": 1, "req_id": 1}

# A controller connects and claims two characters
> {"type": "hello", "role": "controller", "name": "bot", "model": "claude-haiku-5-5", "characters": ["ari", "tom"]}
< {"type": "welcome", "role": "controller", "name": "bot", "characters": ["ari", "tom"],
   "profiles": {"ari": "Ari Ben-David, 24, junior developer. ...", "tom": "Tom Levi, 29, barista. ..."},
   "answer_seconds": 5, "time": "Day 1 Mon 06:01", "available": ["dana", "yossi", "..."]}

# God's next frame has the controller's event
< {"type": "state", "speed": 1, "state": {...}, "forks": [],
   "events": [{"seq": 3, "tick": 361, "time": "Day 1 Mon 06:01", "kind": "controller", "tag": "controller_joined",
               "importance": 1, "major": false, "text": "Ari Ben-David and Tom Levi are now played by bot.",
               "agent": null, "agents": ["ari", "tom"], "place": null, "at": null}]}

# The controller checks Ari's things before deciding anything
> {"type": "query", "agent_id": "ari", "what": "possessions", "req_id": "q1"}
< {"type": "answer", "agent_id": "ari", "what": "possessions",
   "data": {"home": {"id": "birch_court_2b", "place": "birch_court", "name": "Birch Court, flat 2B", "tier": "flat",
                     "tenure": "rented", "weekly_rent": 220, "weekly_cost": 220, "stage_name": "kept", "...": "..."},
            "car": false, "phone": {"condition": "cracked"}, "money": 412.0, "savings": 2500.0,
            "household_funds": 2912, "savings_goal": {"name": "a new phone", "target": 300, "saved": 0.0},
            "groceries_at_home": 8},
   "req_id": "q1"}

# Ari invites Tom for coffee
> {"type": "invite", "agent_id": "ari", "to": "tom", "place": "cafe"}
< {"type": "invited", "ok": true,
   "invite": {"id": "i1", "from": "ari", "to": "tom", "place": "cafe", "tick": 361, "status": "pending"}}

# When Tom is next free (in the hours the invite section gives), his invite fork reaches the controller
< {"type": "fork", "fork_id": "f5", "agent_id": "tom", "kind": "invite",
   "question": "Ari Ben-David invites you to Corner Cafe. What do you do?",
   "options": [{"index": 0, "label": "Accept and meet Ari at Corner Cafe", "cost": 0.0, "travel_minutes": 21},
               {"index": 1, "label": "Decline politely", "cost": 0.0},
               {"index": 2, "label": "Suggest another day instead", "cost": 0.0},
               {"index": 3, "label": "Ignore the message", "cost": 0.0}],
   "time": "Day 1 Mon 06:21", "deadline_seconds": 5.0, "weather": "rain", "season": "spring",
   "you": {"name": "Tom Levi", "profile": "...", "money": 250.0, "savings": 0.0, "household_funds": 3750,
           "needs": {"hunger": 66, "energy": 60, "social": 83, "fun": 86}, "health": 90,
           "where": "main_28", "where_name": "28 Main Street", "home_name": "28 Main Street",
           "home": {"name": "28 Main Street", "tier": "house", "tenure": "owned", "weekly_cost": 76,
                    "condition": 66, "stage_name": "worn", "value": 13650},
           "groceries_at_home": 8, "goal": {"name": "a guitar", "target": 450, "saved": 0.0}, "recent_memory": []}}

# The controller answers within 5 seconds
> {"type": "choose", "fork_id": "f5", "choice": 0, "reason": "Ari is a good friend.", "req_id": 3}
< {"type": "ack", "fork_id": "f5", "accepted": true, "applied": true, "req_id": 3}

# Ari is the host, so the same controller hears the answer
< {"type": "invite_answer", "invite_id": "i1", "from": "tom", "answer": "accept", "agent_id": "ari"}

# God sees the decision in the next state frame, and in the LLM decisions log
< {"type": "state", "speed": 1, "state": {...},
   "events": [{"seq": 4, "tick": 381, "time": "Day 1 Mon 06:21", "kind": "social", "tag": "invite_accepted",
               "importance": 1, "major": false, "text": "Tom Levi accepts Ari's invite.", "agent": "tom",
               "agents": ["tom", "ari"], "place": "cafe", "at": [14, 24]}, "..."],
   "forks": [{"id": "f5", "agent": "tom", "kind": "invite", "tick": 381, "time": "Day 1 Mon 06:21",
              "question": "Ari Ben-David invites you to Corner Cafe. What do you do?",
              "options": ["Accept and meet Ari at Corner Cafe", "Decline politely",
                          "Suggest another day instead", "Ignore the message"],
              "choice": 0, "decided_by": "model", "reason": "Ari is a good friend.", "happened": [],
              "major": false, "controller": "bot", "model": "claude-haiku-5-5", "answer_seconds": 0.8,
              "late": null, "profile_choice": 0, "place": "main_28"}]}

# Within 3 seconds the stats push counts it
< {"type": "stats", "full": false, ..., "llm": {"controllers": [{"name": "bot", "model": "claude-haiku-5-5", "characters": 2}],
   "playing": 2, "thinking": 0, "today": {"asked": 1, "in_time": 1, "...": "..."}, "...": "..."}, "samples": []}

# Once Tom's time at the cafe is over, its outcomes land and the same fork comes again
< {"type": "state", "speed": 1, "state": {...}, "events": [...],
   "forks": [{"id": "f5", "agent": "tom", "kind": "invite", ..., "choice": 0, "decided_by": "model",
              "reason": "Ari is a good friend.", "happened": ["Has a great time together"], ...}]}

# God, moved by the friendship, makes Tom luckier, then opens Tom's home
> {"type": "set_luck", "agent_id": "tom", "luck": 75, "req_id": 4}
< {"type": "luck_set", "ok": true, "agent_id": "tom", "luck": 75.0, "req_id": 4}
> {"type": "get_home", "home_id": "main_28", "req_id": 5}
< {"type": "home", "home": {"id": "main_28", "name": "28 Main Street", "tier": "house", "owner": "levi",
   "stage_name": "worn", "residents": ["Miriam Levi", "Tom Levi"], "...": "..."}, "req_id": 5}
```

A slow controller would instead see this after the 5 s deadline, while the
default plays:

```text
> {"type": "choose", "fork_id": "f5", "choice": 0, "reason": "Ari is a good friend."}
< {"type": "ack", "fork_id": "f5", "accepted": true, "applied": false, "note": "too late to act on; saved to the profile"}

# God's next frame has the fork again, decided by timeout, with the late answer
< {"type": "state", ..., "forks": [{"id": "f5", ..., "choice": 1, "decided_by": "timeout",
   "reason": "No answer in time; played the default.", "controller": "bot", "model": "claude-haiku-5-5",
   "answer_seconds": null, "late": {"choice": 0, "reason": "Ari is a good friend.", "seconds": 6.2}, ...}]}

# Changing its mind still inside the 10 s window teaches nothing more
> {"type": "choose", "fork_id": "f5", "choice": 1, "reason": "Actually, I'm tired."}
< {"type": "ack", "fork_id": "f5", "accepted": false, "error": "too late"}
```
