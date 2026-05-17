// src/executor.js
import { beliefs, freeParcels } from './beliefs.js';
import { INTENTION } from './intentions.js';
import { aStar } from './astar.js';
import { explorePath, markVisited } from './explorer.js';

// Snap fractional coords to nearest integer (agent mid-step)
function snapPosition(me) {
    return { ...me, x: Math.round(me.x), y: Math.round(me.y) };
}

export async function executePlan(socket, intention) {
    let me = snapPosition(beliefs.me);
    if (!me || !intention) return;

    if (intention.type === INTENTION.PICKUP) {
        const path = aStar(me, intention.target);
        for (const dir of path) {
            const ok = await socket.emitMove(dir);
            if (!ok) return false;
        }
        const picked = await socket.emitPickup();
        return picked && picked.length > 0;
    }

    if (intention.type === INTENTION.DELIVER) {
        const path = aStar(me, intention.target);
        for (const dir of path) {
            const ok = await socket.emitMove(dir);
            if (!ok) return false;
        }
        await socket.emitPutdown();
        beliefs.carrying = []; // Clear carrying list after delivery
        return true;
    }

    if (intention.type === INTENTION.EXPLORE) {
        const path = explorePath(me); // pass snapped position
        if (path.length === 0) return false;

        // Walk the entire computed path without recomputing mid-way
        for (const dir of path) {
            if (freeParcels().some(p => p.reward > 5)) return false;
            const ok = await socket.emitMove(dir);
            if (!ok) return false;
            markVisited(Math.round(beliefs.me.x), Math.round(beliefs.me.y));
        }
        return true;
    }
}