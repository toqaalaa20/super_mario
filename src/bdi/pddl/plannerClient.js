// plannerClient.js
// Talks to a hosted Planning-as-a-Service (PaaS) instance — the same backend
// used by editor.planning.domains / paas-uom.org — to solve a PDDL
// domain+problem pair. Returns null on any failure/timeout so callers can
// fall back to greedy intention selection.
const SOLVER_URL = process.env.PDDL_SOLVER_URL || 'https://solver.planning.domains:5001';
const PLANNER = process.env.PDDL_PLANNER || 'lama-first';

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 8000;

/**
 * @param {string} domain  PDDL domain text
 * @param {string} problem PDDL problem text
 * @returns {Promise<{ plan: string[] } | null>}
 */
export async function solve(domain, problem) {
    try {
        const submitRes = await fetch(`${SOLVER_URL}/package/${PLANNER}/solve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain, problem }),
        });

        if (!submitRes.ok) {
            console.warn(`[PDDL] solve request failed: HTTP ${submitRes.status}`);
            return null;
        }

        const submitData = await submitRes.json();

        // Some deployments answer synchronously with the result inline.
        let resultData = extractResult(submitData);
        if (resultData) return parsePlan(resultData);

        // Otherwise `result` is a path to poll for the async job result.
        const pollPath = typeof submitData.result === 'string' ? submitData.result : null;
        if (!pollPath) {
            console.warn('[PDDL] unexpected solve response shape:', JSON.stringify(submitData).slice(0, 200));
            return null;
        }

        const pollUrl = pollPath.startsWith('http') ? pollPath : `${SOLVER_URL}${pollPath}`;
        const deadline = Date.now() + POLL_TIMEOUT_MS;

        while (Date.now() < deadline) {
            await sleep(POLL_INTERVAL_MS);
            const pollRes = await fetch(pollUrl);
            if (!pollRes.ok) {
                console.warn(`[PDDL] poll request failed: HTTP ${pollRes.status}`);
                return null;
            }
            const pollData = await pollRes.json();
            if (pollData.status === 'PENDING') continue;

            resultData = extractResult(pollData);
            if (!resultData) continue; // job still pending, no result yet
            return parsePlan(resultData);
        }

        console.warn('[PDDL] solver poll timed out');
        return null;
    } catch (err) {
        console.warn('[PDDL] solver request error:', err.message);
        return null;
    }
}

function extractResult(data) {
    const result = data?.result;
    if (!result || typeof result === 'string') return null;
    return result;
}

function parsePlan(result) {
    const planText =
        result.output?.plan ??
        result.plan ??
        result.output?.sas_plan ??
        '';

    if (!planText) return { plan: [] };

    const actions = [];
    const actionRegex = /\(([a-zA-Z0-9_\- ]+)\)/g;
    for (const line of planText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(';')) continue;
        let match;
        while ((match = actionRegex.exec(trimmed)) !== null) {
            actions.push(match[1].trim().toLowerCase());
        }
    }
    return { plan: actions };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
