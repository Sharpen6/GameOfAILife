# GameOfAILife

A simulation game where AI agents live whole lives in a city (family, friends, work, money,
transport, communication) and the player is their God, acting only through minds and luck.

The design is in the project's game design document. This branch holds an early, untuned
Phase 1 prototype: a tick-based Python simulation of six agents with needs, jobs, rent,
travel and invitations. It is a draft and will change once the design is agreed.

    python3 -m gameofailife --days 3          # verbose event log
    python3 -m gameofailife --days 7 --quiet  # end-of-day summaries only
