// src/astar.js
import { isWalkable } from './beliefs.js';

const key = (x, y) => `${x},${y}`;
const h = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export function aStar(from, to) {
    const open = [{ x: from.x, y: from.y, g: 0, f: h(from, to), parent: null }];
    const closed = new Set();

    while (open.length) {
        // Sort by lowest f-cost
        open.sort((a, b) => a.f - b.f);
        const node = open.shift();
        const k = key(node.x, node.y);

        if (closed.has(k)) continue;
        closed.add(k);

        // Target reached
        if (node.x === to.x && node.y === to.y) return buildPath(node);

        // Explore neighbors
        for (const [dx, dy, dir] of [
            [0, 1, 'up'], [0, -1, 'down'], [-1, 0, 'left'], [1, 0, 'right']
        ]) {
            const nx = node.x + dx;
            const ny = node.y + dy;

            // Check map boundaries and walkability (including one-way tiles)
            if (!isWalkable(nx, ny, node.x, node.y) || closed.has(key(nx, ny))) {
                continue;
            }

            const g = node.g + 1;
            open.push({
                x: nx,
                y: ny,
                g,
                f: g + h({ x: nx, y: ny }, to),
                parent: node,
                dir
            });
        }
    }
    return []; // No path found
}

function buildPath(node) {
    const path = [];
    let n = node;
    while (n.parent) {
        path.unshift(n.dir);
        n = n.parent;
    }
    return path;
}