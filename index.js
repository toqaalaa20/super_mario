import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import dotenv from 'dotenv';
dotenv.config();

const socket = new DjsConnect(
    process.env.DELIVEROO_HOST || 'http://localhost:8080',
    process.env.DELIVEROO_TOKEN
);

const beliefset = new Map();
const start = Date.now();

var OBSERVATION_DISTANCE;
socket.onConfig( config => OBSERVATION_DISTANCE = config.GAME.player.observation_distance );
var me;

socket.onYou( m => me = m );

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

socket.onSensing( ( sensing ) => {
    const timestamp = Date.now() - start;
    for ( let a of sensing.agents ) {
        if ( ! beliefset.has( a.id ) )
            beliefset.set( a.id, [] )
        const log = {
            id: a.id,
            name: a.name,
            x: a.x,
            y: a.y,
            score: a.score,
            timestamp: timestamp,
            direction: 'none'
        }
        const logs = beliefset.get( a.id );
        if ( logs && logs.length>0 ) {
            var previous = logs[logs.length-1];
            if ( previous.x < a.x ) log.direction = 'right';
            else if ( previous.x > a.x ) log.direction = 'left';
            else if ( previous.y < a.y ) log.direction = 'up';
            else if ( previous.y > a.y ) log.direction = 'down';
            else log.direction = 'none';
        }
        beliefset.get( a.id )?.push( log );
    }
    // compute if within perceiving area
    let prettyPrint = Array.from(beliefset.values()).map( (logs) => {
        const {timestamp,name,x,y,direction} = logs[logs.length-1]
        const d = dist( me, {x,y} );
        return `${name}(${direction},${d<OBSERVATION_DISTANCE})@${timestamp}:${x},${y}`;
    }).join(' ');
    console.log(prettyPrint)
} )
const dist = (a1,a2) => Math.abs(a1.x-a2.x) + Math.abs(a1.y-a2.y);