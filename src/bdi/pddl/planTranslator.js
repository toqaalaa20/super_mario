// planTranslator.js
// Converts a solved PDDL action sequence (move/pickup/deliver over abstract
// `loc-*` waypoints) into an ordered queue of BDI intentions. `move` actions
// are dropped — A* already paths between whatever target the next intention
// carries.
import { INTENTION } from '../intentions.js';

/**
 * @param {string[]} planActions  e.g. ["move loc-agent loc-p3", "pickup p3 loc-p3", ...]
 * @param {{ locationMap: object, parcelMap: object }} maps
 * @returns {Array<{ type: string, target: object }>}
 */
export function translatePlan(planActions, { parcelMap, locationMap }) {
    const intentions = [];

    for (const action of planActions) {
        const [name, ...params] = action.split(/\s+/);

        if (name === 'pickup') {
            const [parcelName] = params;
            const parcel = parcelMap[parcelName];
            if (parcel) intentions.push({ type: INTENTION.PICKUP, target: parcel });
        } else if (name === 'deliver') {
            const [, locName] = params;
            const loc = locationMap[locName];
            if (loc?.tile) intentions.push({ type: INTENTION.DELIVER, target: loc.tile });
        }
        // 'move' actions are intentionally ignored.
    }

    return intentions;
}

/**
 * Extract the chosen drop point from a solved PARCEL_HANDOFF drop-point plan
 * (produced by buildHandoffDropProblem / domain_handoff.pddl).
 *
 * @param {string[]} planActions  e.g. ["move-llm loc-llm loc-drop1", "handoff-drop p7 loc-drop1", "move-bdi loc-bdi loc-drop1", "bdi-pickup p7 loc-drop1", "move-bdi loc-drop1 loc-d0", "bdi-deliver p7 loc-d0"]
 * @param {{ locationMap: object }} maps
 * @returns {{x:number, y:number} | null}
 */
export function extractHandoffDrop(planActions, { locationMap }) {
    for (const action of planActions) {
        const [name, , locName] = action.split(/\s+/);
        if (name === 'handoff-drop') {
            const loc = locationMap[locName];
            if (loc) return { x: loc.x, y: loc.y };
        }
    }
    return null;
}

/**
 * Translate a COORDINATE_MEETUP plan.
 *
 * The PDDL plan may include pickup/deliver steps for parcels collected en route
 * to the meetup point. Those are extracted normally. A final MEETUP intention
 * pointing at `meetupTile` is appended so the agent navigates to the rendezvous
 * after delivering any on-the-way parcels.
 *
 * @param {string[]} planActions
 * @param {{ locationMap: object, parcelMap: object }} maps
 * @param {{ x: number, y: number }} meetupTile  the resolved tile within the radius
 * @returns {Array<{ type: string, target: object }>}
 */
export function translateMeetupPlan(planActions, { parcelMap, locationMap }, meetupTile) {
    const intentions = translatePlan(planActions, { parcelMap, locationMap });

    // Append the meetup navigation as the final step
    if (meetupTile) {
        intentions.push({
            type: INTENTION.MEETUP,
            target: { x: meetupTile.x, y: meetupTile.y, radius: 0 },
        });
    }

    return intentions;
}
