# GameOfAILife WebSocket protocol

This is the complete reference for the one WebSocket endpoint the game server
exposes. Everything here is taken from `gameofailife/server.py` and
`gameofailife/sim.py`. If this document and the code disagree, the code is right
and this document has a bug.

- [Connecting](#connecting)
- [Message basics](#message-basics)
- [Hello and welcome](#hello-and-welcome)
- [God messages](#god-messages)
- [Controller messages](#controller-messages)
- [Server pushes](#server-pushes)
- [Answer windows: 5 seconds and 10 seconds](#answer-windows-5-seconds-and-10-seconds)
- [One God per city](#one-god-per-city)
- [Shared shapes](#shared-shapes)
- [Worked example](#worked-example)

## Connecting

Start the server with `python3 -m gameofailife` (options: `--host`, default
`127.0.0.1`; `--port`, default `8000`; `--speed`, one of `0 1 2 4 8 16`). The
same port serves two things:

- `http://host:port/` serves the web client from `client/` (the God view).
- `ws://host:port/ws` is the WebSocket endpoint. Any path other than `/ws`, or a
  request without `Upgrade: websocket`, is treated as a static file request.

The WebSocket is plain RFC 6455 with no subprotocol, no authentication and no
origin check. Only `ws://` is served (no TLS). `gameofailife/ws.py` has a small
stdlib client, `connect("ws://127.0.0.1:8000/ws")`, that tests and example
controllers can use.

Two roles share the endpoint. The first message you send picks yours:

| Role         | Who                                  | Can do                                                    |
|--------------|--------------------------------------|-----------------------------------------------------------|
| `god`        | The player's web view                | Watch the whole city, change luck, speed and profiles     |
| `controller` | Anything that plays characters (an LLM, a script, a person) | Claim characters, answer their forks, query them, send messages and invites |

## Message basics

- Every message in both directions is one JSON object in one text frame.
  Binary and fragmented frames are accepted and decoded as UTF-8. The largest
  accepted message is 4 MiB.
- Every message has a `type` field.
- A frame that is not valid JSON gets `{"type": "error", "error": "messages must be JSON"}`
  and the connection stays open.
- A frame that is valid JSON but not an object (an array, a number) is silently
  ignored.
- Until you have said `hello`, every message gets
  `{"type": "error", "error": "say hello first"}`.
- **`req_id`**: if a client message has a `req_id` field (any JSON value), the
  server copies it unchanged into the direct reply to that message, errors
  included. Pushes never carry a `req_id`. Use it to match replies to requests.
- A message whose fields have the wrong type usually gets
  `{"type": "error", "error": "bad message: <detail>"}` (the server catches
  `ValueError`, `TypeError` and `KeyError`). **Known issue:** other mistakes
  are not caught and end the connection without a close frame: a `set_profile`
  whose `prompt` is not a string or whose `traits` is not an object, and a
  controller `hello` whose `characters` is neither a list nor `"all"` (a number,
  for example). Send the documented types.
- Each request gets at most one direct reply, sent right away. Pushes (state
  frames, forks, messages) are sent by the server's frame loop, which runs every
  50 ms. So a direct reply can arrive before a push that the same request
  caused: `send_message` replies `sent` before the recipient's controller gets
  the `message` push.

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
  "state": { ...state... },
  "history": [ ...event, up to the last 80... ],
  "speed": 1
}
```

| Field     | Meaning |
|-----------|---------|
| `town`    | The static map, sent once. See [Town](#town). |
| `state`   | The current snapshot. See [State](#state). |
| `history` | The last 80 [events](#event), oldest first, so a new view can fill its log. |
| `speed`   | Current speed multiplier, one of `0 1 2 4 8 16`. |

If another God view is already connected, it is demoted (see
[One God per city](#one-god-per-city)).

### Controller

```json
{"type": "hello", "role": "controller", "name": "my-bot", "characters": ["ari", "tom"]}
```

| Field        | Required | Meaning |
|--------------|----------|---------|
| `name`       | no       | Your controller name, cut to 40 characters. Default `"controller"`. If the name is taken by a connected controller, the server appends `-2`, `-3`, ... until it is free. The final name is in the welcome. |
| `characters` | no       | A list of character ids to claim, or the string `"all"` to claim every living character no other controller holds. Default: claim nothing. Characters that are dead, unknown, or held by another controller are skipped without an error. |

Reply:

```json
{
  "type": "welcome",
  "role": "controller",
  "name": "my-bot",
  "characters": ["ari", "tom"],
  "profiles": {
    "ari": "Ari Ben-David, 24, junior developer. Never late for work, enjoys time alone, ignores their health, sticks to routine.",
    "tom": "Tom Levi, 29, barista. Ignores their health, never late for work, spends freely, enjoys time alone."
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

For each claimed character the server also logs an event of kind
`"controller"`: `"<Name> is now played by <controller>."`

### Bad hello

Any other `role` gets `{"type": "error", "error": "role must be god or controller"}`
and the server stops reading from the connection. Open a new connection to try
again.

Sending `hello` again after the welcome does not change your role; it gets
`unknown message type 'hello'`.

## God messages

Sent by a connection whose hello had `role: "god"`.

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
| `luck`     | Number. Clamped to 0..100. Default 50 if missing. |

Reply:

```json
{"type": "luck_set", "ok": true, "agent_id": "dana", "luck": 80.0}
```

`ok` is `false` and `luck` is `null` for an unknown id. Dead characters still
accept luck. A `luck` that is not a number gets a `bad message` error.

### `set_speed`

```json
{"type": "set_speed", "speed": 4}
```

`speed` must be one of `0 1 2 4 8 16`; any other integer sets speed `1`. A
non-integer string gets a `bad message` error; a float is truncated (`2.7` is
`2`). Speed `1` is one game day per ten real minutes (2.4 game minutes per real
second); `0` is paused.

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
| `traits`   | Optional object of trait name to number. Known traits are `thrift`, `family`, `social`, `diligence`, `health`, `adventure`; values are clamped to 0..1. Unknown names are ignored. If traits change and the prompt was never hand-edited, the prompt is regenerated from the traits. |

Reply: `{"type": "agent", "agent": { ...agent page... }}` with the updated page.
Unknown id: `{"type": "error", "error": "unknown character"}`.

### Errors

Any other `type` gets `{"type": "error", "error": "unknown message type '<type>'"}`.
Controller messages (`choose`, `claim`, `query`, ...) sent on a God connection
get this error too.

## Controller messages

Sent by a connection whose hello had `role: "controller"`. You can only act for
characters you hold; `query`, `send_message` and `invite` for anyone else get
`{"type": "error", "error": "not your character"}`.

### `choose`

Answer a [fork](#fork).

```json
{"type": "choose", "fork_id": "f2", "choice": 0, "reason": "Ari is a good friend and I am free."}
```

| Field     | Meaning |
|-----------|---------|
| `fork_id` | From the fork push. |
| `choice`  | Integer option index, 0 to 3. Must be a JSON integer: `"1"` or `1.0` is rejected. |
| `reason`  | Optional string, cut to 300 characters. Shown to God with the decided fork and saved in what the profile learned. |

Reply is an `ack`. Its fields depend on the result:

| Result | Reply |
|--------|-------|
| In time (within 5 s): the choice is played and teaches the profile. | `{"type": "ack", "fork_id": "f2", "accepted": true, "applied": true}` |
| Late (5 to 10 s, after the default was played): the choice is not played but still teaches the profile. | `{"type": "ack", "fork_id": "f2", "accepted": true, "applied": false, "note": "too late to act on; saved to the profile"}` |
| Fork already decided by an earlier answer, or the late window is closed. | `{"type": "ack", "fork_id": "f2", "accepted": false, "error": "too late"}` |
| Unknown or forgotten fork id (forks are forgotten 10 s after they were asked). | `{"type": "ack", "fork_id": "f2", "accepted": false, "error": "unknown fork"}` |
| The fork's character is not yours (for example you released it). | `{"type": "ack", "fork_id": "f2", "accepted": false, "error": "not your character"}` |
| `choice` is not an integer 0 to 3. | `{"type": "ack", "fork_id": "f2", "accepted": false, "error": "choice must be 0 to 3"}` |

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
`ok: true`. Unlike claims in the hello, this logs no event.

### `release`

Give a character back to its profile.

```json
{"type": "release", "agent_id": "dana"}
```

Reply: `{"type": "released", "agent_id": "dana"}`. The reply is the same
whether or not you held the character; only characters you hold are released.
If the character was waiting on a fork, that fork is no longer yours to answer
and times out to the default.

All your characters are released when your connection closes.

### `query`

Ask what one of your characters owns, is, or knows.

```json
{"type": "query", "agent_id": "ari", "what": "possessions"}
```

Reply:

```json
{"type": "answer", "agent_id": "ari", "what": "possessions", "data": { ... }}
```

`what` defaults to `"attributes"`. An unknown value gets
`{"type": "error", "error": "what must be one of ['attributes', 'inbox', 'memory', 'people', 'possessions', 'relationships', 'world']"}`.

| `what`          | `data` |
|-----------------|--------|
| `possessions`   | `{"home": {"place", "name", "tenure", "weekly_rent"}, "car": bool, "phone": {"condition": "fine" or "cracked"}, "money": number, "savings_goal": goal or null, "groceries_at_home": int}`. `tenure` is always `"rented"`. `goal` is `{"name", "target", "saved"}`. |
| `attributes`    | `{"age", "health", "mood", "needs": {"hunger", "energy", "social", "fun"}, "reputation", "job": job or null, "traits": {trait: 0..1}}`. Health, mood, needs and reputation are rounded to integers on a 0..100 scale. See [Job](#job). |
| `relationships` | Object of other character id to `{"kind", "affinity", "trust", "name"}`. `kind` is `partner`, `family`, `friend`, `coworker` or `acquaintance`; `affinity` is -100..100; `trust` is 0..100. |
| `memory`        | List of up to the last 30 memory strings, each `"<time stamp>: <text>"`. |
| `inbox`         | List of up to the last 20 `{"time", "from", "text"}`; `from` is a character id. Messages and invites land here. |
| `world`         | `{"time", "season", "weather", "places": {place id: {"name", "kind", "open": bool}}, "timetable"}`. See [Timetable](#timetable). |
| `people`        | Object of living character id to full name. |

The answer never contains hidden odds.

### `send_message`

One of your characters texts another character.

```json
{"type": "send_message", "agent_id": "ari", "to": "tom", "text": "Coffee later?"}
```

`text` is cut to 500 characters. Reply: `{"type": "sent", "ok": true}`, or
`{"type": "sent", "ok": false, "error": "unknown or dead character"}` when either
side is unknown or dead.

On success the text lands in the recipient's inbox (which keeps 30), both
characters gain a little social need, an event of kind `"message"` is logged,
and the recipient's controller, if any, gets a [`message`](#message) push.

### `invite`

One of your characters invites another to meet at a place.

```json
{"type": "invite", "agent_id": "ari", "to": "tom", "place": "cafe"}
```

`place` is a place id and defaults to `"cafe"`. Reply:

```json
{"type": "invited", "ok": true,
 "invite": {"id": "i1", "from": "ari", "to": "tom", "place": "cafe", "tick": 363, "status": "pending"}}
```

`ok` is `false` and `invite` is `null` if the guest is unknown or dead or the
place does not exist.

The guest gets `"Want to meet at <place name>?"` in their inbox. The guest's
controller gets **no** direct push for the invite: the next time the guest is
free, they meet an `invite` fork (accept, decline, suggest another day, ignore),
which reaches their controller as a normal [fork](#fork) unless the Director
decides it from habit. When the guest decides, your controller gets an
[`invite_answer`](#invite_answer) push. An invite not answered within 120 game
minutes expires silently (`status` becomes `"expired"`; nothing is pushed).

### Errors

Any other `type` gets `{"type": "error", "error": "unknown message type '<type>'"}`.
God messages (`set_luck`, `get_agent`, ...) sent on a controller connection get
this error too.

## Server pushes

Messages the server sends without being asked.

### State frame

To God (and demoted God views) only. Sent from the 50 ms frame loop whenever the
simulation advanced at least one game minute, or new events or decided forks
are waiting. At speed 1 that is about 2.4 frames a second; at higher speeds one
frame can cover several game minutes. Nothing is sent while paused unless
something happens (for example a controller sends a message).

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
| `state`  | Full snapshot, see [State](#state). |
| `events` | Every [event](#event) since the previous frame (possibly empty). |
| `forks`  | Every fork decided since the previous frame, see [Decided fork](#decided-fork). God sees forks only once decided, never while a controller is still thinking. |

### `fork`

To a controller, when one of its characters reaches a decision the Director
does not find obvious. (Obvious decisions are played from habit and never asked.
Characters without a controller play their profile default.)

```json
{
  "type": "fork",
  "fork_id": "f2",
  "agent_id": "tom",
  "kind": "invite",
  "question": "Ari Ben-David invites you to Corner Cafe. What do you do?",
  "options": [
    {"index": 0, "label": "Accept and meet Ari at Corner Cafe", "cost": 0.0, "travel_minutes": 22},
    {"index": 1, "label": "Decline politely", "cost": 0.0},
    {"index": 2, "label": "Suggest another day instead", "cost": 0.0},
    {"index": 3, "label": "Ignore the message", "cost": 0.0}
  ],
  "time": "Day 1 Mon 06:21",
  "deadline_seconds": 5.0,
  "weather": "rain",
  "season": "spring",
  "you": {
    "name": "Tom Levi",
    "profile": "Tom Levi, 29, barista. Ignores their health, never late for work, spends freely, enjoys time alone.",
    "money": 250.0,
    "needs": {"hunger": 65, "energy": 78, "social": 76, "fun": 59},
    "health": 90,
    "where": "home_levi",
    "groceries_at_home": 8,
    "goal": {"name": "a guitar", "target": 450, "saved": 0.0},
    "recent_memory": []
  }
}
```

| Field              | Meaning |
|--------------------|---------|
| `fork_id`          | Pass back in `choose`. Ids look like `f1`, `f2`, ... |
| `agent_id`         | Which of your characters is deciding. |
| `kind`             | One of `invite`, `work`, `sleep`, `hunger`, `payday`, `groceries`, `lonely`, `free_time`. |
| `question`         | The situation in plain language. |
| `options`          | Always exactly 4. `index` is what you send as `choice`; `cost` is money spent up front; `travel_minutes` (game minutes) is present only when the option starts somewhere other than where the character is now. Outcome odds are never included. |
| `time`             | Game time stamp. |
| `deadline_seconds` | Always `5.0`, real seconds. |
| `weather`          | `"clear"` or `"rain"`. |
| `season`           | `spring`, `summer`, `autumn` or `winter`. |
| `you.where`        | Place id the character is inside, or `"outside"`. |
| `you.needs`        | 0..100 each, higher is better (a high `hunger` means well fed). |
| `you.goal`         | Savings goal `{"name", "target", "saved"}` or `null`. |
| `you.recent_memory`| Last 5 memory strings. |

While a fork is open the character's `state` and `activity` are `"deciding"`
and the character stands still.

### `message`

To the controller of the character that received a `send_message`.

```json
{"type": "message", "from": "ari", "from_name": "Ari Ben-David", "to": "tom",
 "text": "Coffee later?", "time": "Day 1 Mon 06:01", "agent_id": "tom"}
```

`agent_id` (equal to `to`) is the character of yours the push is for.

### `invite_answer`

To the controller of a character whose invite was just answered.

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

The connection stays open and keeps receiving state frames. See
[One God per city](#one-god-per-city).

### `ack`

The reply to `choose`, described [above](#choose). Listed here because it is
the message a controller must watch for to learn whether its choice was played.

### `error`

```json
{"type": "error", "error": "<human-readable reason>"}
```

Sent as the direct reply to a bad request (with its `req_id`, if any). The
connection stays open, except after a bad hello role. All error strings:

| `error` | When |
|---------|------|
| `messages must be JSON` | A frame was not valid JSON. |
| `say hello first` | Any message before `hello`. |
| `role must be god or controller` | Bad hello role; the server stops reading. |
| `bad message: <detail>` | A field had an unusable value (for example `"luck": "lots"`). |
| `unknown message type '<type>'` | The type is not one your role can send. |
| `unknown character` | `get_agent` or `set_profile` with an unknown id. |
| `not your character` | `query`, `send_message` or `invite` for a character you do not hold. |
| `what must be one of [...]` | `query` with an unknown `what`. |
| `only God can do that; this view is watching` | A demoted view tried a God action (see the known issue below). |

## Answer windows: 5 seconds and 10 seconds

Both windows are real (wall-clock) seconds, measured from the moment the
Director asks, not game minutes. They do not depend on speed, and they keep
running while the game is paused.

1. **0 to 5 s.** A valid `choose` is played at once:
   `accepted: true, applied: true`. The fork is decided by `"model"`, the reason
   is kept, and the profile learns from the choice (traits move a little towards
   the option's style, and the prompt is regenerated unless it was hand-edited).
2. **At 5 s** without an answer, the Director plays the profile default. The
   fork is decided by `"timeout"` and God sees it in the next state frame.
3. **5 to 10 s.** A `choose` for a fork decided by timeout is not played, but it
   is saved and teaches the profile exactly as an in-time answer would:
   `accepted: true, applied: false`. The next fork of that kind is then more
   likely to go the way the controller wanted, even if the controller is slow.
4. **After 10 s** the server forgets the fork: `choose` gets `"unknown fork"`.

Only the first answer counts. A second `choose` for a fork already decided by
your earlier answer gets `"too late"`.

`decided_by` in a [decided fork](#decided-fork) tells God who made each call:

| `decided_by` | Meaning |
|--------------|---------|
| `habit`   | Obvious from the character's habits; nobody was asked. |
| `default` | No controller; played from the profile. |
| `model`   | The controller answered in time. |
| `timeout` | A controller was asked and did not answer in 5 s; the profile default was played. |

## One God per city

There is one God per city. When a God hello arrives while a God view is already
connected, the newest view takes over: the old view is sent
[`demoted`](#demoted), keeps its connection, and keeps receiving state frames as
a watcher. When the current God view disconnects, nobody is promoted; the next
God hello takes over.

The intended rule is that a demoted view can only watch: `set_luck`,
`set_speed`, `pause`, `resume` and `set_profile` from it should get
`only God can do that; this view is watching`, while `get_agent` still works.
**Known issue:** the current server does not enforce this, and a demoted view's
God actions still take effect. Do not rely on the old view being read-only.

Controllers are not limited: any number can connect, each holding its own set of
characters. A character is held by at most one controller at a time.

## Shared shapes

### Time stamps

`time` fields are strings like `"Day 3 Wed 14:05"`: the day number from 1, a
weekday from `Mon` to `Sun`, and the 24-hour time. One tick is one game minute.
The world starts on Day 1, Monday, 06:00 (tick 360).

### Town

Sent once in the God welcome.

| Field       | Meaning |
|-------------|---------|
| `w`, `h`    | Map size in tiles (40 x 25). |
| `tiles`     | `h` strings of `w` characters: `.` grass, `#` road, `B` building, `D` door, `P` park, `T` tree, `e` entry tile. |
| `places`    | List of `{"id", "name", "kind", "x", "y", "w", "h", "entry": [x, y], "hours": [open, close] or null}`. `kind` is `home`, `office`, `school`, `hospital`, `market`, `cafe` or `park`. `hours: null` means always open. |
| `road_rows`, `road_cols` | Tile rows and columns that are roads; their crossings have traffic lights. |
| `timetable` | See [Timetable](#timetable). |

### Timetable

```json
{"bus": {"route": "Ring road loop", "stops": [[3, 3], [14, 3], "..."], "minutes_per_loop": 122},
 "flights": ["08:00 Riverton to Lakeside", "14:00 Riverton to Lakeside", "20:00 Riverton to Lakeside"]}
```

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
| `lights`  | `{"ns": color, "ew": color}`, each `green`, `yellow` or `red`. |
| `bus`     | `{"x", "y", "stopped": bool}`. |
| `plane`   | `{"progress": 0..1, "from": "Riverton", "to": "Lakeside"}` during a flight, else `null`. |
| `agents`  | Every character, living or dead: `{"id", "name", "x", "y", "inside", "state", "activity", "vehicle", "mood", "luck", "controller", "alive", "age"}`. `inside` is a place id or `null` (on the map). `state` is `idle`, `deciding`, `travelling`, `busy` or `dead`. `vehicle` is `walk`, `run` or `car`. `mood` and `luck` are rounded to integers. `controller` is the controller name or `null`. |

### Event

```json
{"tick": 363, "time": "Day 1 Mon 06:03", "kind": "social", "text": "Ari Ben-David invites Tom Levi to Corner Cafe.", "agent": "ari"}
```

`agent` is the character id the event is about, or `null`. `kind` is one of
`life`, `weather`, `money`, `health`, `death`, `outcome`, `social`, `goal`,
`message`, `controller`.

### Decided fork

In the `forks` list of state frames and in the agent page.

```json
{"id": "f2", "agent": "tom", "kind": "invite", "time": "Day 1 Mon 06:21",
 "question": "Ari Ben-David invites you to Corner Cafe. What do you do?",
 "options": ["Accept and meet Ari at Corner Cafe", "Decline politely", "Suggest another day instead", "Ignore the message"],
 "choice": 0, "decided_by": "model", "reason": "Ari is a good friend.", "happened": []}
```

`options` are the four labels; `choice` is the index played. `happened` lists
the labels of hidden outcomes that came true. It is usually empty when the
fork is first pushed, because outcomes land once the plan is carried out; the
agent page shows it filled in later.

### Job

`{"title", "place", "hourly_wage", "hours": [start_hour, end_hour], "workdays": [0..6, ...]}`.
`place` is a place id; workday 0 is Monday.

### Agent page

The reply to `get_agent` and `set_profile`.

| Field           | Meaning |
|-----------------|---------|
| `id`, `name`, `age`, `alive` | Identity. |
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
| `possessions`   | Same as `query` `possessions`. |
| `relationships` | Same as `query` `relationships`, ordered by affinity, highest first. |
| `memory`        | Last 15 memory strings. |
| `inbox`         | Last 10 inbox entries. |
| `forks`         | Last 10 [decided forks](#decided-fork). |
| `household`     | Names of the living people in the character's home. |

## Worked example

A controller plays Tom and Ari; God watches. `>` is client to server, `<` is
server to client. State frames to God are trimmed.

```text
# God connects
> {"type": "hello", "role": "god"}
< {"type": "welcome", "role": "god", "town": {...}, "state": {...}, "history": [...], "speed": 1}

# A controller connects and claims two characters
> {"type": "hello", "role": "controller", "name": "bot", "characters": ["ari", "tom"]}
< {"type": "welcome", "role": "controller", "name": "bot", "characters": ["ari", "tom"],
   "profiles": {"ari": "Ari Ben-David, 24, junior developer. ...", "tom": "Tom Levi, 29, barista. ..."},
   "answer_seconds": 5, "time": "Day 1 Mon 06:01", "available": ["dana", "yossi", "..."]}

# The controller checks Ari's things before deciding anything
> {"type": "query", "agent_id": "ari", "what": "possessions", "req_id": "q1"}
< {"type": "answer", "agent_id": "ari", "what": "possessions",
   "data": {"home": {"place": "home_bendavid", "name": "Ari's flat", "tenure": "rented", "weekly_rent": 260},
            "car": false, "phone": {"condition": "cracked"}, "money": 412.0,
            "savings_goal": {"name": "a new phone", "target": 300, "saved": 0.0}, "groceries_at_home": 8},
   "req_id": "q1"}

# Ari invites Tom for coffee
> {"type": "invite", "agent_id": "ari", "to": "tom", "place": "cafe"}
< {"type": "invited", "ok": true,
   "invite": {"id": "i1", "from": "ari", "to": "tom", "place": "cafe", "tick": 363, "status": "pending"}}

# When Tom is next free, his invite fork reaches the controller
< {"type": "fork", "fork_id": "f2", "agent_id": "tom", "kind": "invite",
   "question": "Ari Ben-David invites you to Corner Cafe. What do you do?",
   "options": [{"index": 0, "label": "Accept and meet Ari at Corner Cafe", "cost": 0.0, "travel_minutes": 22},
               {"index": 1, "label": "Decline politely", "cost": 0.0},
               {"index": 2, "label": "Suggest another day instead", "cost": 0.0},
               {"index": 3, "label": "Ignore the message", "cost": 0.0}],
   "time": "Day 1 Mon 06:21", "deadline_seconds": 5.0, "weather": "rain", "season": "spring",
   "you": {"name": "Tom Levi", "profile": "...", "money": 250.0,
           "needs": {"hunger": 65, "energy": 78, "social": 76, "fun": 59}, "health": 90,
           "where": "home_levi", "groceries_at_home": 8,
           "goal": {"name": "a guitar", "target": 450, "saved": 0.0}, "recent_memory": []}}

# The controller answers within 5 seconds
> {"type": "choose", "fork_id": "f2", "choice": 0, "reason": "Ari is a good friend.", "req_id": 3}
< {"type": "ack", "fork_id": "f2", "accepted": true, "applied": true, "req_id": 3}

# Ari is the host, so the same controller hears the answer
< {"type": "invite_answer", "invite_id": "i1", "from": "tom", "answer": "accept", "agent_id": "ari"}

# God sees the decision in the next state frame
< {"type": "state", "speed": 1, "state": {...},
   "events": [{"tick": 381, "time": "Day 1 Mon 06:21", "kind": "social",
               "text": "Tom Levi accepts Ari's invite.", "agent": "tom"}],
   "forks": [{"id": "f2", "agent": "tom", "kind": "invite", "time": "Day 1 Mon 06:21",
              "question": "Ari Ben-David invites you to Corner Cafe. What do you do?",
              "options": ["Accept and meet Ari at Corner Cafe", "Decline politely",
                          "Suggest another day instead", "Ignore the message"],
              "choice": 0, "decided_by": "model", "reason": "Ari is a good friend.", "happened": []}]}

# God, moved by the friendship, makes Tom luckier
> {"type": "set_luck", "agent_id": "tom", "luck": 75, "req_id": 1}
< {"type": "luck_set", "ok": true, "agent_id": "tom", "luck": 75.0, "req_id": 1}
```

A slow controller would instead see this after the 5 s deadline, while the
default plays:

```text
> {"type": "choose", "fork_id": "f2", "choice": 0, "reason": "Ari is a good friend."}
< {"type": "ack", "fork_id": "f2", "accepted": true, "applied": false, "note": "too late to act on; saved to the profile"}
```
