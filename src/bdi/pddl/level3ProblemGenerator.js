// level3ProblemGenerator.js
// PDDL problem builders for Level 3 coordination missions.
// Reuses the same deliveroo domain (move/pickup/deliver) but constructs
// problem instances tailored to each Level 3 scenario.

import { beliefs, freeParcels, deliveryTiles } from '../beliefs.js';
import { manhattan } from '../utils.js';
import { parcelAllowed, filterAvoidedTiles, sortDeliveryTiles } from '../intentions.js';

const MAX_DELIVERY_TILES = 3;
const MAX_DROP_CANDIDATES = 4;
const MAX_HANDOFF_DELIVERY_TILES = 2;
const DROP_SEARCH_RADIUS = 3;

// ─── Shared helpers ───────────────────────────────────────────────────────────

function initDistances(locations) {
    const lines = [];
    for (const a of locations) {
        for (const b of locations) {
            if (a.name === b.name) continue;
            lines.push(`(= (distance ${a.name} ${b.name}) ${manhattan(a, b)})`);
        }
    }
    return lines;
}

// ─── PICKUP_AND_DELIVER problem ───────────────────────────────────────────────

/**
 * Build a PDDL problem for the PICKUP_AND_DELIVER Level-3 mission.
 *
 * The BDI agent must navigate to the handoff drop point, pick up the parcel
 * (even if it isn't in beliefs yet), and deliver it to a delivery zone.
 * Up to two extra free parcels nearby the drop point are bundled in the same
 * problem so the planner can co-optimise the whole delivery trip.
 *
 * @param {string} parcelId   ID of the handoff parcel
 * @param {number} dropX      x coordinate of the drop point
 * @param {number} dropY      y coordinate of the drop point
 * @returns {{ problem, locationMap, parcelMap } | null}
 */
export function buildPickupAndDeliverProblem(parcelId, dropX, dropY) {
    const me = beliefs.me;
    if (!me) return null;
    const meSnapped = { x: Math.round(me.x), y: Math.round(me.y) };

    // The handoff parcel — may not be in beliefs yet (LLM just dropped it)
    const handoffParcel = beliefs.parcels.get(parcelId) ?? {
        id: parcelId, x: dropX, y: dropY, reward: 20,
    };

    // Extra free parcels that are close to the drop point (opportunistic pick-ups)
    const dropPt = { x: dropX, y: dropY };
    const extraParcels = freeParcels()
        .filter(p => p.id !== parcelId && p.reward > 5 && parcelAllowed(p))
        .filter(p => manhattan(dropPt, p) <= 4)   // within 4 tiles of the drop point
        .map(p => ({ ...p, _score: p.reward / (manhattan(me, p) + 1) }))
        .sort((a, b) => b._score - a._score)
        .slice(0, 2);

    // Parcels already carried by the agent (continue delivering those too)
    const carriedParcels = beliefs.carrying
        .filter(id => id !== parcelId)
        .map(id => beliefs.carriedParcels.get(id))
        .filter(Boolean);

    const deliveryCandidates = sortDeliveryTiles(filterAvoidedTiles(deliveryTiles()), me)
        .slice(0, MAX_DELIVERY_TILES);

    if (deliveryCandidates.length === 0) {
        console.warn('[PDDL-L3] PICKUP_AND_DELIVER: no delivery tiles available');
        return null;
    }
    console.log(`[PDDL-L3] PICKUP_AND_DELIVER: handoff=${parcelId} extra=${extraParcels.length} carried=${carriedParcels.length} deliveryTiles=${deliveryCandidates.length}`);

    // ── Build locations ──────────────────────────────────────────────────────
    const locations = [{ name: 'loc-agent', x: meSnapped.x, y: meSnapped.y }];
    const locationMap = { 'loc-agent': { x: meSnapped.x, y: meSnapped.y } };
    const parcelMap = {};

    const addLoc = (name, x, y, extra = {}) => {
        if (!locationMap[name]) {
            locations.push({ name, x, y });
            locationMap[name] = { x, y, ...extra };
        }
    };

    // Handoff parcel location
    addLoc(`loc-p${parcelId}`, dropX, dropY, { parcelId });
    parcelMap[`p${parcelId}`] = handoffParcel;

    // Extra free parcels
    for (const p of extraParcels) {
        addLoc(`loc-p${p.id}`, p.x, p.y, { parcelId: p.id });
        parcelMap[`p${p.id}`] = p;
    }

    // Already-carried parcels (no location needed — they're on the agent)
    for (const p of carriedParcels) {
        parcelMap[`p${p.id}`] = p;
    }

    // Delivery tiles
    deliveryCandidates.forEach((tile, i) => {
        const name = `loc-d${i}`;
        locations.push({ name, x: tile.x, y: tile.y });
        locationMap[name] = { x: tile.x, y: tile.y, deliveryIndex: i, tile };
    });

    // ── :objects ─────────────────────────────────────────────────────────────
    const locationNames = locations.map(l => l.name);
    const parcelNames = Object.keys(parcelMap);

    const objects =
        `    ${locationNames.join(' ')} - location\n` +
        `    ${parcelNames.join(' ')} - parcel`;

    // ── :init ─────────────────────────────────────────────────────────────────
    const initLines = ['(agent-at loc-agent)'];

    // Handoff parcel is at the drop location (not yet picked up by the BDI)
    if (!beliefs.carrying.includes(parcelId)) {
        initLines.push(`(parcel-at p${parcelId} loc-p${parcelId})`);
    } else {
        initLines.push(`(carrying p${parcelId})`);
    }

    for (const p of extraParcels) {
        initLines.push(`(parcel-at p${p.id} loc-p${p.id})`);
    }
    for (const p of carriedParcels) {
        initLines.push(`(carrying p${p.id})`);
    }

    deliveryCandidates.forEach((_, i) => initLines.push(`(is-delivery loc-d${i})`));
    initLines.push(...initDistances(locations));
    initLines.push('(= (total-cost) 0)');

    // ── :goal ────────────────────────────────────────────────────────────────
    const goalLines = parcelNames.map(p => `(delivered ${p})`);

    const problem = `(define (problem deliveroo-l3-handoff)
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

// ─── COORDINATE_MEETUP problem ────────────────────────────────────────────────

/**
 * Build a PDDL problem for the COORDINATE_MEETUP Level-3 mission.
 *
 * Finds the nearest walkable tile within `radius` of the target, then builds
 * a problem whose goal is for the agent to reach that tile.  Any free parcels
 * that lie on a low-detour path to the meetup are bundled in so the planner
 * can collect them on the way without slowing down the rendezvous.
 *
 * Returns null if no reachable tile exists within the radius, or if the agent
 * is already within the radius (caller should handle that case separately).
 *
 * @param {number} targetX
 * @param {number} targetY
 * @param {number} [radius=3]
 * @returns {{ problem, locationMap, parcelMap, meetupTile } | null}
 */
export function buildMeetupProblem(targetX, targetY, radius = 3) {
    const me = beliefs.me;
    if (!me) return null;
    const meSnapped = { x: Math.round(me.x), y: Math.round(me.y) };

    // Find the closest walkable tile within the radius
    const target = { x: targetX, y: targetY };
    const candidateTiles = beliefs.map
        .filter(t => t.type !== '0' && manhattan(t, target) <= radius)
        .sort((a, b) => manhattan(me, a) - manhattan(me, b));

    if (candidateTiles.length === 0) {
        console.warn(`[PDDL-L3] COORDINATE_MEETUP: no walkable tile within radius ${radius} of (${targetX},${targetY})`);
        return null;
    }
    const meetupTile = candidateTiles[0];
    console.log(`[PDDL-L3] COORDINATE_MEETUP: resolved meetupTile=(${meetupTile.x},${meetupTile.y}) dist=${manhattan(me, meetupTile)} from agent=(${me.x},${me.y})`);

    const directDist = manhattan(me, meetupTile);

    // Free parcels that lie near the direct path (detour ≤ 3 tiles)
    const nearbyParcels = freeParcels()
        .filter(p => p.reward > 5 && parcelAllowed(p))
        .filter(p => {
            const detour = manhattan(me, p) + manhattan(p, meetupTile) - directDist;
            return detour <= 3;
        })
        .map(p => ({ ...p, _score: p.reward / (manhattan(me, p) + 1) }))
        .sort((a, b) => b._score - a._score)
        .slice(0, 2);

    // Parcels already carried
    const carriedParcels = beliefs.carrying
        .map(id => beliefs.carriedParcels.get(id))
        .filter(Boolean);

    console.log(`[PDDL-L3] COORDINATE_MEETUP: nearbyParcels=${nearbyParcels.length} carried=${carriedParcels.length} directDist=${directDist}`);
    const hasParcelWork = nearbyParcels.length > 0 || carriedParcels.length > 0;

    // Delivery tiles — only needed if there are parcels to deliver
    const deliveryCandidates = hasParcelWork
        ? sortDeliveryTiles(filterAvoidedTiles(deliveryTiles()), me).slice(0, 2)
        : [];

    // ── Build locations ──────────────────────────────────────────────────────
    const locations = [
        { name: 'loc-agent', x: meSnapped.x, y: meSnapped.y },
        { name: 'loc-meetup', x: meetupTile.x, y: meetupTile.y },
    ];
    const locationMap = {
        'loc-agent': { x: meSnapped.x, y: meSnapped.y },
        'loc-meetup': { x: meetupTile.x, y: meetupTile.y, isMeetup: true },
    };
    const parcelMap = {};

    for (const p of nearbyParcels) {
        const name = `loc-p${p.id}`;
        if (!locationMap[name]) {
            locations.push({ name, x: p.x, y: p.y });
            locationMap[name] = { x: p.x, y: p.y, parcelId: p.id };
        }
        parcelMap[`p${p.id}`] = p;
    }
    for (const p of carriedParcels) {
        parcelMap[`p${p.id}`] = p;
    }

    deliveryCandidates.forEach((tile, i) => {
        const name = `loc-d${i}`;
        locations.push({ name, x: tile.x, y: tile.y });
        locationMap[name] = { x: tile.x, y: tile.y, deliveryIndex: i, tile };
    });

    // ── :objects ─────────────────────────────────────────────────────────────
    const locationNames = locations.map(l => l.name);
    const parcelNames = Object.keys(parcelMap);

    const objectsLines = [`    ${locationNames.join(' ')} - location`];
    if (parcelNames.length > 0) {
        objectsLines.push(`    ${parcelNames.join(' ')} - parcel`);
    }

    // ── :init ─────────────────────────────────────────────────────────────────
    const initLines = ['(agent-at loc-agent)'];
    for (const p of nearbyParcels) initLines.push(`(parcel-at p${p.id} loc-p${p.id})`);
    for (const p of carriedParcels) initLines.push(`(carrying p${p.id})`);
    deliveryCandidates.forEach((_, i) => initLines.push(`(is-delivery loc-d${i})`));
    initLines.push(...initDistances(locations));
    initLines.push('(= (total-cost) 0)');

    // ── :goal ────────────────────────────────────────────────────────────────
    // Must reach the meetup tile; also deliver any parcels we pick up or carry
    const deliverGoals = parcelNames.map(p => `(delivered ${p})`);
    const goalParts = ['(agent-at loc-meetup)', ...deliverGoals];

    const problem = `(define (problem deliveroo-l3-meetup)
  (:domain deliveroo)
  (:objects
${objectsLines.join('\n')})
  (:init
    ${initLines.join('\n    ')})
  (:goal (and ${goalParts.join(' ')}))
  (:metric minimize (total-cost)))
`;

    return { problem, locationMap, parcelMap, meetupTile };
}

// ─── PARCEL_HANDOFF drop-point problem ────────────────────────────────────────

/**
 * Build a two-agent PDDL problem (domain_handoff.pddl) that jointly chooses:
 *  - where the LLM agent (currently carrying `parcelId`) should drop the
 *    parcel — a non-delivery tile near its current position, and
 *  - which delivery tile the BDI agent should subsequently use,
 * minimizing the SUM of both agents' travel distances.
 *
 * Unlike buildPickupAndDeliverProblem (which only models the calling agent's
 * position and is used AFTER the drop has already happened), this is meant
 * to be solved BEFORE putdown() — its output (the chosen drop tile) is what
 * the LLM should walk to before dropping the parcel.
 *
 * @param {string} parcelId              ID of the parcel the LLM is carrying
 * @param {{x:number,y:number}} bdiPos   BDI agent's last known position
 * @returns {{ problem: string, locationMap: object, parcelMap: object } | null}
 */
export function buildHandoffDropProblem(parcelId, bdiPos) {
    const me = beliefs.me;
    if (!me || !bdiPos) return null;

    const meSnapped = { x: Math.round(me.x), y: Math.round(me.y) };
    // bdiPos comes from STATUS messages and can be mid-move (e.g. y=11.4 — agents
    // are nudged by 0.6 then 0.4 during a move action). PDDL numeric init values
    // must be integers, so snap here too.
    const bdiSnapped = { x: Math.round(bdiPos.x), y: Math.round(bdiPos.y) };

    const parcel = beliefs.carriedParcels.get(parcelId) ?? { id: parcelId, reward: 0 };

    // Candidate drop tiles: walkable, non-delivery tiles near the LLM's current
    // position (it just picked up the parcel here, so "near" = small detour).
    const dropCandidates = beliefs.map
        .filter(t => t.type !== '0' && !(t.delivery === true || t.type === '2'))
        .map(t => ({ ...t, _dist: manhattan(meSnapped, t) }))
        .filter(t => t._dist <= DROP_SEARCH_RADIUS)
        .sort((a, b) => a._dist - b._dist)
        .slice(0, MAX_DROP_CANDIDATES);

    if (dropCandidates.length === 0) {
        console.warn(`[PDDL-HANDOFF] no non-delivery walkable tiles within ${DROP_SEARCH_RADIUS} of (${meSnapped.x},${meSnapped.y})`);
        return null;
    }

    // Delivery tiles, sorted by distance from the BDI — it's the one delivering.
    const deliveryCandidates = sortDeliveryTiles(filterAvoidedTiles(deliveryTiles()), bdiSnapped)
        .slice(0, MAX_HANDOFF_DELIVERY_TILES);

    if (deliveryCandidates.length === 0) {
        console.warn('[PDDL-HANDOFF] no delivery tiles available');
        return null;
    }

    console.log(
        `[PDDL-HANDOFF] llm=(${meSnapped.x},${meSnapped.y}) bdi=(${bdiSnapped.x},${bdiSnapped.y}) ` +
        `dropCandidates=${dropCandidates.length} deliveryCandidates=${deliveryCandidates.length}`
    );

    // ── Build locations ─────────────────────────────────────────────────────
    const locations = [
        { name: 'loc-llm', x: meSnapped.x, y: meSnapped.y },
        { name: 'loc-bdi', x: bdiSnapped.x, y: bdiSnapped.y },
    ];
    const locationMap = {
        'loc-llm': { x: meSnapped.x, y: meSnapped.y },
        'loc-bdi': { x: bdiSnapped.x, y: bdiSnapped.y },
    };

    dropCandidates.forEach((tile, i) => {
        const name = `loc-drop${i}`;
        locations.push({ name, x: tile.x, y: tile.y });
        locationMap[name] = { x: tile.x, y: tile.y, isDrop: true };
    });

    deliveryCandidates.forEach((tile, i) => {
        const name = `loc-d${i}`;
        locations.push({ name, x: tile.x, y: tile.y });
        locationMap[name] = { x: tile.x, y: tile.y, deliveryIndex: i, tile };
    });

    const parcelName = `p${parcelId}`;
    const parcelMap = { [parcelName]: parcel };

    // ── :objects ─────────────────────────────────────────────────────────────
    const locationNames = locations.map(l => l.name);
    const objects =
        `    ${locationNames.join(' ')} - location\n` +
        `    ${parcelName} - parcel`;

    // ── :init ────────────────────────────────────────────────────────────────
    const initLines = [
        '(at-llm loc-llm)',
        '(at-bdi loc-bdi)',
        `(carrying-llm ${parcelName})`,
    ];
    dropCandidates.forEach((_, i) => initLines.push(`(is-drop loc-drop${i})`));
    deliveryCandidates.forEach((_, i) => initLines.push(`(is-delivery loc-d${i})`));
    initLines.push(...initDistances(locations));
    initLines.push('(= (total-cost) 0)');

    // ── :goal ────────────────────────────────────────────────────────────────
    const goal = `(and (delivered ${parcelName}) (handed-off ${parcelName}))`;

    const problem = `(define (problem deliveroo-handoff-drop)
  (:domain deliveroo-handoff)
  (:objects
${objects})
  (:init
    ${initLines.join('\n    ')})
  (:goal ${goal})
  (:metric minimize (total-cost)))
`;

    return { problem, locationMap, parcelMap };
}
