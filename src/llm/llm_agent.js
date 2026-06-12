import 'dotenv/config';
import OpenAI from 'openai';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import { beliefs, updateFromSensing, setMap } from '../bdi/beliefs.js';
import { reviseIntention, getCurrentIntention, INTENTION, setMissionState, missionState } from '../bdi/intentions.js';
import { executePlan } from '../bdi/executor.js';
import { explorePath } from '../bdi/explorer.js';

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
});

let loopRunning = false;
let lastClaimedId = null;
let lastBdiPosition = null;
const pendingSignalResolvers = [];
let pendingAutoGreenMs = null; // set when mission text contains a duration

socket.onSensing(async ({ parcels, agents }) => {
    visibleParcels = parcels ?? [];
    updateFromSensing({ parcels, agents });

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

function calculate(expression) {
    try { return String(eval(expression)); }
    catch (e) { return `Error: ${e.message}`; }
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

async function followPath(path, label) {
    if (!Array.isArray(path) || path.length === 0) {
        return `Error: no ${label} path found.`;
    }

    let steps = 0;
    for (const direction of path) {
        const ok = await applyMove(direction);
        if (!ok) {
            return `Error: blocked while following ${label} path after ${steps} step(s).`;
        }
        steps++;
    }

    return `Completed ${label} path in ${steps} step(s). Current position: (${Math.round(me.x)}, ${Math.round(me.y)}).`;
}

async function getMyPosition() {
    if (me.x === null) return 'Error: position not available yet.';
    return JSON.stringify({ x: me.x, y: me.y, score: me.score, name: me.name });
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

async function explore() {
    const current = snapPosition();
    if (!current) return 'Error: position not available yet.';
    const path = explorePath(current);
    return followPath(path, 'exploration');
}

async function pickup() {
    const result = await socket.emitPickup();
    if (result && result.length > 0)
        return `Picked up ${result.length} parcel(s): ${result.map(p => p.id).join(', ')}.`;
    return 'No parcels to pick up here.';
}

async function putdown() {
    const result = await socket.emitPutdown();
    return result ? 'Put down all carried parcels.' : 'Error: putdown failed.';
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
        const cmd = JSON.stringify({
            cmd: 'MISSION',
            type: parsed.type,
            params: parsed.params ?? {},
            description: parsed.description ?? '',
        });
        if (bdiAgentId) await socket.emitSay(bdiAgentId, cmd);
        else await socket.emitShout(cmd); // fallback if BDI not yet seen
        // Apply the same mission state locally so this agent's sensing loop also respects it
        setMissionState({
            active: true,
            type: parsed.type,
            params: parsed.params ?? {},
            description: parsed.description ?? '',
        });
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

async function waitForChatSignal(keyword) {
    const kw = keyword.trim().toLowerCase();

    // Signal may have arrived before this call — check the queue first
    const queueIdx = missionQueue.findIndex(m => m.msg.toLowerCase().includes(kw));
    if (queueIdx !== -1) {
        const { msg } = missionQueue.splice(queueIdx, 1)[0];
        console.log(`[LLM] Signal "${keyword}" found in mission queue — resolving immediately`);
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

const TOOLS = {
    calculate,
    get_my_position: getMyPosition,
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
};

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are an AI agent in a Deliveroo-like game. You receive special missions via chat and must execute them.
You are one of two agents: you (LLM agent) and a BDI agent running separately.
You can send mission commands to the BDI agent via send_mission_to_bdi to coordinate behaviour.

Available tools:
- calculate(expression): evaluate math expressions
- get_my_position(): get your current (x, y) and score
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
  Level 2 types — "STACK_SIZE"|"PREFERRED_DELIVERY"|"AVOID_TILE"|"SCORE_FILTER":
    { "type": "STACK_SIZE", "params": { "size": 3 }, "description": "Deliver exactly 3 parcels at a time" }
    { "type": "PREFERRED_DELIVERY", "params": { "tiles": [{"x":4,"y":7}] }, "description": "Prefer delivery at (4,7)" }
    { "type": "AVOID_TILE", "params": { "x": 5, "y": 3 }, "description": "Avoid tile (5,3)" }
    { "type": "SCORE_FILTER", "params": { "maxReward": 10 }, "description": "Only deliver parcels reward <= 10" }
  Level 3 types — "COORDINATE_MEETUP"|"WAIT_FOR_SIGNAL"|"PICKUP_AND_DELIVER":
    { "type": "COORDINATE_MEETUP", "params": { "x": N, "y": M, "radius": 3 }, "description": "Both agents move to within 3 tiles of (N,M) and wait for each other" }
    { "type": "WAIT_FOR_SIGNAL", "params": {}, "description": "BDI moves to an odd row and freezes until green-light chat message" }
    { "type": "PICKUP_AND_DELIVER", "params": { "parcelId": "<id>", "x": N, "y": M }, "description": "BDI picks up parcel <id> from (N,M) and delivers it" }
- clear_mission_on_bdi(): cancel any active mission on the BDI agent
- get_bdi_position(): get BDI agent's last known (x,y) position — use to check if BDI arrived at meetup point
- wait_for_chat_signal(keyword): block until that keyword appears in game chat (e.g. "green"); times out after 2 minutes

Movement rules:
- Use move_to for navigating to specific coordinates.
- Use explore when you want the agent to keep expanding into unexplored map tiles.

Mission decision rules:
- Before accepting a mission, evaluate whether it is profitable.
  * Extract any point value mentioned in the mission. Point values can be written in many formats:
    "-5pts", "-5 pts", "-5 pts.", "-5 points", "minus 5 points", "lose 5pts", "costs 5pts", etc.
  * If the point value is NEGATIVE (less than zero), ALWAYS decline regardless of formatting.
    Reply with "Mission declined: not profitable." and give Final Answer immediately. Do NOT call any tools.
  * If the point value is POSITIVE or the mission gives a reward multiplier, accept and execute it.
  * If no point value is mentioned, use your judgment based on the mission description.
- For Level 1 atomic missions (calculate, answer a question, drop a parcel, timed stop): execute them directly with tools above.
  * After calculate returns a result, your very next output MUST be Final Answer: <result>. Do not add more reasoning or tool calls.
  * "Stop for N seconds": call wait_for_chat_signal("green") — the green signal fires automatically after N seconds.
- For Level 2 persistent missions (e.g. "deliver stacks of 3 to double reward"): call send_mission_to_bdi() to instruct the BDI agent, then give Final Answer immediately.
- For Level 3 coordination missions:
  * COORDINATE_MEETUP: (1) call send_mission_to_bdi with type COORDINATE_MEETUP so the BDI starts moving there; (2) call move_to to navigate yourself to the same (x,y); (3) poll get_bdi_position() and get_my_position(), calculate manhattan distance (|ax-x|+|ay-y|) for each agent, and confirm BOTH are within radius 3 of the target; (4) only then give Final Answer.
  * WAIT_FOR_SIGNAL (red-light/green-light): BOTH agents must be on an odd-numbered row (y % 2 !== 0) and frozen before the green light. Steps: (1) call send_mission_to_bdi with type WAIT_FOR_SIGNAL so BDI starts moving to an odd row; (2) call get_my_position() to check your own y — if y is even, call move_to(x=<your_x>, y=<your_y+1>) to step onto the next odd row; (3) call wait_for_chat_signal("green") to freeze yourself until the signal arrives; (4) give Final Answer after the signal is received.
  * PARCEL_HANDOFF (you pick up, BDI delivers): (1) call pickup() on the target parcel; (2) call move_to to navigate to a convenient intermediate position; (3) call putdown() to drop the parcel; (4) call get_my_position() to get the exact drop coordinates; (5) call send_mission_to_bdi({ type: "PICKUP_AND_DELIVER", params: { parcelId: "<id>", x: <drop_x>, y: <drop_y> } }) — BDI will navigate to the drop point, pick up the parcel, and deliver it autonomously; (6) give Final Answer immediately.
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
    const i = text.match(/^Action Input:\s*([\s\S]+?)(?=\n(?:Thought|Action|Final Answer)|$)/im);
    return (a && i) ? { action: a[1].trim(), actionInput: i[1].trim() } : null;
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
                const LEVEL2_TYPES = ['AVOID_TILE', 'STACK_SIZE', 'PREFERRED_DELIVERY', 'SCORE_FILTER'];
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
    missionRunning = true;
    try {
        const result = await runMissionTurn(`Special mission from ${name}: ${msg}`);
        if (result) await socket.emitShout(result);
    } catch (err) {
        console.error('[LLM ERROR]', err);
    } finally {
        missionRunning = false;
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
            pendingSignalResolvers[i].resolve(msg);
            pendingSignalResolvers.splice(i, 1);
            resolvedSignal = true;
        }
    }

    console.log(`\n[CHAT] ${name}: ${msg}`);

    // Don't queue signal messages as new missions — they've done their job
    if (resolvedSignal) return;

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