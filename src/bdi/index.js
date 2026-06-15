import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import dotenv from 'dotenv';
dotenv.config();

import { beliefs, updateFromSensing, setMap } from './beliefs.js';
import { reviseIntention, getCurrentIntention, setMissionState, missionState } from './intentions.js';
import { executePlan } from './executor.js';

const socket = new DjsConnect(
    process.env.BDI_HOST || 'http://localhost:8080',
    process.env.BDI_TOKEN,
);

socket.onConnect(() => {
    console.log('[BDI] Connected to Deliveroo');
    setTimeout(() => socket.emitShout(JSON.stringify({ cmd: 'HELLO' })), 1000);
});

socket.on('map', (width, height, tiles) => {
    setMap(tiles);
    console.log('[BDI] Map loaded:', tiles.length, 'tiles');
});

// ─── Listen for mission commands from the LLM agent via game chat ─────────────

socket.onMsg((id, name, msg) => {
    if (id === beliefs.me?.id) return;
    if (name === process.env.LLM_AGENT_NAME && !llmAgentId) {
        llmAgentId = id;
        console.log('[BDI] Learned LLM agent ID:', llmAgentId);
    }
    try {
        const parsed = JSON.parse(msg);

        if (parsed.cmd === 'HELLO' && name === process.env.LLM_AGENT_NAME) {
            llmAgentId = id;
            console.log('[BDI] Learned LLM agent ID from handshake:', llmAgentId);
            return;
        }

        if (parsed.cmd === 'CLAIM' && name === process.env.LLM_AGENT_NAME) {
            const myIntent = getCurrentIntention();
            if (myIntent?.type === 'pickup' && myIntent.target?.id === parsed.parcelId) {
                // Already targeting the same parcel ourselves — let the server
                // arbitrate who physically gets there first instead of trading
                // CLAIM replies back and forth (which could ping-pong forever
                // now that the LLM side also ignores claims on its own target).
                console.log('[BDI] Ignoring CLAIM for', parsed.parcelId, '— already targeting it');
                return;
            }
            beliefs.claimedByOther.set(id, parsed.parcelId);
            console.log('[BDI] Received CLAIM from LLM:', parsed.parcelId);
            return;
        }

        if (name !== process.env.LLM_AGENT_NAME) return;

        if (parsed.cmd === 'MISSION') {
            setMissionState({
                active: true,
                type: parsed.type,
                params: parsed.params ?? {},
                description: parsed.description ?? '',
            });
            console.log('[BDI] Mission received from LLM agent:', parsed.description);
        }

        if (parsed.cmd === 'MISSION_CLEAR') {
            setMissionState({ active: false, type: null, params: {}, description: '' });
            console.log('[BDI] Mission cleared by LLM agent');
        }
    } catch {
        // Not a command message — plain chat text. Check for the green-light signal here
        // so it can't be triggered by the JSON MISSION command that sets up WAIT_FOR_SIGNAL
        // (whose description may itself contain the word "green").
        if (missionState.type === 'WAIT_FOR_SIGNAL' && msg.toLowerCase().includes('green')) {
            setMissionState({ ...missionState, params: { ...missionState.params, frozen: false } });
            console.log('[BDI] Green light received — unfreezing');
        }
    }
});

// ─── Main sensing loop ────────────────────────────────────────────────────────

let running = false;
let lastClaimedId = null;
let llmAgentId = null; // learned from first message received from LLM

socket.onSensing(async (sensing) => {
    updateFromSensing(sensing);

    if (running) return;
    running = true;

    try {
        reviseIntention();
        const intent = getCurrentIntention();
        if (intent?.type === 'pickup' && intent.target?.id !== lastClaimedId) {
            lastClaimedId = intent.target.id;
            if (llmAgentId) {
                socket.emitSay(llmAgentId, JSON.stringify({ cmd: 'CLAIM', parcelId: intent.target.id }));
                console.log('[BDI] Claimed parcel:', intent.target.id, '→ LLM');
            } else {
                console.log('[BDI] Claim skipped — LLM ID not yet known');
            }
        }
        if (intent) await executePlan(socket, intent);
    } catch (err) {
        console.error('[BDI ERROR]', err.message);
    } finally {
        running = false;
    }
});

socket.onYou(({ id, name, x, y, score }) => {
    if (!beliefs.me) {
        beliefs.me = { id, name, x, y, score };
    } else {
        Object.assign(beliefs.me, { x, y, score });
    }
    if (llmAgentId) {
        socket.emitSay(llmAgentId, JSON.stringify({ cmd: 'STATUS', x, y }));
    }
});