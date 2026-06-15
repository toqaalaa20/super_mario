import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import { beliefs, updateFromSensing, setMap } from '../bdi/beliefs.js';
import { reviseIntention, getCurrentIntention, INTENTION, setMissionState, missionState } from '../bdi/intentions.js';
import { executePlan } from '../bdi/executor.js';
import { explorePath } from '../bdi/explorer.js';
import { manhattan } from '../bdi/utils.js';
import { buildPickupAndDeliverProblem, buildMeetupProblem, buildHandoffDropProblem } from '../bdi/pddl/level3ProblemGenerator.js';
import { solve } from '../bdi/pddl/plannerClient.js';
import { translatePlan, translateMeetupPlan, extractHandoffDrop } from '../bdi/pddl/planTranslator.js';

const __llmDirname = path.dirname(fileURLToPath(import.meta.url));
const DOMAIN_PDDL = fs.readFileSync(path.join(__llmDirname, '../bdi/pddl/domain.pddl'), 'utf-8');
const DOMAIN_HANDOFF_PDDL = fs.readFileSync(path.join(__llmDirname, '../bdi/pddl/domain_handoff.pddl'), 'utf-8');

// ─── LLM client ───────────────────────────────────────────────────────────────

const llm = new OpenAI({
    baseURL: process.env.LITELLM_BASE_URL || 'https://llm.bears.disi.unitn.it/v1',
    apiKey: process.env.LITELLM_API_KEY,
    timeout: 30_000, // 30s — fail fast so retries kick in quickly
});
const MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';

if (!process.env.LITELLM_API_KEY) {
    console.error('[LLM] Missing LITELLM_API_KEY'); process.exit(1);
}

// ─── Deliveroo connection (LLM agent's own token) ─────────────────────────────

const socket = new DjsConnect(
    process.env.LLM_HOST || 'http://localhost:8080',
    process.env.LLM_TOKEN,
);

socket.onConnect(() => {
    console.log('[LLM] Connected to Deliveroo');
    setTimeout(() => socket.emitShout(JSON.stringify({ cmd: 'HELLO' })), 1000);
});

// ─── Local state ──────────────────────────────────────────────────────────────

const me = { id: null, name: null, x: null, y: null, score: 0 };
let mapTiles = [];
let visibleParcels = [];

let positionUpdateResolvers = [];

socket.onYou(({ id, name, x, y, score }) => {
    Object.assign(me, { id, name, x, y, score });
    beliefs.me = me; // share reference so BDI modules always see current position

    const resolvers = positionUpdateResolvers;
    positionUpdateResolvers = [];
    resolvers.forEach(resolve => resolve());
});

// Wait for the next server-confirmed position update (or timeout) — keeps
// move_to's loop paced on confirmed state instead of racing ahead on the
// executor's optimistic local position update.
function waitForPositionUpdate(timeoutMs = 1000) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        positionUpdateResolvers.push(() => { clearTimeout(timer); resolve(); });
    });
}

socket.on('map', (width, height, tiles) => {
    mapTiles = tiles;
    setMap(tiles);
    const deliveryTiles = tiles.filter(t => t.delivery === true || t.type === '2').map(t => ({ x: t.x, y: t.y }));
    console.log('[LLM] Delivery tiles:', deliveryTiles);
});

let loopRunning = false;
let lastClaimedId = null;
let handoffParcelId = null; // parcel just handed off to BDI via PICKUP_AND_DELIVER
let handoffDropPos = null; // drop (x,y) for a handoff whose parcelId wasn't known yet
let lastBdiPosition = null;
const pendingSignalResolvers = [];
let pendingAutoGreenMs = null; // set when mission text contains a duration

socket.onSensing(async ({ parcels, agents }) => {
    visibleParcels = parcels ?? [];
    updateFromSensing({ parcels, agents });

    // If PICKUP_AND_DELIVER was sent without a resolved parcelId (the parcel
    // wasn't visible in beliefs yet at putdown time), keep checking each tick
    // for a parcel appearing at the drop point and claim it as soon as it does
    // — otherwise our own reviseIntention() could re-pick-up the parcel we just
    // handed off before it's marked as claimed.
    if (handoffDropPos && !handoffParcelId) {
        const atDrop = [...beliefs.parcels.values()]
            .find(p => p.x === handoffDropPos.x && p.y === handoffDropPos.y && !p.carriedBy);
        if (atDrop) {
            handoffParcelId = atDrop.id;
            handoffDropPos = null;
            console.log(`[LLM] Resolved PICKUP_AND_DELIVER parcelId ${atDrop.id} from drop position`);
        }
    }

    // Keep treating the just-handed-off parcel as claimed by the BDI until it
    // actually picks it up. Without this, normal-operation reviseIntention()
    // can re-pick-up and self-deliver the parcel before the BDI's own CLAIM
    // message round-trips back to us.
    if (handoffParcelId) {
        if (beliefs.parcels.has(handoffParcelId)) {
            beliefs.claimedByOther.set('handoff', handoffParcelId);
        } else {
            handoffParcelId = null;
        }
    }

    if (missionRunning || loopRunning || !beliefs.me) return;
    loopRunning = true;
    try {
        reviseIntention();
        const intent = getCurrentIntention();
        if (intent?.type === INTENTION.PICKUP && intent.target?.id !== lastClaimedId) {
            lastClaimedId = intent.target.id;
            if (bdiAgentId) {
                socket.emitSay(bdiAgentId, JSON.stringify({ cmd: 'CLAIM', parcelId: intent.target.id }));
                console.log('[LLM] Claimed parcel:', intent.target.id, '→ BDI');
            } else {
                console.log('[LLM] Claim skipped — BDI ID not yet known');
            }
        }
        if (intent) await executePlan(socket, intent);
    } catch (err) {
        console.error('[LOOP ERROR]', err.message);
    } finally {
        loopRunning = false;
    }
});

// ─── Tools ────────────────────────────────────────────────────────────────────

// Safe arithmetic evaluator — supports + - * / ( ) and numbers only.
// Avoids eval() so chat-driven LLM input can never reach arbitrary JS execution.
function calculate(expression) {
    try {
        const tokens = expression.match(/\d+(?:\.\d+)?|[+\-*/()]/g) ?? [];
        if (tokens.join('') !== expression.replace(/\s+/g, '')) {
            return `Error: invalid characters in expression '${expression}'.`;
        }

        let pos = 0;
        const peek = () => tokens[pos];
        const next = () => tokens[pos++];

        function parseExpr() {
            let value = parseTerm();
            while (peek() === '+' || peek() === '-') {
                const op = next();
                value = op === '+' ? value + parseTerm() : value - parseTerm();
            }
            return value;
        }
        function parseTerm() {
            let value = parseFactor();
            while (peek() === '*' || peek() === '/') {
                const op = next();
                value = op === '*' ? value * parseFactor() : value / parseFactor();
            }
            return value;
        }
        function parseFactor() {
            if (peek() === '-') { next(); return -parseFactor(); }
            if (peek() === '(') {
                next();
                const value = parseExpr();
                if (next() !== ')') throw new Error('mismatched parentheses');
                return value;
            }
            const tok = next();
            if (tok === undefined || /[^0-9.]/.test(tok)) throw new Error(`unexpected token '${tok}'`);
            return parseFloat(tok);
        }

        const result = parseExpr();
        if (pos !== tokens.length) throw new Error('unexpected trailing input');
        return String(result);
    } catch (e) {
        return `Error: ${e.message}`;
    }
}

function manhattanDistance(args) {
    // Prefer explicitly labeled x1/y1/x2/y2 — robust regardless of the order
    // the LLM writes them in.
    const named = {};
    for (const m of args.matchAll(/(x1|y1|x2|y2)\s*=\s*(-?\d+)/gi)) {
        named[m[1].toLowerCase()] = parseInt(m[2]);
    }
    if (['x1', 'y1', 'x2', 'y2'].every(k => k in named)) {
        return String(manhattan({ x: named.x1, y: named.y1 }, { x: named.x2, y: named.y2 }));
    }

    // Fallback: take the four numbers in positional order.
    const matches = [...args.matchAll(/-?\d+/g)].map(m => parseInt(m[0]));
    if (matches.length < 4) return `Error: could not parse two (x,y) pairs from '${args}'.`;
    const [ax, ay, bx, by] = matches;
    return String(manhattan({ x: ax, y: ay }, { x: bx, y: by }));
}

function snapPosition() {
    if (me.x === null || me.y === null) return null;
    return { ...me, x: Math.round(me.x), y: Math.round(me.y) };
}

async function applyMove(direction) {
    const from = `${me.x},${me.y}`;
    const result = await socket.emitMove(direction);
    if (!result) return false;
    Object.assign(me, { x: result.x, y: result.y });
    console.log(`[EXECUTOR] ${me.name} moved ${direction}: (${from}) -> (${me.x},${me.y})`);
    return true;
}

async function getMyPosition() {
    if (me.x === null) return 'Error: position not available yet.';
    return JSON.stringify({ x: me.x, y: me.y, score: me.score, name: me.name });
}

function getCarriedParcels() {
    return JSON.stringify(beliefs.carrying.map(id => ({
        id,
        reward: beliefs.carriedParcels.get(id)?.reward ?? null,
    })));
}

async function moveTo(args) {
    const match = args.match(/x\s*=?\s*(-?\d+)[,\s]+y\s*=?\s*(-?\d+)/i)
        || args.match(/(-?\d+)[,\s]+(-?\d+)/);
    if (!match) return `Error: could not parse target coordinates from '${args}'.`;
    const tx = parseInt(match[1]), ty = parseInt(match[2]);

    const targetTile = beliefs.map.find(t => t.x === tx && t.y === ty);
    if (!targetTile || targetTile.type === '0') {
        return `Error: (${tx}, ${ty}) is not a valid tile on the map.`;
    }

    // Drive movement through the same BDI logic (missionState + reviseIntention + executePlan)
    // the BDI agent uses, so both agents navigate identically.
    setMissionState({
        active: true,
        type: 'MOVE_TO_POSITION',
        params: { x: tx, y: ty, reward: 0 },
        description: `Move to (${tx},${ty})`,
    });

    while (true) {
        if (!missionState.active) break;
        reviseIntention();
        if (!missionState.active) break; // mission completed during this revision — don't execute a leftover intention
        const intent = getCurrentIntention();
        if (!intent) break;
        const moved = await executePlan(socket, intent);
        if (moved) await waitForPositionUpdate(); // pace on server-confirmed position, like the BDI's onSensing loop
        else await sleep(100); // yield to event loop so socket I/O can process
    }

    setMissionState({ active: false, type: null, params: {}, description: '' });
    const mx = Math.round(beliefs.me?.x ?? me.x);
    const my = Math.round(beliefs.me?.y ?? me.y);
    if (mx === tx && my === ty) return `Reached (${tx}, ${ty}).`;
    return `Stopped at (${mx}, ${my}). Target was (${tx}, ${ty}).`;
}

// Repeatedly walk toward exploration frontiers in a single tool call, instead of
// requiring one LLM round-trip per frontier (which made exploration very slow).
// Stops early if a profitable parcel comes into view.
const EXPLORE_STEP_BUDGET = 15;

async function explore() {
    let totalSteps = 0;
    let lastPos = null;

    while (totalSteps < EXPLORE_STEP_BUDGET) {
        if (visibleParcels.some(p => !p.carriedBy && p.reward > 5)) {
            return `Stopped exploring after ${totalSteps} step(s) — a parcel is now visible. Current position: (${Math.round(me.x)}, ${Math.round(me.y)}).`;
        }

        const current = snapPosition();
        if (!current) return 'Error: position not available yet.';
        const path = explorePath(current);
        if (path.length === 0) break;

        const direction = path[0];
        const ok = await applyMove(direction);
        if (!ok) break;
        totalSteps++;

        const pos = `${me.x},${me.y}`;
        if (pos === lastPos) break; // not actually moving — avoid spinning in place
        lastPos = pos;
    }

    if (totalSteps === 0) return 'Error: no exploration path found.';
    return `Completed exploration: ${totalSteps} step(s). Current position: (${Math.round(me.x)}, ${Math.round(me.y)}).`;
}

async function pickup() {
    const result = await socket.emitPickup();
    if (result && result.length > 0)
        return `Picked up ${result.length} parcel(s): ${result.map(p => p.id).join(', ')}.`;
    return 'No parcels to pick up here.';
}

async function putdown() {
    if (handoffMissionActive) {
        const pos = snapPosition();
        const tile = pos && beliefs.map.find(t => t.x === pos.x && t.y === pos.y);
        if (tile && (tile.delivery === true || tile.type === '2')) {
            return `Error: (${pos.x},${pos.y}) is a delivery tile — putting the parcel down here would auto-deliver it immediately, leaving nothing for the BDI to pick up. Use move_to to reach a non-delivery tile first (check get_delivery_tiles()), then call putdown() again.`;
        }
    }
    const result = await socket.emitPutdown();
    if (result && result.length > 0) {
        // emitPutdown() with no args drops everything we're carrying — mirror that
        // in beliefs so reviseIntention() doesn't think we still have cargo to
        // deliver once the mission turn ends and normal sensing resumes.
        for (const p of result) {
            beliefs.carrying = beliefs.carrying.filter(id => id !== p.id);
            beliefs.carriedParcels.delete(p.id);
        }
        return `Put down ${result.length} parcel(s): ${result.map(p => p.id).join(', ')}.`;
    }
    return 'No parcels to put down.';
}

function getVisibleParcels() {
    const claimed = new Set(beliefs.claimedByOther.values());
    return JSON.stringify(visibleParcels.map(p => ({
        id: p.id, x: p.x, y: p.y, reward: p.reward, carriedBy: p.carriedBy ?? null,
        claimedByPartner: claimed.has(p.id),
    })));
}

function getDeliveryTiles() {
    const tiles = mapTiles.filter(t => t.delivery === true || t.type === '2');
    return JSON.stringify(tiles.map(t => ({ x: t.x, y: t.y })));
}

function getMapInfo() {
    return JSON.stringify({
        totalTiles: mapTiles.length,
        deliveryTiles: mapTiles.filter(t => t.delivery || t.type === '2').length,
        myPosition: { x: me.x, y: me.y },
    });
}

function getAllWalkableTiles() {
    const tiles = mapTiles
        .filter(t => t.type !== '0')
        .map(t => ({ x: t.x, y: t.y, delivery: !!(t.delivery || t.type === '2') }));
    return JSON.stringify(tiles);
}

async function sendChatMessage(msg) {
    await socket.emitShout(msg);
    return `Sent chat message: "${msg}"`;
}

/**
 * Send a structured mission command to the BDI agent via game chat.
 * BDI agent listens for these and updates its missionState accordingly.
 * args: JSON string { type, params, description }
 */
async function sendMissionToBDI(args) {
    try {
        const parsed = typeof args === 'string' ? JSON.parse(args) : args;

        if (parsed.type === 'PREFERRED_DELIVERY') {
            const deliveryCoords = new Set(
                mapTiles
                    .filter(t => t.delivery === true || t.type === '2')
                    .map(t => `${t.x},${t.y}`)
            );
            const requested = parsed.params?.tiles ?? [];
            const unknown = requested.filter(t => !deliveryCoords.has(`${t.x},${t.y}`));
            if (unknown.length > 0) {
                console.warn('[LLM] PREFERRED_DELIVERY requested tile(s) not on the map\'s delivery tiles:', unknown);
            }
        }

        if (parsed.type === 'PICKUP_AND_DELIVER') {
            const { x, y } = parsed.params ?? {};
            const dropTile = mapTiles.find(t => t.x === x && t.y === y);
            if (dropTile && (dropTile.delivery === true || dropTile.type === '2')) {
                // putdown() on a delivery tile auto-delivers the parcel to the server —
                // there will be nothing left at (x,y) for the BDI to pick up, so its
                // PICKUP_AND_DELIVER mission would wait forever for a parcel that's gone.
                console.warn(`[LLM] PICKUP_AND_DELIVER drop point (${x},${y}) is a delivery tile — the parcel was likely auto-delivered on putdown, not handed off.`);
            }

            // The LLM sometimes omits parcelId. Without it, the BDI's CLAIM carries
            // id=undefined (claims nothing) and our local handoff-claim below can't
            // activate either, so this agent's own loop re-picks-up and delivers the
            // parcel itself. Infer it from whatever was just dropped at (x,y).
            if (!parsed.params?.parcelId) {
                const atDrop = [...beliefs.parcels.values()].find(p => p.x === x && p.y === y && !p.carriedBy);
                if (atDrop) {
                    parsed.params = { ...parsed.params, parcelId: atDrop.id };
                    console.log(`[LLM] PICKUP_AND_DELIVER missing parcelId — inferred ${atDrop.id} from parcel at (${x},${y})`);
                } else {
                    // Sensing hasn't caught up to the parcel we just dropped yet.
                    // Resolve it on a later sensing tick (see handoffDropPos check
                    // in onSensing) instead of leaving the parcel unclaimed.
                    handoffDropPos = { x, y };
                    console.warn(`[LLM] PICKUP_AND_DELIVER missing parcelId and no parcel found at (${x},${y}) yet — will resolve from sensing.`);
                }
            }

            handoffParcelId = parsed.params?.parcelId ?? null;
            if (handoffParcelId) {
                handoffDropPos = null;
                beliefs.claimedByOther.set('handoff', handoffParcelId);
            }
        }

        const cmd = JSON.stringify({
            cmd: 'MISSION',
            type: parsed.type,
            params: parsed.params ?? {},
            description: parsed.description ?? '',
        });
        if (bdiAgentId) await socket.emitSay(bdiAgentId, cmd);
        else await socket.emitShout(cmd); // fallback if BDI not yet seen
        // Apply the same mission state locally so this agent's sensing loop also respects it.
        // PICKUP_AND_DELIVER is asymmetric — it tells the BDI to pick up the parcel we just
        // dropped off, so we must NOT also adopt it ourselves (we'd race the BDI for it).
        if (parsed.type !== 'PICKUP_AND_DELIVER') {
            setMissionState({
                active: true,
                type: parsed.type,
                params: parsed.params ?? {},
                description: parsed.description ?? '',
            });
        }
        console.log('[LLM] Mission command sent to BDI:', cmd);
        return `Mission sent to BDI agent: ${parsed.description}`;
    } catch (e) {
        return `Error sending mission to BDI: ${e.message}`;
    }
}

async function getBdiPosition() {
    if (!lastBdiPosition) return 'Error: BDI position not yet received.';
    return JSON.stringify(lastBdiPosition);
}

// Unfreeze our own WAIT_FOR_SIGNAL mission state, mirroring the BDI's green-light
// handling — otherwise reviseIntention() keeps freezing us in WAIT after the signal.
function unfreezeOnGreen(keyword) {
    if (keyword.trim().toLowerCase() === 'green' && missionState.type === 'WAIT_FOR_SIGNAL') {
        setMissionState({ ...missionState, params: { ...missionState.params, frozen: false } });
        console.log('[LLM] Green light received — unfreezing own mission state');
    }
}

async function waitForChatSignal(keyword) {
    const kw = keyword.trim().toLowerCase();

    // Signal may have arrived before this call — check the queue first
    const queueIdx = missionQueue.findIndex(m => m.msg.toLowerCase().includes(kw));
    if (queueIdx !== -1) {
        const { msg } = missionQueue.splice(queueIdx, 1)[0];
        console.log(`[LLM] Signal "${keyword}" found in mission queue — resolving immediately`);
        unfreezeOnGreen(keyword);
        return `Signal received: "${msg}"`;
    }

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            const idx = pendingSignalResolvers.findIndex(r => r.keyword === kw);
            if (idx !== -1) pendingSignalResolvers.splice(idx, 1);
            resolve(`Timeout: no "${keyword}" signal received within 2 minutes.`);
        }, 120_000);
        const entry = {
            keyword: kw,
            resolve: (msg) => { clearTimeout(timer); resolve(`Signal received: "${msg}"`); },
        };
        pendingSignalResolvers.push(entry);
        console.log(`[LLM] Waiting for chat signal: "${keyword}"`);

        // Start the auto-green timer now that the resolver is registered
        if (kw === 'green' && pendingAutoGreenMs !== null) {
            const ms = pendingAutoGreenMs;
            pendingAutoGreenMs = null;
            setTimeout(() => {
                const idx = pendingSignalResolvers.indexOf(entry);
                if (idx !== -1) {
                    entry.resolve(`auto-green after ${ms / 1000}s`);
                    pendingSignalResolvers.splice(idx, 1);
                }
            }, ms);
            console.log(`[LLM] Auto-green timer started: ${ms}ms`);
        }
    });
}

async function clearMissionOnBDI() {
    const cmd = JSON.stringify({ cmd: 'MISSION_CLEAR' });
    if (bdiAgentId) await socket.emitSay(bdiAgentId, cmd);
    else await socket.emitShout(cmd);
    setMissionState({ active: false, type: null, params: {}, description: '' });
    console.log('[LLM] Mission clear sent to BDI');
    return 'Mission cleared on BDI agent.';
}

async function solvePDDL(inputStr) {
    let parsed;
    try { parsed = JSON.parse(inputStr); } catch { return 'Error: input must be valid JSON.'; }

    const { type, params = {} } = parsed;

    // ── PARCEL_HANDOFF: two-agent joint drop-point optimisation ─────────────
    // Uses a separate domain (domain_handoff.pddl) and returns a drop point,
    // not a step list — handled before the shared single-agent flow below.
    if (type === 'PARCEL_HANDOFF') {
        const { parcelId } = params;
        if (!parcelId) return 'Error: PARCEL_HANDOFF requires parcelId.';
        if (!beliefs.carrying.includes(parcelId)) {
            return `Error: not currently carrying parcel ${parcelId} — call pickup() first.`;
        }
        if (!lastBdiPosition) {
            return 'Error: BDI position not yet known — call get_bdi_position() and retry. If it stays unknown, fall back: check get_delivery_tiles() and, if your current tile is NOT a delivery tile, putdown() here.';
        }
        try {
            const built = buildHandoffDropProblem(parcelId, lastBdiPosition);
            if (!built) return 'Error: could not build handoff problem (no non-delivery tiles near you or no delivery tiles available).';

            console.log('[PDDL-HANDOFF] submitting to solver…');
            const result = await solve(DOMAIN_HANDOFF_PDDL, built.problem);
            if (!result) return 'Error: PDDL solver timed out or returned null.';
            if (!result.plan?.length) return 'No plan found for handoff (problem may be unsolvable given current world state).';

            const drop = extractHandoffDrop(result.plan, built);
            if (!drop) return 'Error: solver plan did not include a handoff-drop action.';
            console.log(`[PDDL-HANDOFF] resolved drop point (${drop.x},${drop.y})`);
            return JSON.stringify({ dropX: drop.x, dropY: drop.y });
        } catch (err) {
            console.warn('[PDDL-HANDOFF] error:', err.message);
            return `Error: ${err.message}`;
        }
    }

    try {
        let built = null;
        let translator;

        if (type === 'PICKUP_AND_DELIVER') {
            const { parcelId, x, y } = params;
            if (!parcelId || x == null || y == null)
                return 'Error: PICKUP_AND_DELIVER requires parcelId, x, y.';
            console.log(`[PDDL] LLM calling solver for PICKUP_AND_DELIVER — parcel=${parcelId} drop=(${x},${y})`);
            built = buildPickupAndDeliverProblem(parcelId, x, y);
            translator = (actions, maps) => translatePlan(actions, maps);
        } else if (type === 'COORDINATE_MEETUP') {
            const { x, y, radius = 3 } = params;
            if (x == null || y == null) return 'Error: COORDINATE_MEETUP requires x, y.';
            console.log(`[PDDL] LLM calling solver for COORDINATE_MEETUP — target=(${x},${y}) radius=${radius}`);
            built = buildMeetupProblem(x, y, radius);
            if (built?.meetupTile) {
                const tile = built.meetupTile;
                translator = (actions, maps) => translateMeetupPlan(actions, maps, tile);
            } else {
                translator = (actions, maps) => translatePlan(actions, maps);
            }
        } else {
            return `Error: unsupported type "${type}". Use PICKUP_AND_DELIVER, COORDINATE_MEETUP, or PARCEL_HANDOFF.`;
        }

        if (!built) return 'Error: could not build PDDL problem (no delivery tiles or unreachable meetup tile?).';

        console.log('[PDDL] submitting to solver…');
        const result = await solve(DOMAIN_PDDL, built.problem);
        if (!result) return 'Error: PDDL solver timed out or returned null.';
        if (!result.plan?.length) return 'No plan found (problem may be unsolvable given current world state).';

        const intentions = translator(result.plan, built);
        console.log(`[PDDL] plan translated to ${intentions.length} step(s)`);
        return JSON.stringify({
            steps: intentions.map(i => ({
                action: i.type,
                target: i.target,
            })),
        });
    } catch (err) {
        console.warn('[PDDL] solvePDDL error:', err.message);
        return `Error: ${err.message}`;
    }
}


const TOOLS = {
    calculate,
    manhattan_distance: manhattanDistance,
    get_my_position: getMyPosition,
    get_carried_parcels: getCarriedParcels,
    move_to: moveTo,
    explore,
    pickup,
    putdown,
    get_visible_parcels: getVisibleParcels,
    get_delivery_tiles: getDeliveryTiles,
    get_map_info: getMapInfo,
    get_all_walkable_tiles: getAllWalkableTiles,
    send_chat_message: sendChatMessage,
    send_mission_to_bdi: sendMissionToBDI,
    clear_mission_on_bdi: clearMissionOnBDI,
    get_bdi_position: getBdiPosition,
    wait_for_chat_signal: waitForChatSignal,
    solve_pddl: solvePDDL,
};

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are an AI agent in a Deliveroo-like game. You receive special missions via chat and must execute them.
You are one of two agents: you (LLM agent) and a BDI agent running separately.
You can send mission commands to the BDI agent via send_mission_to_bdi to coordinate behaviour.

Available tools:
- calculate(expression): evaluate basic arithmetic expressions (+ - * / only — NO function calls like abs() or manhattan_distance(), these are NOT valid inside calculate)
- manhattan_distance(x1=A,y1=B,x2=C,y2=D): compute the Manhattan distance |x1-x2| + |y1-y2| between two points. This is its own Action — call it directly as "Action: manhattan_distance", never inside calculate.
- get_my_position(): get your current (x, y) and score
- get_carried_parcels(): list parcels you are CURRENTLY CARRYING, e.g. [{"id":"p123","reward":45}]. Empty array if carrying nothing. ALWAYS check this first for PARCEL_HANDOFF — if non-empty, you already have a parcel to hand off and must NOT pick up or look for another one.
- move_to(x=N,y=M): navigate to a target tile using the BDI A* planner. Input example: x=14, y=12
- explore(): use the BDI explorer + A* planner to move toward an unexplored frontier
- pickup(): pick up parcels at your current position
- putdown(): put down all carried parcels at your current position
- get_visible_parcels(): list parcels visible right now (claimedByPartner=true means the BDI agent is already going for it — avoid those)
- get_delivery_tiles(): list all delivery tiles on the map
- get_map_info(): map overview
- get_all_walkable_tiles(): list all walkable tiles with x, y, and whether they are delivery tiles. Use this to find tiles by spatial description (e.g. leftmost = min x, rightmost = max x, topmost = max y, bottommost = min y)
- send_chat_message(text): send a plain text message to the game chat
- send_mission_to_bdi(json): send a mission command to the BDI agent.
  The JSON must be: { "type": "<TYPE>", "params": {...}, "description": "..." }
  Navigation type — "MOVE_TO_POSITION" (send this to BDI when you want the BDI agent to navigate somewhere):
    { "type": "MOVE_TO_POSITION", "params": { "x": 4, "y": 7, "reward": 10 }, "description": "BDI moves to (4,7) for +10pts using A* pathfinding" }
  Level 2 types — "STACK_SIZE"|"AVOID_STACK_SIZE"|"PREFERRED_DELIVERY"|"AVOID_TILE"|"SCORE_FILTER":
    { "type": "STACK_SIZE", "params": { "size": 3 }, "description": "Deliver exactly 3 parcels at a time" }
    { "type": "AVOID_STACK_SIZE", "params": { "size": 2 }, "description": "Never deliver when carrying exactly 2 parcels — keep picking up until count differs" }
    { "type": "PREFERRED_DELIVERY", "params": { "tiles": [{"x":4,"y":7}] }, "description": "Prefer delivery at (4,7)" }
    { "type": "AVOID_TILE", "params": { "x": 5, "y": 3 }, "description": "Avoid tile (5,3)" }
    { "type": "SCORE_FILTER", "params": { "maxReward": 10 }, "description": "Only deliver parcels reward <= 10" }
  Level 3 types — "COORDINATE_MEETUP"|"WAIT_FOR_SIGNAL"|"PICKUP_AND_DELIVER":
    { "type": "COORDINATE_MEETUP", "params": { "x": N, "y": M, "radius": 3 }, "description": "Both agents move to within 3 tiles of (N,M) and wait for each other" }
    { "type": "WAIT_FOR_SIGNAL", "params": {}, "description": "BDI freezes in place and waits for green-light signal" }
    { "type": "WAIT_FOR_SIGNAL", "params": { "target": { "x": N, "y": M } }, "description": "BDI navigates to (N,M) then freezes and waits for green-light signal" }
    { "type": "PICKUP_AND_DELIVER", "params": { "parcelId": "<id>", "x": N, "y": M }, "description": "BDI picks up parcel <id> from (N,M) and delivers it" }
- clear_mission_on_bdi(): cancel any active mission on the BDI agent
- get_bdi_position(): get BDI agent's last known (x,y) position — use to check if BDI arrived at meetup point
- wait_for_chat_signal(keyword): block until that keyword appears in game chat (e.g. "green"); times out after 2 minutes
- solve_pddl(json): call the external PDDL planner.
  Input: { "type": "PICKUP_AND_DELIVER"|"COORDINATE_MEETUP"|"PARCEL_HANDOFF", "params": {...} }
  - "PICKUP_AND_DELIVER" / "COORDINATE_MEETUP": params same as send_mission_to_bdi. Returns { "steps": [{ "action": "pickup"|"deliver"|"meetup", "target": {...} }, ...] } — an optimized action sequence. Use this BEFORE sending instructions to the BDI to find the optimal path/order (e.g. which delivery tile to use, whether to pick up parcels en route to a meetup). Then use the returned steps to inform your send_mission_to_bdi calls.
  - "PARCEL_HANDOFF": params = { "parcelId": "<id>" }. Requires you to be CARRYING the parcel already (call pickup() first). Jointly optimizes where you should drop the parcel by considering BOTH your current position AND the BDI's last known position (get_bdi_position()), minimizing your walk to the drop point plus the BDI's walk to retrieve and deliver it. Returns { "dropX": N, "dropY": M } — always a non-delivery tile. Use this BEFORE putdown() in the PARCEL_HANDOFF recipe below.

Movement rules:
- Use move_to for navigating to specific coordinates.
- Use explore when you want the agent to keep expanding into unexplored map tiles.

Mission decision rules:
- STOP/FREEZE EXCEPTION — check this FIRST: If the mission is a command to stop both agents (e.g. "stop", "all agents stop", "halt", "freeze", "stop and wait for green light", "wait for green light", "red light"):
  * If the mission states a NEGATIVE point value, decline immediately: "Mission declined: not profitable." Do NOT execute WAIT_FOR_SIGNAL.
  * Otherwise (no point value stated, or a positive point value), accept and treat as WAIT_FOR_SIGNAL — the absence of an explicit objective does NOT disqualify stop/freeze commands. Skip directly to the WAIT_FOR_SIGNAL steps below.
- BEFORE doing anything else — before classifying the mission as Level 1/2/3, before calling move_to/explore/any tool — check whether the mission is profitable. This gate applies to EVERY mission except stop/freeze commands (covered above), including ones phrased as plain navigation commands like "Go to...", "Move to...", "Head to...", "Navigate to...", "Explore...".
  * Extract any point value mentioned in the mission. Point values can be written in many formats:
    "-5pts", "-5 pts", "-5 pts.", "-5 points", "minus 5 points", "lose 5pts", "costs 5pts", etc.
  * If the point value is NEGATIVE (less than zero), ALWAYS decline regardless of formatting.
    Reply with "Mission declined: not profitable." and give Final Answer immediately. Do NOT call any tools.
  * If the point value is POSITIVE or the mission gives a reward multiplier GREATER THAN 1 (e.g. "double the reward", "2x reward", "triple points", "200% of the standard reward"), accept and execute it.
  * If the mission gives a reward multiplier or fraction LESS THAN 1 (e.g. "0.3 of the standard reward", "half the reward", "50% of normal"), this means executing it earns LESS than normal — it is non-profitable. Do NOT apply the requested constraint. Instead, actively counteract it: if the mission specifies a stack size N with a sub-1 multiplier, call send_mission_to_bdi with type "AVOID_STACK_SIZE" and the same size N so both agents avoid delivering exactly N parcels at a time. Then give Final Answer: "Avoided non-profitable constraint: <brief reason>."
  * If the mission mentions NO points, reward, multiplier, or other concrete benefit — even if it sounds like a normal, executable instruction (e.g. "Go to somewhere around the middle of the map.", "Move to the rightmost walkable tile.", "Explore the north area.") — it has no objective and must be declined. A mission being phrased as an actionable command does NOT make it profitable. Reply with "Mission declined: no objective or profit specified." and give Final Answer immediately. Do NOT call any tools.
  * If the mission's instructions are logically contradictory or impossible to satisfy as written (e.g. "Pick up all parcels but also avoid moving.", "Deliver parcels without picking any up.") — even if it states a point value — do NOT attempt a partial or "most direct interpretation" of it. Reply with "Mission declined: contradictory instructions." and give Final Answer immediately. Do NOT call any tools.
- For Level 1 atomic missions (calculate, answer a question, drop a parcel, timed stop): execute them directly with tools above.
  * After calculate returns a result, your very next output MUST be Final Answer: <result>. Do not add more reasoning or tool calls.
  * "Stop for N seconds": call wait_for_chat_signal("green") — the green signal fires automatically after N seconds.
- For Level 2 persistent missions (e.g. "deliver stacks of 3 to double reward"): call send_mission_to_bdi() to instruct the BDI agent, then give Final Answer immediately.
- For Level 3 coordination missions:
  * COORDINATE_MEETUP:
    (1) MANDATORY — call solve_pddl({"type":"COORDINATE_MEETUP","params":{"x":N,"y":M,"radius":3}}). The returned steps are YOUR optimal path to the meetup (not the BDI's) and may include en-route parcel pickups that earn points on the way — do NOT discard them.
    (2) call send_mission_to_bdi with type COORDINATE_MEETUP so the BDI starts moving there in parallel.
    (3) Execute the PDDL steps yourself in order without skipping or questioning them:
        - "pickup" step → move_to the parcel's (x,y), then pickup().
        - "deliver" step → move_to the delivery tile's (x,y), then putdown(). A deliver step with no preceding pickup step is normal — it means you are already carrying parcels; just go deliver them.
        - "meetup" step → move_to the step's target (x,y). This tile may differ from the original mission coordinates because the PDDL resolves the nearest walkable tile within the radius — use the PDDL target as-is, do NOT substitute the original (N,M).
        Never override or ignore a PDDL step because it looks unexpected.
    (4) poll get_bdi_position() and get_my_position(), use manhattan_distance to confirm BOTH agents are within radius 3 of (N,M).
    (5) call clear_mission_on_bdi() then give Final Answer. The BDI freezes once it enters the radius and will NOT resume until clear_mission_on_bdi() is called — do not delay this step.
  * WAIT_FOR_SIGNAL (stop and wait for green-light signal):
    (1) MANDATORY FIRST — call send_mission_to_bdi to freeze the BDI immediately:
        - If the mission requires the BDI to stop at a specific position (e.g. "delivery tile", "tile (3,4)", "odd row"): compute the BDI's target first (use get_bdi_position(), get_delivery_tiles(), get_all_walkable_tiles() as needed), then call send_mission_to_bdi({ type: "WAIT_FOR_SIGNAL", params: { target: { x: N, y: M } }, description: "..." }). The BDI will navigate to that position and freeze there atomically.
        - Otherwise (no specific position): call send_mission_to_bdi({ type: "WAIT_FOR_SIGNAL", params: {}, description: "..." }). The BDI freezes wherever it currently is.
    (2) If the mission requires you to stop at a specific position, call move_to your own target. Otherwise stay put.
    (3) call wait_for_chat_signal("green") to freeze yourself until the signal arrives.
    (4) give Final Answer after the signal is received.
  * PARCEL_HANDOFF (you pick up, BDI delivers, +200pts handoff bonus):
    (0) call get_carried_parcels() FIRST.
            - If it returns one or more parcels: you already have a target — use the first parcel's "id" as <id> and skip directly to step (2). Do NOT call pickup(), do NOT call get_visible_parcels()/explore() to look for another parcel.
            - If it returns an empty array: find a target parcel — use get_visible_parcels()/explore() until you see a parcel with carriedBy=null. Unlike normal operation, claimedByPartner=true is FINE for this mission — the parcel ends up with the BDI either way, so do not avoid or wait on claimed parcels. Pick the closest carriedBy=null parcel, move_to its (x,y), then call pickup() on it. Then proceed to step (2) with the picked-up parcel's <id>.    (1) call pickup() on it.
    (2) MANDATORY — call solve_pddl({"type":"PARCEL_HANDOFF","params":{"parcelId":"<id>"}}) to compute the optimal drop point. This jointly considers your current position AND the BDI's last known position, minimizing your walk to the drop point plus the BDI's walk to retrieve and deliver it. Returns {"dropX":N,"dropY":M} — always a non-delivery tile, so you don't need to check get_delivery_tiles() yourself.
        - If it errors ONLY because the BDI's position is unknown: call get_bdi_position() once, then retry solve_pddl ONE time.
        - If solve_pddl still errors or returns "No plan found" after that single retry: STOP — do not call calculate, get_all_walkable_tiles, or compute a midpoint yourself. Set dropX,dropY to your CURRENT position (call get_my_position() if needed) and go straight to step 4. Your current tile cannot be a delivery tile (you are standing where you just picked the parcel up — putdown there would have auto-delivered it), so dropping here is always valid.
    (3) If (dropX,dropY) differs from your current position, call move_to(x=dropX, y=dropY). If it's the fallback (your current position), skip this step.
    (4) call putdown() to drop the parcel.
    (5) call get_my_position() to get the exact drop coordinates.
    (6) call send_mission_to_bdi({ type: "PICKUP_AND_DELIVER", params: { parcelId: "<id>", x: <drop_x>, y: <drop_y> } }) — BDI will navigate to the drop point, pick up the parcel, and deliver it autonomously.
    (7) give Final Answer immediately.
- After completing a mission, your Final Answer text is automatically broadcast to the game chat — do NOT call send_chat_message to report the result (that would double-send). Use send_chat_message only for mid-mission status messages.

STRICT OUTPUT FORMAT — use exactly one format per message:

FORMAT 1 — use a tool:
Thought: <reasoning>
Action: <tool name>
Action Input: <input>

FORMAT 2 — final answer:
Thought: I have completed the mission.
Final Answer: <summary of what was done>

Rules:
- One action per message. Never mix Action and Final Answer.
- Do not invent tool results. Wait for the Observation.
- Use move_to for multi-step navigation.
- After send_mission_to_bdi completes for a Level 2 mission, give Final Answer immediately. For Level 3 missions, continue with the remaining steps listed above before giving Final Answer.
`.trim();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── ReAct loop ───────────────────────────────────────────────────────────────

function extractAction(text) {
    const a = text.match(/^Action:\s*(.+)$/im);
    if (!a) return null;
    let action = a[1].trim();

    const i = text.match(/^Action Input:\s*([\s\S]*?)(?=\n(?:Thought|Action|Final Answer)|$)/im);
    let actionInput = i ? i[1].trim() : '';

    // Tolerate function-call syntax, e.g. "Action: get_carried_parcels()" or
    // "Action: move_to(x=13, y=1)" — strip the trailing (...) from the action
    // name. If no separate "Action Input:" line was given, use the
    // parenthesized content as the input.
    const callMatch = action.match(/^([A-Za-z0-9_]+)\s*\((.*)\)\s*$/s);
    if (callMatch) {
        action = callMatch[1];
        if (!actionInput && callMatch[2].trim()) actionInput = callMatch[2].trim();
    }

    return { action, actionInput };
}

function extractFinalAnswer(text) {
    const m = text.match(/^Final Answer:\s*([\s\S]*)$/im);
    return m ? m[1].trim() : null;
}

async function callLLM(messages, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await llm.chat.completions.create({ model: MODEL, messages, temperature: 0 });
            return res.choices?.[0]?.message?.content ?? '';
        } catch (err) {
            const isTimeout = err.constructor.name === 'APIConnectionTimeoutError'
                || err.constructor.name === 'APITimeoutError'
                || err.code === 'ETIMEDOUT';
            if (isTimeout && attempt < retries) {
                console.warn(`[LLM] Timeout on attempt ${attempt}/${retries}, retrying in ${attempt}s...`);
                await sleep(attempt * 1000);
                continue;
            }
            throw err;
        }
    }
}

async function runMissionTurn(userInput, maxIterations = 100) {
    const thread = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userInput },
    ];

    for (let i = 0; i < maxIterations; i++) {
        console.log(`[LLM] iteration ${i + 1}`);
        const output = await callLLM(thread);
        console.log(`[LLM] output:\n${output}\n`);
        thread.push({ role: 'assistant', content: output });

        const parsedAction = extractAction(output);
        if (parsedAction) {
            const { action, actionInput } = parsedAction;
            let observation;
            if (TOOLS[action]) {
                console.log(`[LLM] executing tool: ${action}("${actionInput}")`);
                observation = await TOOLS[action](actionInput);
                // Level 2 missions run forever on the BDI — stop LLM iterations immediately
                const LEVEL2_TYPES = ['AVOID_TILE', 'STACK_SIZE', 'AVOID_STACK_SIZE', 'PREFERRED_DELIVERY', 'SCORE_FILTER'];
                if (action === 'send_mission_to_bdi' && missionState.active && LEVEL2_TYPES.includes(missionState.type)) {
                    console.log(`[LLM] Level 2 mission "${missionState.type}" active — stopping iterations.`);
                    return observation;
                }
            } else {
                observation = `Error: unknown tool '${action}'. Available: ${Object.keys(TOOLS).join(', ')}`;
            }
            console.log(`[LLM] observation: ${observation}\n`);
            thread.push({
                role: 'user',
                content: `Observation: ${observation}\n\nContinue. If the mission is complete, give Final Answer. Otherwise choose the next Action.`,
            });
            continue;
        }

        const finalAnswer = extractFinalAnswer(output);
        if (finalAnswer) {
            console.log(`[LLM] Final Answer: ${finalAnswer}`);
            return finalAnswer;
        }

        thread.push({
            role: 'user',
            content: 'Observation: Error: invalid format. Output exactly one Action or one Final Answer.',
        });
    }

    return 'Could not complete the mission within the iteration limit.';
}

// ─── Chat listener ─────────────────────────────────────────────────────────────

let missionRunning = false;
let handoffMissionActive = false;
let bdiAgentId = null; // learned from first message received from BDI
const missionQueue = [];

async function processNextMission() {
    if (missionRunning || missionQueue.length === 0) return;
    const { name, msg } = missionQueue.shift();
    const timeMatch = msg.match(/(\d+(?:\.\d+)?)\s*second/i);
    if (timeMatch) {
        pendingAutoGreenMs = parseFloat(timeMatch[1]) * 1000;
        console.log(`[LLM] Auto-green will fire ${timeMatch[1]}s after wait begins`);
    }
    // Track handoff missions so putdown() can refuse to drop on a delivery tile —
    // dropping there auto-delivers the parcel instead of leaving it for the BDI.
    handoffMissionActive = /hand[\s-]?off|partner|teammate|other agent|bdi|hand (it|this|that|over)/i.test(msg);
    missionRunning = true;
    try {
        const result = await runMissionTurn(`Special mission from ${name}: ${msg}`);
        if (result) await socket.emitShout(result);
    } catch (err) {
        console.error('[LLM ERROR]', err);
    } finally {
        missionRunning = false;
        handoffMissionActive = false;
        // Don't let an unconsumed auto-green timer leak into the next,
        // unrelated mission's wait_for_chat_signal('green') call.
        pendingAutoGreenMs = null;
        processNextMission();
    }
}

socket.onMsg(async (id, name, msg) => {
    msg = String(msg ?? '');
    if (id === me.id) return;
    if (name === process.env.BDI_AGENT_NAME && !bdiAgentId) {
        bdiAgentId = id;
        console.log('[LLM] Learned BDI agent ID:', bdiAgentId);
    }
    try {
        const p = JSON.parse(msg);
        if (p.cmd === 'HELLO' && name === process.env.BDI_AGENT_NAME) {
            bdiAgentId = id;
            console.log('[LLM] Learned BDI agent ID from handshake:', bdiAgentId);
            return;
        }

        if (p.cmd === 'CLAIM' && name === process.env.BDI_AGENT_NAME) {
            const myIntent = getCurrentIntention();
            if (myIntent?.type === INTENTION.PICKUP && myIntent.target?.id === p.parcelId) {
                // Already targeting the same parcel ourselves — let the server
                // arbitrate who physically gets there first instead of always
                // backing off (which previously made the LLM agent lose every
                // contested parcel to the BDI).
                console.log('[LLM] Ignoring CLAIM for', p.parcelId, '— already targeting it');
                return;
            }
            beliefs.claimedByOther.set(id, p.parcelId);
            console.log('[LLM] Received CLAIM from BDI:', p.parcelId);
            return;
        }
        if (p.cmd === 'STATUS' && name === process.env.BDI_AGENT_NAME) {
            lastBdiPosition = { x: p.x, y: p.y };
            return;
        }
        if (p.cmd) return; // other inter-agent commands
    } catch {}

    // Resolve any pending wait_for_chat_signal calls
    let resolvedSignal = false;
    for (let i = pendingSignalResolvers.length - 1; i >= 0; i--) {
        if (msg.toLowerCase().includes(pendingSignalResolvers[i].keyword)) {
            unfreezeOnGreen(pendingSignalResolvers[i].keyword);
            pendingSignalResolvers[i].resolve(msg);
            pendingSignalResolvers.splice(i, 1);
            resolvedSignal = true;
        }
    }

    console.log(`\n[CHAT] ${name}: ${msg}`);

    // Don't queue signal messages as new missions — they've done their job
    if (resolvedSignal) return;

    // Green light may arrive even if wait_for_chat_signal was never called
    // (e.g. the mission turn ended before reaching that step). Unfreeze and
    // don't treat it as a new mission.
    if (missionState.active && missionState.type === 'WAIT_FOR_SIGNAL' && msg.toLowerCase().includes('green')) {
        unfreezeOnGreen('green');
        return;
    }

    const adminName = process.env.ADMIN_NAME;
    if (adminName && name !== adminName) {
        console.log(`[LLM] Ignoring mission from non-admin "${name}".`);
        return;
    }

    missionQueue.push({ name, msg });
    console.log(`[LLM] Mission queued (queue length: ${missionQueue.length})`);
    processNextMission();
});


console.log('[LLM AGENT] Started. Listening for special missions via chat.');