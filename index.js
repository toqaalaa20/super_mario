import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import dotenv from 'dotenv';
dotenv.config();

const socket = new DjsConnect(
    process.env.DELIVEROO_HOST || 'http://localhost:8080',
    process.env.DELIVEROO_TOKEN
);

let myPosition = { x: 0, y: 0 };

socket.on('you', (id, name, x, y) => {
    myPosition = { x, y };
});

socket.on('map', async (width, height, tiles) => {
    // Move along predefined path
    const path = ['right', 'right', 'down', 'down', 'left', 'left', 'up', 'up'];

    for (const direction of path) {
        const result = await socket.emitMove(direction);
        if (!result) {
            console.log(`Move ${direction} failed, retrying...`);
            await new Promise(r => setTimeout(r, 100));
        }
    }

    // Pickup parcels
    await socket.emitPickup();
});