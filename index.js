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
const spawnerTiles = [];
const mapGrid = new Map(); // key: "x,y" → tile type
const start = Date.now();

const me = { id: '', name: '', x: -1, y: -1, score: 0, carrying: [] };

var OBSERVATION_DISTANCE;
socket.onConfig(config => OBSERVATION_DISTANCE = config.GAME.player.observation_distance);

// --- LISTENERS ---

socket.on('map', (width, height, tiles) => {
    const typeCounts = {};
    for (const tile of tiles) {
        mapGrid.set(`${tile.x},${tile.y}`, tile.type);
        typeCounts[tile.type] = (typeCounts[tile.type] || 0) + 1;
        if (tile.type === '2') deliveryTiles.push({ x: tile.x, y: tile.y });
        if (tile.type === '1') spawnerTiles.push({ x: tile.x, y: tile.y });
    }
    console.log('Tile types found:', typeCounts);
    console.log(`Map loaded. Delivery: ${deliveryTiles.length}, Spawners: ${spawnerTiles.length}`);
});

let pathDone = false;

socket.onYou(async ({ id, name, x, y, score }) => {
    const firstAuth = !me.id;
    me.id = id;
    me.name = name;
    me.x = x !== undefined ? x : me.x;
    me.y = y !== undefined ? y : me.y;
    me.score = score;

    if (firstAuth) {
        console.log('Authenticated, walking predefined path...');
        const path = ['right', 'right', 'down', 'down', 'left', 'left', 'up', 'up'];
        for (const direction of path) {
            await resilientMove(direction);
        }
        await socket.emitPickup();
        console.log('Predefined path complete. Switching to autonomous mode.');
        pathDone = true; // set AFTER path finishes
    }
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

// BFS pathfinding — finds shortest path avoiding walls (type '0')
function bfs(start, goal) {
    const queue = [[start, []]];
    const visited = new Set();
    visited.add(`${Math.round(start.x)},${Math.round(start.y)}`);

    while (queue.length > 0) {
        const [current, path] = queue.shift();
        const cx = Math.round(current.x);
        const cy = Math.round(current.y);

        if (cx === Math.round(goal.x) && cy === Math.round(goal.y)) return path;

        const neighbors = [
            { x: cx + 1, y: cy,     dir: 'right' },
            { x: cx - 1, y: cy,     dir: 'left'  },
            { x: cx,     y: cy + 1, dir: 'up'    },
            { x: cx,     y: cy - 1, dir: 'down'  },
        ];

        for (const n of neighbors) {
            const key = `${n.x},${n.y}`;
            const type = mapGrid.get(key);
            // walkable: type 1 (spawner), 2 (delivery), 3 (walkable), 4 (base)
            if (!visited.has(key) && type !== undefined && type !== '0') {
                visited.add(key);
                queue.push([{ x: n.x, y: n.y }, [...path, n.dir]]);
            }
        }
    }

    return null; // no path found
}

// Move to target using BFS path
async function moveTo(target) {
    const path = bfs(me, target);
    if (!path || path.length === 0) {
        console.log(`No path found to (${target.x},${target.y})`);
        return;
    }
    console.log(`Path to (${target.x},${target.y}): ${path.join(' -> ')}`);
    for (const dir of path) {
        await resilientMove(dir);
    }
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
    // Wait until authenticated
    await new Promise(res => {
        const check = setInterval(() => {
            if (me.id) { clearInterval(check); res(); }
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

        // DECISION 1: Not carrying anything — find nearest free parcel
        if (me.carrying.length === 0) {
            const nearest = Array.from(parcels.values())
                .filter(p => !p.carriedBy)
                .sort((a, b) => distance(me, a) - distance(me, b))[0];

            if (!nearest) {
                // No parcels visible — explore nearest spawner
                const nearestSpawner = [...spawnerTiles]
                    .sort((a, b) => distance(me, a) - distance(me, b))[0];

                if (nearestSpawner) {
                    console.log(`No parcels visible, exploring spawner at (${nearestSpawner.x},${nearestSpawner.y})`);
                    await moveTo(nearestSpawner);
                } else {
                    console.log('No parcels and no spawners known yet.');
                }
                continue;
            }

            console.log(`Heading to parcel ${nearest.id} at (${nearest.x},${nearest.y})`);

            if (distance(me, nearest) === 0) {
                me.carrying = await socket.emitPickup();
                console.log('Picked up parcel!');
            } else {
                await moveTo(nearest);
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
                await moveTo(nearestDelivery);
            }
        }
    }
}

main();