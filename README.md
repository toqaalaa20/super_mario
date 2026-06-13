# Super Mario

A two-agent Deliveroo system built on `@unitn-asa/deliveroo-js-sdk`:

- **BDI agent** (`src/bdi/`) — a classic belief-desire-intention loop that explores the map,
  picks up parcels, and delivers them using A* pathfinding.
- **LLM agent** (`src/llm/llm_agent.js`) — receives natural-language missions from the game chat,
  reasons about them with an LLM (ReAct-style tool loop), and either executes them itself or
  delegates sub-tasks to the BDI agent.

The two agents coordinate over the game chat: they exchange a handshake (`HELLO`), claim parcels
to avoid double-picking the same one, and the LLM agent can send the BDI agent structured
`MISSION` commands.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in the values:
   - `BDI_HOST` / `BDI_TOKEN` / `BDI_AGENT_NAME`: connection details for the BDI agent
   - `LLM_HOST` / `LLM_TOKEN` / `LLM_AGENT_NAME`: connection details for the LLM agent
   - `LITELLM_BASE_URL` / `LITELLM_API_KEY` / `LOCAL_MODEL`: OpenAI-compatible endpoint and model
     used by the LLM agent for reasoning

3. Run both agents:
   ```bash
   npm start
   ```
   This runs `node src/bdi/index.js` and `node src/llm/llm_agent.js` concurrently.

## Project layout

- `src/bdi/beliefs.js` — shared world state (map, parcels, agents, own position)
- `src/bdi/intentions.js` — intention selection: normal pickup/deliver/explore behaviour plus
  mission-driven intentions (`MOVE_TO_POSITION`, `STACK_SIZE`, `PREFERRED_DELIVERY`,
  `AVOID_TILE`, `SCORE_FILTER`, `COORDINATE_MEETUP`, `WAIT_FOR_SIGNAL`, `PICKUP_AND_DELIVER`)
- `src/bdi/executor.js` — turns the current intention into pickup/move/putdown actions
- `src/bdi/astar.js` — A* pathfinding over the map grid
- `src/bdi/explorer.js` — frontier-based exploration when there's nothing better to do
- `src/bdi/utils.js` — shared helpers (e.g. Manhattan distance)
- `src/bdi/index.js` — BDI agent entrypoint: connects to Deliveroo, runs the sensing loop, and
  listens for mission/claim messages from the LLM agent
- `src/llm/llm_agent.js` — LLM agent entrypoint: connects to Deliveroo, exposes a tool set
  (move, pickup, putdown, explore, query map/parcels, send missions to the BDI agent, etc.),
  and runs an LLM-driven ReAct loop to interpret and execute chat missions

## How mission coordination works

- The LLM agent classifies incoming chat missions as Level 1 (atomic actions), Level 2
  (persistent behaviour changes), or Level 3 (multi-agent coordination), and first checks
  whether the mission is actually profitable/well-defined before acting.
- Level 2/3 missions are sent to the BDI agent via a `MISSION` chat message
  (`{ cmd: 'MISSION', type, params, description }`); the BDI agent updates its
  `missionState` and adjusts intention selection accordingly.
- `MISSION_CLEAR` cancels the active mission on the BDI agent.
- `CLAIM` messages let either agent announce it's going for a specific parcel so the other
  doesn't target the same one.
