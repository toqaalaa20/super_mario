import { beliefs, freeParcels, deliveryTiles, totalCarriedReward } from './beliefs.js';
import { manhattan } from './utils.js';

export const INTENTION = {
    PICKUP: 'pickup',
    DELIVER: 'deliver',
    EXPLORE: 'explore',
};

let current = null;

export function getCurrentIntention() {
    return current;
}

export function reviseIntention() {
    const me = beliefs.me;
    if (!me) return;

    let nextIntention = null;

    if (beliefs.carrying.length > 0) {
        const nearestDelivery = deliveryTiles()
            .sort((a, b) => manhattan(me, a) - manhattan(me, b))[0];

        const carried = totalCarriedReward();

        const deliverScore = nearestDelivery
            ? carried / (manhattan(me, nearestDelivery) + 1)
            : 0;

        const bestPickup = freeParcels()
            .filter(p => p.reward > 5)
            .map(p => {
                const distToParcel = manhattan(me, p);
                const distToDelivery = nearestDelivery
                    ? manhattan(p, nearestDelivery)
                    : Infinity;

                // "On the way" bonus: if picking up this parcel doesn't increase
                // total travel distance much, it's almost free
                const directDist = nearestDelivery
                    ? manhattan(me, nearestDelivery)
                    : Infinity;
                const detour = (distToParcel + distToDelivery) - directDist;

                const score = (carried + p.reward) / (distToParcel + distToDelivery + 1);
                return { parcel: p, score, detour, distToParcel };
            })
            // Also grab parcels that are very close (≤3 tiles) regardless of score
            .filter(({ score, detour, distToParcel }) =>
                score > deliverScore
                || distToParcel <= 3        // nearby parcels are almost free to grab
                || detour <= 2             // on the way — tiny detour
            )
            .sort((a, b) => b.score - a.score)[0];

        if (bestPickup) {
            nextIntention = { type: INTENTION.PICKUP, target: bestPickup.parcel };
        } else if (nearestDelivery) {
            nextIntention = { type: INTENTION.DELIVER, target: nearestDelivery };
        }
    }

    // 2. Not carrying -> go for best visible free parcel
    if (!nextIntention) {
        const candidates = freeParcels()
            .filter(p => p.reward > 5)
            .sort((a, b) => {
                const sA = a.reward / (manhattan(me, a) + 1);
                const sB = b.reward / (manhattan(me, b) + 1);
                return sB - sA;
            });

        if (candidates.length > 0) {
            nextIntention = { type: INTENTION.PICKUP, target: candidates[0] };
        }
    }

    // 3. Nothing useful -> explore
    if (!nextIntention) {
        nextIntention = { type: INTENTION.EXPLORE, target: null };
    }

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
                : ''
        );
        current = nextIntention;
    }
}