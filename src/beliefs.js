export const beliefs = {
    me: null,
    map: [], // full tile array, received once on connect
    parcels: new Map(), // id -> { id, x, y, reward, carriedBy }
    agents: new Map(), // id -> { id, name, x, y, score }
    carrying: [], // parcel ids this agent is currently holding
};

export function updateFromSensing({ me, parcels, agents }) {
    if (me) {
        beliefs.me = {
            ...me,
            x: Math.round(me.x),
            y: Math.round(me.y),
        };
        beliefs.carrying = me.carrying ?? [];
    }

    for (const p of parcels ?? []) {
        if (p.reward > 0) beliefs.parcels.set(p.id, p);
        else beliefs.parcels.delete(p.id); // parcel expired
    }

    for (const a of agents ?? []) {
        beliefs.agents.set(a.id, a);
    }

    console.log('beliefs.me', beliefs.me);
    console.log('beliefs.parcels', [...beliefs.parcels.values()]);
}

export function setMap(tiles) {
    beliefs.map = tiles;
}

// Helpers used by other modules
export function isWalkable(x, y, fromX, fromY) {
    const tile = beliefs.map.find(t => t.x === x && t.y === y);
    if (!tile) return false;
    if (tile.type === '0') return false;

    // Check one-way tiles
    const dx = x - fromX;
    const dy = y - fromY;
    if (tile.type === '←' && dx > 0) return false; // moving right into left-only tile
    if (tile.type === '→' && dx < 0) return false; // moving left into right-only tile
    if (tile.type === '↑' && dy < 0) return false; // moving down into up-only tile
    if (tile.type === '↓' && dy > 0) return false; // moving up into down-only tile

    return true;
}

export function deliveryTiles() {
    // type 2 is usually delivery in Deliveroo JS
    return beliefs.map.filter((t) => t.delivery === true || t.type === '2');
}

export function freeParcels() {
    return [...beliefs.parcels.values()].filter((p) => !p.carriedBy);
}