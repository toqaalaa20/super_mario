export function manhattan(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// BFS pathfinding — returns array of directions or null if no path
export function bfs(start, goal, mapGrid) {
    const queue = [[start, []]];
    const visited = new Set();
    visited.add(`${Math.round(start.x)},${Math.round(start.y)}`);

    while (queue.length > 0) {
        const [current, path] = queue.shift();
        const cx = Math.round(current.x);
        const cy = Math.round(current.y);

        if (cx === Math.round(goal.x) && cy === Math.round(goal.y)) return path;

        const neighbors = [
            { x: cx + 1, y: cy,     dir: 'right' },
            { x: cx - 1, y: cy,     dir: 'left'  },
            { x: cx,     y: cy + 1, dir: 'up'    },
            { x: cx,     y: cy - 1, dir: 'down'  },
        ];

        for (const n of neighbors) {
            const key = `${n.x},${n.y}`;
            const type = mapGrid.get(key);
            // walkable: type '1' (spawner), '2' (delivery), '3' (walkable), '4' (base)
            if (!visited.has(key) && type !== undefined && type !== '0') {
                visited.add(key);
                queue.push([{ x: n.x, y: n.y }, [...path, n.dir]]);
            }
        }
    }

    return null; // no path found
}