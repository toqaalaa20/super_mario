import 'dotenv/config';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";

async function run() {
    const socket = await DjsConnect();
    console.log("🚀 Socket created!");

    socket.on('connect', () => {
        console.log("✅ Connected to server!");
    });

    socket.on('connect_error', (err) => {
        console.error("❌ Connection error:", err.message);
        // Don't exit — let it retry
    });

    socket.on('disconnect', (reason) => {
        console.log("⚠️ Disconnected:", reason);
    });

    socket.on('you', (me) => {
        console.log("🧍 Position:", me.x, me.y, "| Score:", me.score);
    });

    socket.on('map', (width, height, tiles) => {
        console.log("🗺️ Map:", width, "x", height);
    });

    socket.on('parcels sensing', (parcels) => {
        console.log("📦 Parcels nearby:", parcels.length);
    });

    socket.on('agents sensing', (agents) => {
        console.log("🤖 Agents nearby:", agents.length);
    });
}

run();