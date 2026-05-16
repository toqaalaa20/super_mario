import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import dotenv from 'dotenv';
dotenv.config();

import { beliefs, updateFromSensing, setMap, deliveryTiles, spawnerTiles, freeParcels } from './beliefs.js';
import { manhattan, bfs } from './utils.js';

const socket = new DjsConnect(
    process.env.DELIVEROO_HOST || 'http://localhost:8080',
    process.env.DELIVEROO_TOKEN
);

// --- MAP GRID for BFS ---
const mapGrid = new Map(); // key: "x,y" → tile type

// --- LISTENERS ---

socket.onConnect(() => console.log('connected'));

socket.on('map', (width, height, tiles) => {
    console.log('map event fired, tiles received:', tiles?.length, 'sample:', tiles?.[0]);
    setMap(tiles);
    const typeCounts = {};
    for (const tile of tiles) {
        mapGrid.set(`${tile.x},${tile.y}`, tile.type);
        typeCounts[tile.type] = (typeCounts[tile.type] || 0) + 1;
    }
    console.log('Tile types found:', typeCounts);
    console.log(`Map loaded. Delivery: ${deliveryTiles().length}, Spawners: ${spawnerTiles().length}`);
});

socket.onSensing((sensing) => {
    updateFromSensing(sensing);
    console.log('sensing:', {
        me: beliefs.me,
        parcels: beliefs.parcels.size,
        agents: beliefs.agents.size,
        carrying: beliefs.carrying.length
    });
});

// --- MOVEMENT ---

let pathDone = false;

socket.onYou(async ({ id, name, x, y, score }) => {
    const firstAuth = !beliefs.me?.id;

    // onYou fires before onSensing on first connect, so manually set me
    if (!beliefs.me) beliefs.me = { id, name, x, y, score };
    else {
        beliefs.me.x = x !== undefined ? x : beliefs.me.x;
        beliefs.me.y = y !== undefined ? y : beliefs.me.y;
        beliefs.me.score = score;
    }

    if (firstAuth) {
        console.log('Authenticated, walking predefined path...');
        const path = ['right', 'right', 'down', 'down', 'left', 'left', 'up', 'up'];
        for (const direction of path) {
            await resilientMove(direction);
        }
        await socket.emitPickup();
        console.log('Predefined path complete. Switching to autonomous mode.');
        pathDone = true;
    }
});

// Retries a move up to maxRetries times if blocked
async function resilientMove(direction, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        const result = await socket.emitMove(direction);
        if (result) return result;
        console.log(`${beliefs.me?.name} blocked moving ${direction}, retry ${i + 1}/${maxRetries}`);
        await new Promise(res => setTimeout(res, 200));
    }
    return null;
}

// Move to target using BFS path
async function moveTo(target) {
    const path = bfs(beliefs.me, target, mapGrid);
    if (!path || path.length === 0) {
        console.log(`No path found to (${target.x},${target.y})`);
        return;
    }
    console.log(`Path to (${target.x},${target.y}): ${path.join(' -> ')}`);
    for (const dir of path) {
        await resilientMove(dir);
    }
}

// --- MAIN LOOP ---

async function main() {
    // Wait until authenticated
    await new Promise(res => {
        const check = setInterval(() => {
            if (beliefs.me?.id) { clearInterval(check); res(); }
        }, 100);
    });

    // Wait for predefined path to finish
    await new Promise(res => {
        const check = setInterval(() => {
            if (pathDone) { clearInterval(check); res(); }
        }, 100);
    });

    console.log('Starting autonomous loop...');

    while (true) {
        await new Promise(res => setTimeout(res, 100));

        const me = beliefs.me;
        if (!me) continue;

        // DECISION 1: Not carrying anything — find nearest free parcel
        if (beliefs.carrying.length === 0) {
            const nearest = freeParcels()
                .sort((a, b) => manhattan(me, a) - manhattan(me, b))[0];

            if (!nearest) {
                // No parcels visible — explore nearest spawner
                const nearest_spawner = spawnerTiles()
                    .sort((a, b) => manhattan(me, a) - manhattan(me, b))[0];

                if (nearest_spawner) {
                    console.log(`No parcels visible, exploring spawner at (${nearest_spawner.x},${nearest_spawner.y})`);
                    await moveTo(nearest_spawner);
                } else {
                    console.log('No parcels and no spawners known yet.');
                }
                continue;
            }

            console.log(`Heading to parcel ${nearest.id} at (${nearest.x},${nearest.y})`);

            if (manhattan(me, nearest) === 0) {
                await socket.emitPickup();
                console.log('Picked up parcel!');
            } else {
                await moveTo(nearest);
            }

        // DECISION 2: Carrying parcels — go to nearest delivery tile
        } else {
            const nearest_delivery = deliveryTiles()
                .sort((a, b) => manhattan(me, a) - manhattan(me, b))[0];

            if (!nearest_delivery) {
                console.log('No delivery tiles known yet.');
                continue;
            }

            console.log(`Heading to delivery at (${nearest_delivery.x},${nearest_delivery.y})`);

            if (manhattan(me, nearest_delivery) === 0) {
                await socket.emitPutdown();
                beliefs.carrying = [];
                console.log('Delivered!');
            } else {
                await moveTo(nearest_delivery);
            }
        }
    }
}

main();