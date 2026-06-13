# PDDL Planner Integration for Agent A (BDI)

## Context

The course requires identifying where a PDDL planner improves the BDI architecture, extending the agent accordingly, and discussing the improvement in the report. Agent A's current intention selection (`reviseIntention()` in `src/bdi/intentions.js`) picks the next parcel to pick up / deliver via a **greedy nearest/best-ratio heuristic** (`reward / (distance+1)`), with no lookahead. This can produce suboptimal routes when multiple parcels are visible (e.g. grabbing a low-value parcel first forces backtracking for a high-value one).

The plan: model the **pickup/delivery sequencing problem** as PDDL (domain + generated problem), solve it via a **real external PDDL solver** (the hosted `solver.planning.domains` Planning-as-a-Service, same backend used by editor.planning.domains/paas-uom.org), and feed the resulting ordered plan into Agent A as a queue of intentions. A* (`astar.js`) and the executor remain unchanged — they execute each step of the plan exactly as they execute greedy-chosen targets today. Other agents and transient blockages stay out of the PDDL model (handled reactively by A*/executor, per earlier discussion); only `claimedByOther` and mission filters (AVOID_TILE, SCORE_FILTER, PREFERRED_DELIVERY) feed into the problem generation.

This only touches Agent A. Level 3 mission types (`COORDINATE_MEETUP`, `WAIT_FOR_SIGNAL`, `PICKUP_AND_DELIVER`, `MOVE_TO_POSITION`) keep their existing Stage-0 override logic untouched — PDDL sequencing applies to the "normal"/Stage 1+2 pickup-delivery flow (including STACK_SIZE/PREFERRED_DELIVERY/AVOID_TILE/SCORE_FILTER, which become problem-generation filters).

## New files (under `src/bdi/pddl/`)

### 1. `domain.pddl` (static, hand-written)
Defines the abstract sequencing domain — locations are waypoints (agent's current position, visible free parcel positions, delivery tile positions), not grid cells:

```pddl
(define (domain deliveroo)
  (:requirements :typing :fluents :action-costs)
  (:types location parcel)
  (:predicates
    (agent-at ?l - location)
    (parcel-at ?p - parcel ?l - location)
    (carrying ?p - parcel)
    (delivered ?p - parcel)
    (is-delivery ?l - location))
  (:functions
    (distance ?l1 ?l2 - location)
    (total-cost))

  (:action move
    :parameters (?from ?to - location)
    :precondition (agent-at ?from)
    :effect (and (not (agent-at ?from)) (agent-at ?to)
                  (increase (total-cost) (distance ?from ?to))))

  (:action pickup
    :parameters (?p - parcel ?l - location)
    :precondition (and (agent-at ?l) (parcel-at ?p ?l))
    :effect (and (not (parcel-at ?p ?l)) (carrying ?p)))

  (:action deliver
    :parameters (?p - parcel ?l - location)
    :precondition (and (agent-at ?l) (carrying ?p) (is-delivery ?l))
    :effect (and (not (carrying ?p)) (delivered ?p))))
```
This file is checked into the repo and is also the artifact validated manually in editor.planning.domains for the report (paste domain + a sample generated problem, run `lama-first`, screenshot the visualized plan).

### 2. `problemGenerator.js`
`buildProblem(beliefs, missionState)` → returns PDDL problem text (string) plus a `locationMap` (location-name → {x,y} and → parcel/delivery id) needed to translate the solved plan back into game targets.

- Candidate locations: agent's current position (`loc-agent`), each candidate free parcel position (`loc-p<id>`), each candidate delivery tile (`loc-d<i>`).
- Candidate parcels: `beliefs.carrying` (must all be delivered) + top-K `freeParcels()` by `reward/(dist+1)` (K capped, e.g. 4, to bound problem size), filtered through existing `parcelAllowed()`/AVOID_TILE/SCORE_FILTER logic from `intentions.js` (export/reuse these helpers).
- Candidate delivery tiles: nearest 2-3 from `deliveryTiles()`, ordered via existing `sortDeliveryTiles()` (PREFERRED_DELIVERY-aware).
- `distance(l1,l2)`: Manhattan distance between the two tile coordinates (consistent with the existing A* heuristic; cheap O(n²) for n≤~10, no extra A* calls needed).
- `:init`: `agent-at loc-agent`, `parcel-at p<id> loc-p<id>` for free candidates, `carrying p<id>` for currently-carried, `is-delivery loc-d<i>` for each delivery candidate, all pairwise `(= (distance l1 l2) ...)`, `(= (total-cost) 0)`.
- `:goal`: `(and (delivered p1) (delivered p2) ...)` for every candidate parcel (carried + selected free ones).
- `:metric minimize (total-cost)`.

### 3. `plannerClient.js`
`solve(domainText, problemText)` → async, returns `{ plan: string[] }` or `null` on failure/timeout.

- POST `{PDDL_SOLVER_URL}/package/{PDDL_PLANNER}/solve` with `{ domain, problem }` (config via `.env`: `PDDL_SOLVER_URL` default `https://solver.planning.domains:5001`, `PDDL_PLANNER` default `lama-first`).
- Poll the returned result URL every 0.5s until `status !== 'PENDING'`, with an overall timeout (e.g. 8s) — on timeout or any HTTP/network error, log a warning and return `null` (caller falls back to greedy).
- Parse `result.result.output.sas_plan` / plan field into an array of action strings like `move loc-agent loc-p3`, `pickup p3 loc-p3`, `deliver p3 loc-d1`.

### 4. `planTranslator.js`
`translatePlan(planActions, locationMap)` → ordered array of BDI intentions `{type: INTENTION.PICKUP, target: parcel}` / `{type: INTENTION.DELIVER, target: deliveryTile}`, dropping `move` actions (A* handles movement between these waypoints implicitly — the executor already paths to whatever target the intention carries).

## Changes to `src/bdi/intentions.js`

- Add module state: `plannedQueue = []`, `plannerStatus = 'idle' | 'pending'`, `lastPlannedSignature = null`.
- New helper `computeSignature(beliefs)`: a cheap string/hash of `[carrying ids sorted, freeParcels candidate ids sorted, missionState.type]` — used to detect "significant belief change" without replanning every tick.
- In `reviseIntention()`, **before** Stage 1/2 (but after Stage 0 mission overrides for Level 3 types, which bypass PDDL entirely):
  1. If `plannedQueue` non-empty: validate its head (target parcel still in `freeParcels()`/`carrying`, target delivery still valid) — if valid, return it as the intention (existing CLAIM-on-pickup logic in `index.js` is unaffected since it reads `getCurrentIntention()` as before). Pop the head when the BDI loop detects it was completed (pickup/deliver succeeded — detect via `beliefs.carrying`/`carriedParcels` change between ticks, tracked with a small bit of state already similar to `pickupAndDeliverStuckTicks`).
  2. If queue is empty/invalid AND `plannerStatus === 'idle'` AND `computeSignature(beliefs) !== lastPlannedSignature` AND mission type is one PDDL applies to (none, STACK_SIZE, PREFERRED_DELIVERY, AVOID_TILE, SCORE_FILTER): kick off `triggerReplan(beliefs, missionState)` **without awaiting** (fire-and-forget async function that sets `plannerStatus='pending'`, calls `buildProblem` + `solve` + `translatePlan`, then sets `plannedQueue` and `plannerStatus='idle'` when done; on failure just sets `plannerStatus='idle'` leaving queue empty).
  3. Fall through to existing greedy Stage 1/2/3 logic exactly as today — this is the fallback used whenever the queue is empty (including while a plan request is pending), so behavior degrades gracefully and the agent never stalls waiting on the network.

This keeps `reviseIntention()` synchronous and non-blocking; the planner call happens in the background and its result is simply "available or not" on subsequent ticks.

## Config

Add to `.env.example` (and document in README):
```
PDDL_SOLVER_URL=https://solver.planning.domains:5001
PDDL_PLANNER=lama-first
PDDL_ENABLED=true
```
`PDDL_ENABLED=false` short-circuits step 2 above entirely (pure greedy), useful for A/B comparison for the report.

## Verification

1. **Unit-level**: small standalone script (`src/bdi/pddl/__manual_test.js`, not part of normal run) that constructs a fake `beliefs` object with a couple of parcels/deliveries, calls `buildProblem`, prints the generated `problem.pddl`, and (optionally) calls `solve()` against the live hosted solver to confirm connectivity and parse the returned plan with `translatePlan`.
2. **External validation for the report**: paste `domain.pddl` + one generated `problem.pddl` sample into editor.planning.domains, run `lama-first`, screenshot the resulting plan/visualization.
3. **End-to-end**: run `npm start` against the game server with `PDDL_ENABLED=true`, watch console logs (add a log line when a plan is received and applied) to confirm the queue is populated and followed; compare total delivered score over a fixed-duration run vs `PDDL_ENABLED=false` (greedy-only) on the same map — this comparison is the "improvement" evidence for the report.
4. Confirm Level 3 missions (`COORDINATE_MEETUP`, `PICKUP_AND_DELIVER`, etc.) still behave as before — PDDL path is skipped for those mission types.
