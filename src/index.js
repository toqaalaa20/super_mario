// src/index.js
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import dotenv from 'dotenv';
dotenv.config();

import { beliefs, updateFromSensing, setMap } from './beliefs.js';
import { reviseIntention, getCurrentIntention } from './intentions.js';
import { executePlan } from './executor.js';

const socket = new DjsConnect(
    process.env.DELIVEROO_HOST || 'http://localhost:8080',
    process.env.DELIVEROO_TOKEN
);

socket.onConnect(() => console.log('connected to deliveroo'));

socket.on('map', (width, height, tiles) => {
    setMap(tiles);
    console.log('Map loaded');
});

let running = false;

socket.onSensing(async (sensing) => {
    updateFromSensing(sensing);

    if (running) return; // don't stack ticks if an action is still in progress
    running = true;

    try {
        reviseIntention();
        const intent = getCurrentIntention();
        console.log('Current intention:', intent);
        console.log('Beliefs:', {
            me: beliefs.me,
            parcels: Array.from(beliefs.parcels.values()),
            carrying: beliefs.carrying,
            carriedParcels: beliefs.carriedParcels,        
        });
        if (intent) await executePlan(socket, intent);
    } catch (err) {
        console.error('[AGENT ERROR]', err.message);
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