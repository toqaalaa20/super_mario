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

        // Live reward sum — decays each tick as sensing updates carriedParcels
        const carried = totalCarriedReward();

        // Score for delivering now: what we have / steps to delivery
        const deliverScore = nearestDelivery
            ? carried / (manhattan(me, nearestDelivery) + 1)
            : 0;

        // Score for diverting: (carried + new parcel) / (steps to parcel + steps to delivery)
        const bestPickup = freeParcels()
            .filter(p => p.reward > 5)
            .map(p => {
                const distToParcel = manhattan(me, p);
                const distToDelivery = nearestDelivery
                    ? manhattan(p, nearestDelivery)
                    : Infinity;
                const score = (carried + p.reward) / (distToParcel + distToDelivery + 1);
                return { parcel: p, score };
            })
            .sort((a, b) => b.score - a.score)[0];

        // Divert only if combined score is clearly better (1.5x threshold avoids thrashing)
        if (bestPickup && bestPickup.score > deliverScore * 1.5) {
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