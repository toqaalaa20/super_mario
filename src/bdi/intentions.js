// intentions.js
import { beliefs, freeParcels, deliveryTiles, totalCarriedReward } from './beliefs.js';
import { manhattan } from './utils.js';

export const INTENTION = {
    PICKUP: 'pickup',
    DELIVER: 'deliver',
    EXPLORE: 'explore',
    MEETUP: 'meetup',
    WAIT: 'wait',
};

let current = null;
let pickupAndDeliverStuckTicks = 0;

export function getCurrentIntention() { return current; }

// ─── Mission state (written by llm_agent.js) ──────────────────────────────────
export const missionState = {
    active: false,
    type: null,    // 'STACK_SIZE' | 'PREFERRED_DELIVERY' | 'AVOID_TILE' | 'SCORE_FILTER' | 'MOVE_TO_POSITION'
    params: {},
    description: '',
};

export function setMissionState(state) {
    Object.assign(missionState, state);
    console.log('[INTENTION] Mission state updated:', missionState);
}

// Reset module-level state — used by tests to isolate cases
export function resetState() {
    current = null;
    pickupAndDeliverStuckTicks = 0;
    Object.assign(missionState, { active: false, type: null, params: {}, description: '' });
}

// ─── Mission-aware helpers ─────────────────────────────────────────────────────

/** True if any other known agent is within radius of (x,y) */
function partnerNearby(x, y, radius) {
    for (const a of beliefs.agents.values()) {
        if (manhattan(a, { x, y }) <= radius) return true;
    }
    return false;
}

/** True if (x,y) is the tile an active AVOID_TILE mission says to avoid */
function isAvoidedTile(x, y) {
    if (missionState.active && missionState.type === 'AVOID_TILE') {
        return missionState.params.x === x && missionState.params.y === y;
    }
    return false;
}

/** Apply SCORE_FILTER: skip parcels whose reward exceeds the cap */
function parcelAllowed(parcel) {
    if (missionState.active && missionState.type === 'SCORE_FILTER') {
        if (parcel.reward > (missionState.params.maxReward ?? Infinity)) return false;
    }
    if (isAvoidedTile(parcel.x, parcel.y)) return false;
    return true;
}

/** Filter out delivery tiles that fall on an avoided tile */
function filterAvoidedTiles(tiles) {
    if (missionState.active && missionState.type === 'AVOID_TILE') {
        return tiles.filter(t => !isAvoidedTile(t.x, t.y));
    }
    return tiles;
}

/** Apply PREFERRED_DELIVERY: sort preferred tiles first */
function sortDeliveryTiles(tiles, me) {
    if (missionState.active && missionState.type === 'PREFERRED_DELIVERY') {
        const preferred = missionState.params.tiles ?? [];
        return tiles.sort((a, b) => {
            const aPreferred = preferred.some(p => p.x === a.x && p.y === a.y) ? 0 : 1;
            const bPreferred = preferred.some(p => p.x === b.x && p.y === b.y) ? 0 : 1;
            if (aPreferred !== bPreferred) return aPreferred - bPreferred;
            return manhattan(me, a) - manhattan(me, b);
        });
    }
    return tiles.sort((a, b) => manhattan(me, a) - manhattan(me, b));
}

/**
 * Apply STACK_SIZE: only deliver when carrying exactly `size` parcels.
 * Returns true if we should deliver now, false if we should keep collecting.
 */
function shouldDeliver(me, nearestDelivery) {
    if (missionState.active && missionState.type === 'STACK_SIZE') {
        const required = missionState.params.size ?? 1;
        const ready = beliefs.carrying.length >= required;
        console.log(`[STACK_SIZE] carrying=${beliefs.carrying.length}/${required} → ${ready ? 'DELIVER' : 'HOLD'}`);
        return ready;
    }
    return true; // default: deliver whenever it's profitable
}

// ─── Main intention revision ───────────────────────────────────────────────────

export function reviseIntention() {
    const me = beliefs.me;
    if (!me) return;

    // Remove filtered parcels from beliefs so freeParcels() callers all see the same set
    // and the agent explores instead of idling near disallowed parcels.
    if (missionState.active && (missionState.type === 'SCORE_FILTER' || missionState.type === 'AVOID_TILE')) {
        for (const [id, p] of beliefs.parcels) {
            if (!parcelAllowed(p)) {
                console.log(`[AVOID_TILE/SCORE_FILTER] dropping parcel ${id} at (${p.x},${p.y})`);
                beliefs.parcels.delete(id);
            }
        }
    }

    if (missionState.active && missionState.type === 'AVOID_TILE') {
        const { x, y } = missionState.params;
        const remainingDelivery = filterAvoidedTiles(deliveryTiles());
        console.log(
            `[AVOID_TILE] avoiding (${x},${y}) — ` +
            `${remainingDelivery.length}/${deliveryTiles().length} delivery tiles remain, ` +
            `${freeParcels().filter(parcelAllowed).length}/${freeParcels().length} free parcels remain`
        );
    }

    // ── 0. Level 3 mission overrides ─────────────────────────────────────────
    if (missionState.active) {
        if (missionState.type === 'COORDINATE_MEETUP') {
            const { x, y, radius = 3 } = missionState.params;
            if (manhattan(me, { x, y }) <= radius) {
                // Within radius — freeze and wait for the LLM to confirm both agents
                // have met and call clear_mission_on_bdi(). Don't auto-clear here:
                // that would let the BDI wander off again before the LLM verifies.
                const changed = !current || current.type !== INTENTION.WAIT;
                if (changed) {
                    console.log(`[MISSION] COORDINATE_MEETUP: reached (${x},${y}) within radius ${radius} — waiting for LLM confirmation`);
                    current = { type: INTENTION.WAIT, target: { x, y } };
                }
            } else {
                const changed = !current || current.type !== INTENTION.MEETUP
                    || current.target?.x !== x || current.target?.y !== y;
                if (changed) current = { type: INTENTION.MEETUP, target: { x, y, radius } };
            }
            return;
        }

        if (missionState.type === 'PICKUP_AND_DELIVER') {
            const { parcelId, x, y } = missionState.params;
            if (beliefs.carrying.includes(parcelId)) {
                // Holding the handoff parcel — clear mission, fall through to normal DELIVER
                setMissionState({ active: false, type: null, params: {}, description: '' });
                pickupAndDeliverStuckTicks = 0;
            } else if (!beliefs.parcels.has(parcelId) && manhattan(me, { x, y }) === 0) {
                // At the drop point but the parcel isn't there (e.g. it was put down
                // on a delivery tile and auto-delivered already). Give up after a few
                // ticks instead of waiting forever for a parcel that's never coming.
                pickupAndDeliverStuckTicks++;
                if (pickupAndDeliverStuckTicks >= 3) {
                    console.log(`[PICKUP_AND_DELIVER] parcel ${parcelId} not found at (${x},${y}) — giving up on handoff`);
                    setMissionState({ active: false, type: null, params: {}, description: '' });
                    pickupAndDeliverStuckTicks = 0;
                } else {
                    current = { type: INTENTION.WAIT, target: null };
                    return;
                }
            } else {
                // Not yet carrying — navigate to drop point and pick it up
                pickupAndDeliverStuckTicks = 0;
                const parcel = beliefs.parcels.get(parcelId) ?? { id: parcelId, x, y };
                const changed = !current || current.type !== INTENTION.PICKUP
                    || current.target?.id !== parcelId;
                if (changed) current = { type: INTENTION.PICKUP, target: parcel };
                return;
            }
        }

        if (missionState.type === 'WAIT_FOR_SIGNAL') {
            const frozen = missionState.params.frozen !== false;
            if (frozen) {
                if (me.y % 2 !== 0) {
                    current = { type: INTENTION.WAIT, target: null };
                    return;
                }
                const ty = me.y + 1;
                const changed = !current || current.type !== INTENTION.MEETUP
                    || current.target?.x !== me.x || current.target?.y !== ty;
                if (changed) current = { type: INTENTION.MEETUP, target: { x: me.x, y: ty, radius: 0 } };
                return;
            }
            // frozen === false: green light received — clear mission and fall through
            setMissionState({ active: false, type: null, params: {}, description: '' });
        }

        if (missionState.type === 'MOVE_TO_POSITION') {
            const { x, y, reward } = missionState.params;
            if (manhattan(me, { x, y }) === 0) {
                console.log(`[MISSION] MOVE_TO_POSITION: reached (${x},${y}), earned +${reward}pts`);
                setMissionState({ active: false, type: null, params: {}, description: '' });
            } else {
                const changed = !current || current.type !== INTENTION.MEETUP
                    || current.target?.x !== x || current.target?.y !== y;
                if (changed) current = { type: INTENTION.MEETUP, target: { x, y, radius: 0 } };
                return;
            }
        }
    }

    let nextIntention = null;

    // ── 1. Carrying parcels ──────────────────────────────────────────────────
    if (beliefs.carrying.length > 0) {
        const allDelivery = filterAvoidedTiles(deliveryTiles());
        const sortedDelivery = sortDeliveryTiles(allDelivery, me);
        const nearestDelivery = sortedDelivery[0];
        const carried = totalCarriedReward();

        const readyToDeliver = shouldDeliver(me, nearestDelivery);

        if (readyToDeliver) {
            const deliverScore = nearestDelivery
                ? carried / (manhattan(me, nearestDelivery) + 1)
                : 0;

            // Consider diverting to pick up more parcels (only if not in STACK_SIZE mode
            // or we haven't reached the required stack yet)
            const canDivert = !missionState.active || missionState.type !== 'STACK_SIZE'
                || beliefs.carrying.length < (missionState.params.size ?? 1);

            const bestPickup = canDivert
                ? freeParcels()
                    .filter(p => p.reward > 5 && parcelAllowed(p))
                    .map(p => {
                        const distToParcel = manhattan(me, p);
                        const distToDelivery = nearestDelivery
                            ? manhattan(p, nearestDelivery) : Infinity;
                        const directDist = nearestDelivery
                            ? manhattan(me, nearestDelivery) : Infinity;
                        const detour = (distToParcel + distToDelivery) - directDist;
                        const score = (carried + p.reward) / (distToParcel + distToDelivery + 1);
                        return { parcel: p, score, detour, distToParcel };
                    })
                    .filter(({ score, detour, distToParcel }) =>
                        score > deliverScore ||
                        distToParcel <= 3 ||
                        detour <= 2
                    )
                    .sort((a, b) => b.score - a.score)[0]
                : null;

            if (bestPickup) {
                nextIntention = { type: INTENTION.PICKUP, target: bestPickup.parcel };
            } else if (nearestDelivery) {
                nextIntention = { type: INTENTION.DELIVER, target: nearestDelivery };
            }
        } else {
            // STACK_SIZE: not enough parcels yet — go collect more first.
            // Don't fall back to delivering an incomplete stack; explore until
            // enough parcels are found so deliveries always happen in exact batches.
            const candidates = freeParcels()
                .filter(parcelAllowed)
                .sort((a, b) => {
                    const sA = a.reward / (manhattan(me, a) + 1);
                    const sB = b.reward / (manhattan(me, b) + 1);
                    return sB - sA;
                });
            if (candidates.length > 0) {
                nextIntention = { type: INTENTION.PICKUP, target: candidates[0] };
            } else {
                nextIntention = { type: INTENTION.EXPLORE, target: null };
            }
        }
    }

    // ── 2. Not carrying — pick up best visible parcel ────────────────────────
    if (!nextIntention) {
        const candidates = freeParcels()
            .filter(p => p.reward > 5 && parcelAllowed(p))
            .sort((a, b) => {
                const sA = a.reward / (manhattan(me, a) + 1);
                const sB = b.reward / (manhattan(me, b) + 1);
                return sB - sA;
            });

        if (candidates.length > 0) {
            nextIntention = { type: INTENTION.PICKUP, target: candidates[0] };
        }
    }

    // ── 3. Nothing useful — explore ──────────────────────────────────────────
    if (!nextIntention) {
        nextIntention = { type: INTENTION.EXPLORE, target: null };
    }

    // ── Commit only if something changed ────────────────────────────────────
    const changed =
        !current ||
        current.type !== nextIntention.type ||
        current.target?.id !== nextIntention.target?.id ||
        current.target?.x !== nextIntention.target?.x ||
        current.target?.y !== nextIntention.target?.y;

    if (changed) {
        console.log(
            `[INTENTION] ${current?.type || 'NONE'} -> ${nextIntention.type}`,
            nextIntention.target
                ? `(target: ${nextIntention.target.x},${nextIntention.target.y})`
                : '',
            missionState.active ? `[MISSION: ${missionState.description}]` : '',
        );
        current = nextIntention;
    }
}