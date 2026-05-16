// src/executor.js
import { beliefs } from './beliefs.js';
import { INTENTION } from './intentions.js';
import { aStar } from './astar.js';

export async function executePlan(socket, intention) {
    const me = beliefs.me;
    if (!me || !intention) return;

    if (intention.type === INTENTION.PICKUP) {
        const path = aStar(me, intention.target);
        for (const dir of path) {
            const ok = await socket.emitMove(dir);
            if (!ok) return false; // Path blocked or move failed
        }
        // Arrived at target
        const picked = await socket.emitPickup();
        return picked && picked.length > 0;
    }

    if (intention.type === INTENTION.DELIVER) {
        const path = aStar(me, intention.target);
        for (const dir of path) {
            const ok = await socket.emitMove(dir);
            if (!ok) return false;
        }
        // Arrived at target
        await socket.emitPutdown();
        return true;
    }

    if (intention.type === INTENTION.EXPLORE) {
        const dirs = ['up', 'down', 'left', 'right'];
        const randomDir = dirs[Math.floor(Math.random() * 4)];
        await socket.emitMove(randomDir);
        return true;
    }
}