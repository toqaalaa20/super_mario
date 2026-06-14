// problemGenerator.js
// Builds a PDDL problem instance describing the parcel pickup/delivery
// sequencing decision: which free parcels (plus anything already carried)
// to collect, and which delivery tile(s) to use, minimizing total travel
// distance (Manhattan distance between waypoints).
import { beliefs, freeParcels, deliveryTiles } from '../beliefs.js';
import { manhattan } from '../utils.js';
import { parcelAllowed, filterAvoidedTiles, sortDeliveryTiles } from '../intentions.js';

const MAX_PARCELS = 4;
const MAX_DELIVERY_TILES = 3;

/**
 * Builds a PDDL problem string for the current beliefs.
 * Returns null if there's nothing worth planning for (no carried parcels,
 * no free candidates, or no reachable delivery tile).
 *
 * @returns {{ problem: string, locationMap: object, parcelMap: object } | null}
 */
export function buildProblem() {
    const me = beliefs.me;
    if (!me) return null;
    const meSnapped = { x: Math.round(me.x), y: Math.round(me.y) };

    const freeCandidates = freeParcels()
        .filter(p => p.reward > 5 && parcelAllowed(p))
        .map(p => ({ ...p, _score: p.reward / (manhattan(me, p) + 1) }))
        .sort((a, b) => b._score - a._score)
        .slice(0, MAX_PARCELS);

    const carriedParcels = beliefs.carrying
        .map(id => beliefs.carriedParcels.get(id))
        .filter(Boolean);

    if (freeCandidates.length === 0 && carriedParcels.length === 0) return null;

    const deliveryCandidates = sortDeliveryTiles(filterAvoidedTiles(deliveryTiles()), me)
        .slice(0, MAX_DELIVERY_TILES);

    if (deliveryCandidates.length === 0) return null;

    // ── Build locations ──────────────────────────────────────────────────
    const locations = [{ name: 'loc-agent', x: meSnapped.x, y: meSnapped.y }];
    const locationMap = { 'loc-agent': { x: meSnapped.x, y: meSnapped.y } };

    for (const p of freeCandidates) {
        const name = `loc-p${p.id}`;
        locations.push({ name, x: p.x, y: p.y });
        locationMap[name] = { x: p.x, y: p.y, parcelId: p.id };
    }

    const parcelMap = {};
    for (const p of freeCandidates) parcelMap[`p${p.id}`] = p;
    for (const p of carriedParcels) parcelMap[`p${p.id}`] = p;

    deliveryCandidates.forEach((tile, i) => {
        const name = `loc-d${i}`;
        locations.push({ name, x: tile.x, y: tile.y });
        locationMap[name] = { x: tile.x, y: tile.y, deliveryIndex: i, tile };
    });

    // ── :objects ─────────────────────────────────────────────────────────
    const locationNames = locations.map(l => l.name);
    const parcelNames = Object.keys(parcelMap);

    const objects =
        `    ${locationNames.join(' ')} - location\n` +
        `    ${parcelNames.join(' ')} - parcel`;

    // ── :init ────────────────────────────────────────────────────────────
    const initLines = [];
    initLines.push('(agent-at loc-agent)');
    for (const p of freeCandidates) initLines.push(`(parcel-at p${p.id} loc-p${p.id})`);
    for (const p of carriedParcels) initLines.push(`(carrying p${p.id})`);
    deliveryCandidates.forEach((_, i) => initLines.push(`(is-delivery loc-d${i})`));

    for (const a of locations) {
        for (const b of locations) {
            if (a.name === b.name) continue;
            initLines.push(`(= (distance ${a.name} ${b.name}) ${manhattan(a, b)})`);
        }
    }
    initLines.push('(= (total-cost) 0)');

    // ── :goal ────────────────────────────────────────────────────────────
    const goalLines = parcelNames.map(p => `(delivered ${p})`);

    const problem = `(define (problem deliveroo-sequencing)
  (:domain deliveroo)
  (:objects
${objects})
  (:init
    ${initLines.join('\n    ')})
  (:goal (and ${goalLines.join(' ')}))
  (:metric minimize (total-cost)))
`;

    return { problem, locationMap, parcelMap };
}
