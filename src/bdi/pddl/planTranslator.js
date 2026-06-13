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
