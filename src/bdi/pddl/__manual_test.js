// Manual test script — NOT part of the normal `npm start` run.
// Run with: node src/bdi/pddl/__manual_test.js
//
// Builds a small fake belief state, generates a PDDL problem, prints it,
// and (if PDDL_ENABLED=true) calls the hosted solver and prints the
// translated plan.
import dotenv from 'dotenv';
dotenv.config();

import { beliefs, setMap } from '../beliefs.js';
import { buildProblem } from './problemGenerator.js';
import { solve } from './plannerClient.js';
import { translatePlan } from './planTranslator.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const domain = fs.readFileSync(path.join(__dirname, 'domain.pddl'), 'utf-8');

// ── Fake world ───────────────────────────────────────────────────────────
beliefs.me = { id: 'me', name: 'SuperMario', x: 0, y: 0, score: 0 };
beliefs.carrying = [];
beliefs.carriedParcels = new Map();
beliefs.agents = new Map();
beliefs.claimedByOther = new Map();

beliefs.parcels = new Map([
    ['p1', { id: 'p1', x: 3, y: 0, reward: 20, carriedBy: null, _lastSeen: 1 }],
    ['p2', { id: 'p2', x: 0, y: 5, reward: 30, carriedBy: null, _lastSeen: 1 }],
    ['p3', { id: 'p3', x: 6, y: 6, reward: 10, carriedBy: null, _lastSeen: 1 }],
]);

setMap([
    { x: 0, y: 0, type: '1' },
    { x: 1, y: 0, type: '1' },
    { x: 7, y: 7, type: '2', delivery: true }, // delivery tile
    { x: 0, y: 7, type: '2', delivery: true }, // another delivery tile
]);

// ── Build problem ────────────────────────────────────────────────────────
const built = buildProblem();
if (!built) {
    console.log('No problem to solve (no candidates).');
    process.exit(0);
}

console.log('--- domain.pddl ---');
console.log(domain);
console.log('--- generated problem.pddl ---');
console.log(built.problem);

// ── Optionally call the hosted solver ───────────────────────────────────
if (process.env.PDDL_ENABLED !== 'false') {
    console.log('--- calling hosted solver ---');
    const result = await solve(domain, built.problem);
    if (!result) {
        console.log('Solver returned no result (timeout/error) — fallback to greedy would apply.');
    } else {
        console.log('Raw plan actions:', result.plan);
        const translated = translatePlan(result.plan, built);
        console.log('Translated intentions:', translated.map(i =>
            `${i.type}(${i.target?.id ?? `${i.target?.x},${i.target?.y}`})`));
    }
}
