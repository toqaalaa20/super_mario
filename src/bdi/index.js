import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import dotenv from 'dotenv';
dotenv.config();

import { beliefs, updateFromSensing, setMap } from './beliefs.js';
import { reviseIntention, getCurrentIntention, setMissionState } from './intentions.js';
import { executePlan } from './executor.js';

const socket = new DjsConnect(
    process.env.BDI_HOST || 'http://localhost:8080',
    process.env.BDI_TOKEN,
);

socket.onConnect(() => console.log('[BDI] Connected to Deliveroo'));

socket.on('map', (width, height, tiles) => {
    setMap(tiles);
    console.log('[BDI] Map loaded:', tiles.length, 'tiles');
});

// ─── Listen for mission commands from the LLM agent via game chat ─────────────

socket.onMsg((id, name, msg) => {
    // Only process messages from our LLM agent
    if (name !== process.env.LLM_AGENT_NAME) return;

    try {
        const parsed = JSON.parse(msg);

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
        // Not a command message — ignore
    }
});

// ─── Main sensing loop ────────────────────────────────────────────────────────

let running = false;

socket.onSensing(async (sensing) => {
    updateFromSensing(sensing);

    if (running) return;
    running = true;

    try {
        reviseIntention();
        const intent = getCurrentIntention();
        console.log('[BDI] Intention:', intent?.type, intent?.target ?? '');
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
});