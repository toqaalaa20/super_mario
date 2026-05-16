// index.js (Modified section)
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import dotenv from 'dotenv';
dotenv.config();

import { beliefs, updateFromSensing, setMap } from './beliefs.js';
import { reviseIntention, getCurrentIntention } from './intentions.js';
import { executePlan } from './executor.js'; // New import

const socket = new DjsConnect(
    process.env.DELIVEROO_HOST || 'http://localhost:8080',
    process.env.DELIVEROO_TOKEN
);

socket.onConnect(() => console.log('connected to deliveroo'));

socket.on('map', (width, height, tiles) => {
    setMap(tiles);
    console.log('Map loaded');
});

// Main Loop
socket.onSensing(async (sensing) => {
    updateFromSensing(sensing);
    reviseIntention();
    
    const intent = getCurrentIntention();
    if (intent) {
        // Execute the plan using A* pathfinding
        await executePlan(socket, intent);
    }
});

socket.onYou(({ id, name, x, y, score }) => {
    if (!beliefs.me) {
        beliefs.me = { id, name, x, y, score };
    } else {
        Object.assign(beliefs.me, { x, y, score });
    }
});