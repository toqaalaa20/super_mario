import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import dotenv from 'dotenv';
dotenv.config();

const socket = new DjsConnect(
    process.env.DELIVEROO_HOST || 'http://localhost:8080',
    process.env.DELIVEROO_TOKEN
);

// --- STATE ---
const beliefset = new Map();
const parcels = new Map();
const deliveryTiles = [];
const start = Date.now();

const me = { id: '', name: '', x: -1, y: -1, score: 0, carrying: [] };

var OBSERVATION_DISTANCE;
socket.onConfig(config => OBSERVATION_DISTANCE = config.GAME.player.observation_distance);

// --- LISTENERS ---

socket.onYou(({ id, name, x, y, score }) => {
    me.id = id;
    me.name = name;
    me.x = x !== undefined ? x : me.x;
    me.y = y !== undefined ? y : me.y;
    me.score = score;
});

// Parse map: store delivery tiles, then walk predefined path and pick up
socket.on('map', async (width, height, tiles) => {
    for (const tile of tiles) {
        if (tile.type === 2) {
            deliveryTiles.push({ x: tile.x, y: tile.y });
        }
    }
    console.log(`Map loaded. Delivery points found: ${deliveryTiles.length}`);

    // LAB REQUIREMENT: Walk a predefined path on startup
    const path = ['right', 'right', 'down', 'down', 'left', 'left', 'up', 'up'];
    console.log('Walking predefined path...');
    for (const direction of path) {
        const result = await socket.emitMove(direction);
        if (!result) {
            console.log(`Move ${direction} failed, retrying...`);
            await new Promise(r => setTimeout(r, 100));
            await socket.emitMove(direction); // one retry
        }
    }

    // Pick up anything at current position after the path
    await socket.emitPickup();
    console.log('Predefined path complete. Switching to autonomous mode.');
});

socket.onSensing(({ parcels: sensedParcels, agents }) => {
    // Update parcels
    for (const p of sensedParcels) {
        parcels.set(p.id, p);
    }

    // Update beliefset with agent positions + direction inference
    const timestamp = Date.now() - start;
    for (const a of agents) {
        if (!beliefset.has(a.id)) beliefset.set(a.id, []);
        const logs = beliefset.get(a.id);
        const log = {
            id: a.id,
            name: a.name,
            x: a.x,
            y: a.y,
            score: a.score,
            timestamp,
            direction: 'none'
        };
        if (logs.length > 0) {
            const prev = logs[logs.length - 1];
            if      (prev.x < a.x) log.direction = 'right';
            else if (prev.x > a.x) log.direction = 'left';
            else if (prev.y < a.y) log.direction = 'up';
            else if (prev.y > a.y) log.direction = 'down';
        }
        logs.push(log);
    }

    // Pretty-print observed agents
    const prettyPrint = Array.from(beliefset.values()).map(logs => {
        const { timestamp, name, x, y, direction } = logs[logs.length - 1];
        const d = distance(me, { x, y });
        return `${name}(${direction},within=${d < OBSERVATION_DISTANCE})@${timestamp}:${x},${y}`;
    }).join(' ');
    if (prettyPrint) console.log(prettyPrint);
});

// --- HELPERS ---

function distance({ x: x1, y: y1 }, { x: x2, y: y2 }) {
    return Math.abs(Math.round(x1) - Math.round(x2)) + Math.abs(Math.round(y1) - Math.round(y2));
}

// Waits for movement animation to complete before resolving
async function blindMove(target) {
    console.log(`${me.name} moving from (${me.x},${me.y}) towards (${target.x},${target.y})`);

    // Promise that resolves once the agent is fully on a tile (not mid-animation)
    const moved = new Promise(res =>
        socket.onYou(({ x, y }) => (x % 1 !== 0 || y % 1 !== 0) ? null : res())
    );

    if      (me.x < target.x) await socket.emitMove('right');
    else if (me.x > target.x) await socket.emitMove('left');
    else if (me.y < target.y) await socket.emitMove('up');
    else if (me.y > target.y) await socket.emitMove('down');

    await moved;
}

// Retries a move up to maxRetries times if blocked
async function resilientMove(direction, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        const result = await socket.emitMove(direction);
        if (result) return result;
        console.log(`${me.name} blocked moving ${direction}, retry ${i + 1}/${maxRetries}`);
        await new Promise(res => setTimeout(res, 200));
    }
    return null;
}

// --- MAIN LOOP ---

async function main() {
    while (true) {
        await new Promise(res => setTimeout(res, 100));

        if (!me.id) continue;

        // DECISION 1: Not carrying anything — find nearest free parcel
        if (me.carrying.length === 0) {
            const nearest = Array.from(parcels.values())
                .filter(p => !p.carriedBy)
                .sort((a, b) => distance(me, a) - distance(me, b))[0];

            if (!nearest) {
                console.log('No parcels available.');
                continue;
            }

            console.log(`Heading to parcel ${nearest.id} at (${nearest.x},${nearest.y})`);

            if (distance(me, nearest) === 0) {
                me.carrying = await socket.emitPickup();
                console.log('Picked up parcel!');
            } else {
                await blindMove(nearest);
            }

        // DECISION 2: Carrying parcels — go to nearest delivery tile
        } else {
            const nearestDelivery = [...deliveryTiles]
                .sort((a, b) => distance(me, a) - distance(me, b))[0];

            if (!nearestDelivery) {
                console.log('No delivery tiles known yet.');
                continue;
            }

            console.log(`Heading to delivery at (${nearestDelivery.x},${nearestDelivery.y})`);

            if (distance(me, nearestDelivery) === 0) {
                await socket.emitPutdown();
                me.carrying = [];
                console.log('Delivered!');
            } else {
                await blindMove(nearestDelivery);
            }
        }
    }
}

main();