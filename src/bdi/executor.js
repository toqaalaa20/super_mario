import { beliefs, freeParcels, isWalkable } from './beliefs.js';
import { INTENTION } from './intentions.js';
import { aStar } from './astar.js';
import { explorePath, markVisited } from './explorer.js';

// Snap fractional coords to nearest integer (agent mid-step)
function snapPosition(me) {
    return { ...me, x: Math.round(me.x), y: Math.round(me.y) };
}

// Cached plan — reused across ticks until intention changes or a move fails
let cachedPath = [];
let cachedIntentionKey = null;
let lastExploreStep = null;

function intentionKey(intention) {
    return `${intention.type}:${intention.target?.id ?? intention.target?.x + ',' + intention.target?.y ?? 'null'}`;
}

function dirToDelta(dir) {
    return { up: [0,1], down: [0,-1], left: [-1,0], right: [1,0] }[dir];
}

function positionKey(pos) {
    return `${pos.x},${pos.y}`;
}

function nextPosition(me, dir) {
    const [dx, dy] = dirToDelta(dir);
    return { x: me.x + dx, y: me.y + dy };
}

function nonBacktrackingDirections(me, previousPositionKey) {
    return ['up', 'down', 'left', 'right'].filter(dir => {
        const next = nextPosition(me, dir);
        return positionKey(next) !== previousPositionKey &&
            isWalkable(next.x, next.y, me.x, me.y);
    });
}

function rememberMove(to) {
    Object.assign(beliefs.me, to);
}

function perpendiculars(dir) {
    const perp = { up: ['left','right'], down: ['left','right'],
                   left: ['up','down'],  right: ['up','down'] };
    // Shuffle so the agent doesn't always prefer the same side
    return perp[dir].sort(() => Math.random() - 0.5);
}

export async function executePlan(socket, intention) {
    const me = snapPosition(beliefs.me);
    if (!me || !intention) return;

    const key = intentionKey(intention);

    // Recompute path if intention changed or cache is empty
    if (key !== cachedIntentionKey || cachedPath.length === 0) {
        cachedIntentionKey = key;

        if (intention.type === INTENTION.PICKUP || intention.type === INTENTION.DELIVER) {
            cachedPath = aStar(me, intention.target);
        } else if (intention.type === INTENTION.EXPLORE) {
            cachedPath = explorePath(me);
        } else {
            cachedPath = [];
        }
    }

    if (intention.type !== INTENTION.EXPLORE) {
        lastExploreStep = null;
    }

    // --- EXPLORE: one step at a time, abort if a parcel appears ---
    if (intention.type === INTENTION.EXPLORE) {
        if (cachedPath.length === 0) return false;

        if (freeParcels().some(p => p.reward > 5)) {
            cachedPath = [];
            cachedIntentionKey = null;
            return false;
        }

        let dir = cachedPath.shift();

        if (
            lastExploreStep &&
            positionKey(me) === lastExploreStep.to &&
            positionKey(nextPosition(me, dir)) === lastExploreStep.from
        ) {
            const alternatives = nonBacktrackingDirections(me, lastExploreStep.from);
            if (alternatives.length > 0) {
                cachedPath = [];
                cachedIntentionKey = null;
                dir = alternatives[Math.floor(Math.random() * alternatives.length)];
            }
        }

        const from = positionKey(me);
        const to = positionKey(nextPosition(me, dir));
        const ok = await socket.emitMove(dir);
        if (!ok) {
            console.log(`[EXECUTOR] Blocked during ${intention.type}, attempting dodge`);
            cachedPath = [];
            cachedIntentionKey = null;
        
            // Try a random perpendicular move to get unstuck
            const perp = perpendiculars(dir);
            for (const d of perp) {
                const me = snapPosition(beliefs.me);
                const [dx, dy] = dirToDelta(d);
                if (isWalkable(me.x + dx, me.y + dy, me.x, me.y)) {
                    const dodgeFrom = positionKey(me);
                    const dodgeTo = positionKey(nextPosition(me, d));
                    const dodged = await socket.emitMove(d);
                    if (dodged) {
                        lastExploreStep = { from: dodgeFrom, to: dodgeTo };
                        rememberMove(nextPosition(me, d));
                    }
                    break;
                }
            }
            return false;
        }
        lastExploreStep = { from, to };
        rememberMove(nextPosition(me, dir));
        markVisited(nextPosition(me, dir).x, nextPosition(me, dir).y);
        return true;
    }

    // --- PICKUP / DELIVER: one move step per tick ---
    if (intention.type === INTENTION.PICKUP || intention.type === INTENTION.DELIVER) {
        if (cachedPath.length === 0) {
            // Already at target — perform the action
            if (intention.type === INTENTION.PICKUP) {
                const picked = await socket.emitPickup();
                return picked && picked.length > 0;
            }
            if (intention.type === INTENTION.DELIVER) {
                await socket.emitPutdown();
                beliefs.carrying = [];
                beliefs.carriedParcels.clear();
                return true;
            }
        }

        const dir = cachedPath.shift();
        const next = nextPosition(me, dir);
        const ok = await socket.emitMove(dir);
        if (!ok) {
            console.log(`[EXECUTOR] Blocked during ${intention.type}, attempting dodge`);
            cachedPath = [];
            cachedIntentionKey = null;
        
            // Try a random perpendicular move to get unstuck
            const perp = perpendiculars(dir);
            for (const d of perp) {
                const me = snapPosition(beliefs.me);
                const [dx, dy] = dirToDelta(d);
                if (isWalkable(me.x + dx, me.y + dy, me.x, me.y)) {
                    const dodged = await socket.emitMove(d);
                    if (dodged) rememberMove(nextPosition(me, d));
                    break;
                }
            }
            return false;
        }
        rememberMove(next);
        return true;
    }
}
