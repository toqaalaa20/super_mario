export const beliefs = {
    me: null,
    map: [],          // full tile array, received once on connect
    parcels: new Map(), // id -> { id, x, y, reward, carriedBy }
    agents: new Map(),  // id -> { id, name, x, y, score }
    carrying: [],       // parcel ids this agent is currently holding
};

export function updateFromSensing({ me, parcels, agents }) {
    if (me) {
        beliefs.me = me;
        beliefs.carrying = me.carrying ?? [];
    }
    for (const p of parcels ?? []) {
        if (p.reward > 0) beliefs.parcels.set(p.id, p);
        else beliefs.parcels.delete(p.id); // parcel expired
    }
    for (const a of agents ?? []) beliefs.agents.set(a.id, a);
}

export function setMap(tiles) {
    beliefs.map = tiles;
}

// Helpers used by other modules
export function isWalkable(x, y) {
    return beliefs.map.some(t => t.x === x && t.y === y && t.type !== '0');
}

export function deliveryTiles() {
    return beliefs.map.filter(t => t.type === '2');
}

export function spawnerTiles() {
    return beliefs.map.filter(t => t.type === '1');
}

export function freeParcels() {
    return [...beliefs.parcels.values()].filter(p => !p.carriedBy);
}