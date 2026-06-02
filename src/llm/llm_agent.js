import 'dotenv/config';
import OpenAI from 'openai';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import { beliefs, updateFromSensing, setMap } from '../bdi/beliefs.js';
import { reviseIntention, getCurrentIntention, INTENTION } from '../bdi/intentions.js';
import { executePlan } from '../bdi/executor.js';

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

socket.onConnect(() => console.log('[LLM] Connected to Deliveroo'));

// ─── Local state ──────────────────────────────────────────────────────────────

const me = { id: null, name: null, x: null, y: null, score: 0 };
let mapTiles = [];
let visibleParcels = [];

socket.onYou(({ id, name, x, y, score }) => {
    Object.assign(me, { id, name, x, y, score });
    beliefs.me = me; // share reference so BDI modules always see current position
});

socket.on('map', (width, height, tiles) => {
    mapTiles = tiles;
    setMap(tiles);
});

let loopRunning = false;
let lastClaimedId = null;

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
            socket.emitShout(JSON.stringify({ cmd: 'CLAIM', parcelId: intent.target.id }));
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

async function getMyPosition() {
    if (me.x === null) return 'Error: position not available yet.';
    return JSON.stringify({ x: me.x, y: me.y, score: me.score, name: me.name });
}

async function move(direction) {
    const d = direction.trim().toLowerCase();
    if (!['up', 'down', 'left', 'right'].includes(d))
        return `Error: invalid direction '${direction}'.`;
    const result = await socket.emitMove(d);
    if (result) {
        me.x = result.x; me.y = result.y;
        return `Moved ${d}. New position: (${me.x}, ${me.y}).`;
    }
    return `Error: failed to move ${d}.`;
}

async function moveTo(args) {
    const match = args.match(/x\s*=?\s*(-?\d+)[,\s]+y\s*=?\s*(-?\d+)/i)
        || args.match(/(-?\d+)[,\s]+(-?\d+)/);
    if (!match) return `Error: could not parse target coordinates from '${args}'.`;
    const tx = parseInt(match[1]), ty = parseInt(match[2]);
    let steps = 0, maxSteps = 200;
    while ((Math.round(me.x) !== tx || Math.round(me.y) !== ty) && steps < maxSteps) {
        const dx = tx - Math.round(me.x);
        const dy = ty - Math.round(me.y);
        const dir = Math.abs(dx) >= Math.abs(dy)
            ? (dx > 0 ? 'right' : 'left')
            : (dy > 0 ? 'up' : 'down');
        const result = await socket.emitMove(dir);
        if (!result) break;
        me.x = result.x; me.y = result.y;
        steps++;
    }
    if (Math.round(me.x) === tx && Math.round(me.y) === ty)
        return `Reached (${tx}, ${ty}) in ${steps} steps.`;
    return `Stopped at (${Math.round(me.x)}, ${Math.round(me.y)}) after ${steps} steps. Target was (${tx}, ${ty}).`;
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
    return JSON.stringify(visibleParcels.map(p => ({
        id: p.id, x: p.x, y: p.y, reward: p.reward, carriedBy: p.carriedBy ?? null
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
    await socket.emitSay(msg);
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
        await socket.emitShout(cmd);
        console.log('[LLM] Mission command sent to BDI:', cmd);
        return `Mission sent to BDI agent: ${parsed.description}`;
    } catch (e) {
        return `Error sending mission to BDI: ${e.message}`;
    }
}

async function clearMissionOnBDI() {
    const cmd = JSON.stringify({ cmd: 'MISSION_CLEAR' });
    await socket.emitSay(cmd);
    console.log('[LLM] Mission clear sent to BDI');
    return 'Mission cleared on BDI agent.';
}

const TOOLS = {
    calculate,
    get_my_position: getMyPosition,
    move,
    move_to: moveTo,
    pickup,
    putdown,
    get_visible_parcels: getVisibleParcels,
    get_delivery_tiles: getDeliveryTiles,
    get_map_info: getMapInfo,
    get_all_walkable_tiles: getAllWalkableTiles,
    send_chat_message: sendChatMessage,
    send_mission_to_bdi: sendMissionToBDI,
    clear_mission_on_bdi: clearMissionOnBDI,
};

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are an AI agent in a Deliveroo-like game. You receive special missions via chat and must execute them.
You are one of two agents: you (LLM agent) and a BDI agent running separately.
You can send mission commands to the BDI agent via send_mission_to_bdi to coordinate behaviour.

Available tools:
- calculate(expression): evaluate math expressions
- get_my_position(): get your current (x, y) and score
- move(direction): move one step — up, down, left, right
- move_to(x=N,y=M): navigate to a target tile automatically (multi-step) Input example: x=14, y=12
- pickup(): pick up parcels at your current position
- putdown(): put down all carried parcels at your current position
- get_visible_parcels(): list parcels visible right now
- get_delivery_tiles(): list all delivery tiles on the map
- get_map_info(): map overview
- get_all_walkable_tiles(): list all walkable tiles with x, y, and whether they are delivery tiles. Use this to find tiles by spatial description (e.g. leftmost = min x, rightmost = max x, topmost = max y, bottommost = min y)
- send_chat_message(text): send a plain text message to the game chat
- send_mission_to_bdi(json): send a Level 2 mission command to the BDI agent.
  The JSON must be: { "type": "STACK_SIZE"|"PREFERRED_DELIVERY"|"AVOID_TILE"|"SCORE_FILTER", "params": {...}, "description": "..." }
  Examples:
    { "type": "STACK_SIZE", "params": { "size": 3 }, "description": "Deliver exactly 3 parcels at a time" }
    { "type": "PREFERRED_DELIVERY", "params": { "tiles": [{"x":4,"y":7}] }, "description": "Prefer delivery at (4,7)" }
    { "type": "AVOID_TILE", "params": { "x": 5, "y": 3 }, "description": "Avoid tile (5,3)" }
    { "type": "SCORE_FILTER", "params": { "maxReward": 10 }, "description": "Only deliver parcels reward <= 10" }
- clear_mission_on_bdi(): cancel any active mission on the BDI agent

Movement rules:
- move(up) increases y by 1, move(down) decreases y by 1
- move(right) increases x by 1, move(left) decreases x by 1
- Use move_to for navigating to specific coordinates.

Mission decision rules:
- Before accepting a mission, evaluate whether it is profitable.
  * If the mission gives NEGATIVE points or is clearly a trap, reply "Mission declined: not profitable." and stop.
  * If the mission gives positive points or a reward multiplier, accept it.
- For Level 1 atomic missions (move, calculate, answer a question, drop a parcel): execute them directly with tools above.
- For Level 2 persistent missions (e.g. "deliver stacks of 3 to double reward"): call send_mission_to_bdi() to instruct the BDI agent, then give Final Answer immediately.
- After completing a mission, call send_chat_message to report the result.

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
- After send_mission_to_bdi completes, give Final Answer immediately.
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

socket.onMsg(async (id, name, msg) => {
    if (id === me.id) return;
    try {
        const p = JSON.parse(msg);
        if (p.cmd === 'CLAIM' && name === process.env.BDI_AGENT_NAME) {
            beliefs.claimedByOther.set(id, p.parcelId);
            return;
        }
        if (p.cmd) return; // other BDI commands
    } catch {}

    console.log(`\n[CHAT] ${name}: ${msg}`);

    if (missionRunning) {
        console.log('[LLM] Already running a mission, skipping.');
        return;
    }

    missionRunning = true;
    try {
        await runMissionTurn(`Special mission from ${name}: ${msg}`);
    } catch (err) {
        console.error('[LLM ERROR]', err);
    } finally {
        missionRunning = false;
    }
});


console.log('[LLM AGENT] Started. Listening for special missions via chat.');