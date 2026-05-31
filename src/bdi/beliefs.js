export const beliefs = {
    me: null,
    map: [],                // full tile array, received once on connect
    parcels: new Map(),     // id -> { id, x, y, reward, carriedBy } — free parcels only
    carriedParcels: new Map(), // id -> { id, reward, ... } — parcels we hold, live reward from sensing
    agents: new Map(),      // id -> { id, name, x, y, score }
    carrying: [],           // parcel ids this agent is currently holding
};
let sensingTick = 0;
export function updateFromSensing({ parcels, agents }) {
    sensingTick++;

    for (const p of parcels ?? []) {
        if (p.carriedBy === beliefs.me?.id) { // we're carrying this parcel
            if (!beliefs.carrying.includes(p.id)) {
                beliefs.carrying.push(p.id);
            }
            beliefs.carriedParcels.set(p.id, p);
            beliefs.parcels.delete(p.id);
        } else if (!p.carriedBy) {
            if (p.reward > 0) {
                beliefs.parcels.set(p.id, { ...p, _lastSeen: sensingTick });
            } else {
                beliefs.parcels.delete(p.id);
            }
        } else {
            beliefs.parcels.delete(p.id);
        }
    }

    // Evict parcels not seen in the last tick — they left sensing range
    // or were picked up by someone else without an explicit update
    for (const [id, p] of beliefs.parcels) {
        if (p._lastSeen < sensingTick) {
            beliefs.parcels.delete(id);
        }
    }

    const seenAgentIds = new Set((agents ?? []).map(a => a.id));
    for (const id of beliefs.agents.keys()) {
        if (!seenAgentIds.has(id)) beliefs.agents.delete(id);
    }
    for (const a of agents ?? []) {
        beliefs.agents.set(a.id, a);
    }
}

export function setMap(tiles) {
    beliefs.map = tiles;
}

// Returns the sum of live (decaying) rewards for all parcels we're carrying
export function totalCarriedReward() {
    return beliefs.carrying.reduce((sum, id) => {
        const p = beliefs.carriedParcels.get(id);
        return sum + (p?.reward ?? 0);
    }, 0);
}

// Helpers used by other modules
export function isWalkable(x, y, fromX, fromY) {
    const tile = beliefs.map.find(t => t.x === x && t.y === y);
    if (!tile) return false;
    if (tile.type === '0') return false;

    const dx = x - fromX;
    const dy = y - fromY;
    if (tile.type === '←' && dx > 0) return false;
    if (tile.type === '→' && dx < 0) return false;
    if (tile.type === '↑' && dy < 0) return false;
    if (tile.type === '↓' && dy > 0) return false;

    // Treat other agents as obstacles
    for (const a of beliefs.agents.values()) {
        if (Math.round(a.x) === x && Math.round(a.y) === y) return false;
    }

    return true;
}

export function deliveryTiles() {
    return beliefs.map.filter((t) => t.delivery === true || t.type === '2');
}

export function freeParcels() {
    return [...beliefs.parcels.values()].filter((p) => !p.carriedBy);
}