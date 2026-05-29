import { beliefs, isWalkable } from './beliefs.js';
import { aStar } from './astar.js';
import { manhattan } from './utils.js';

// tile key -> { visitCount, lastVisited (ms timestamp) }
const visited = new Map();
const key = (x, y) => `${x},${y}`;

// Call this once per sensing cycle to record where the agent is
export function markVisited(x, y) {
    const k = key(x, y);
    const prev = visited.get(k) ?? { visitCount: 0, lastVisited: 0 };
    visited.set(k, {
        visitCount: prev.visitCount + 1,
        lastVisited: Date.now(),
    });
}

// Frontier = walkable map tiles that have never been visited
function getFrontierTiles() {
    return beliefs.map.filter(t => {
        if (t.type !== '1') return false;
        if (!isWalkable(t.x, t.y, t.x, t.y)) return false; // tile itself must be walkable
        if (visited.has(key(t.x, t.y))) return false;

        // Must be reachable from at least one adjacent tile
        const neighbors = [
            [t.x, t.y - 1], // from above  (moving down into t)
            [t.x, t.y + 1], // from below  (moving up into t)
            [t.x - 1, t.y], // from left   (moving right into t)
            [t.x + 1, t.y], // from right  (moving left into t)
        ];

        return neighbors.some(([nx, ny]) => {
            // neighbor must exist and be walkable itself
            const neighborTile = beliefs.map.find(n => n.x === nx && n.y === ny);
            if (!neighborTile) return false;
            if (!isWalkable(nx, ny, nx, ny)) return false;
            // and you must be able to walk FROM neighbor INTO t
            return isWalkable(t.x, t.y, nx, ny);
        });
    });
}

// If the entire map is visited, reset the N least-recently visited tiles
// so the agent keeps exploring after full coverage
function resetOldestTiles(n = 20) {
    const sorted = [...visited.entries()]
        .sort(([, a], [, b]) => a.lastVisited - b.lastVisited)
        .slice(0, n);
    for (const [k] of sorted) visited.delete(k);
}

// Score a frontier tile: prefer recently-unvisited tiles that are close
function score(tile, me) {
    const dist = manhattan(me, tile) + 1;
    const age = Date.now() - (visited.get(key(tile.x, tile.y))?.lastVisited ?? 0);
    return age / dist; // higher = better
}

// In explorer.js — update these two functions to accept `me` as a parameter

export function getExploreTarget(me) {         // ← add me param
    let frontier = getFrontierTiles();

    if (frontier.length === 0) {
        resetOldestTiles(20);
        frontier = getFrontierTiles();
    }

    if (frontier.length === 0) return null;

    frontier.sort((a, b) => score(b, me) - score(a, me));
    return frontier[0];
}

export function explorePath(me) {             
    if (!me) return [];

    markVisited(me.x, me.y);

    const target = getExploreTarget(me);

    if (!target) return [];

    const path = aStar(me, target);

    if (path.length === 0) {
        const dirs = [
            [0, -1, 'up'], [0, 1, 'down'], [-1, 0, 'left'], [1, 0, 'right']
        ];
        const walkable = dirs.filter(([dx, dy]) =>
            isWalkable(me.x + dx, me.y + dy, me.x, me.y)
        );
        if (walkable.length > 0) {
            const [,, dir] = walkable[Math.floor(Math.random() * walkable.length)];
            return [dir];
        }
    }

    return path;
}