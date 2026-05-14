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
const me = {id: '', name: '', x: -1, y: -1, score: 0};
const parcels = new Map();
socket.onConfig( config => OBSERVATION_DISTANCE = config.GAME.player.observation_distance );

socket.onYou( ( {id, name, x, y, score} ) => {
    me.id = id;
    me.name = name;
    me.x = x ? x : me.x;
    me.y = y ? y : me.y;
    me.score = score;
})

socket.onSensing(async ( sensing ) => {
    for ( let p of sensing.parcels ) {
        parcels.set(`${p.x},${p.y}`, p);
    }
});

function distance({x: x1, y: y1}, {x: x2, y: y2}) {
    const dx = Math.abs( Math.round(x1) - Math.round(x2) )
    const dy = Math.abs( Math.round(y1) - Math.round(y2) )
    return dx + dy;
}

async function blindMove(target){
    console.log(`${me.name} moving from ${me.x}, ${me.y} towards ${target.x},${target.y}`);

    var m = new Promise( res => socket.onYou( m => m.x % 1 != 0 || m.y % 1 != 0 ? null : res() ) );

    if ( me.x < target.x )
        await socket.emitMove('right');
    else if ( me.x > target.x )
        await socket.emitMove('left');
    
    if ( me.y < target.y )
        await socket.emitMove('up');
    else if ( me.y > target.y )
        await socket.emitMove('down');

    await m;
}

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

while (true) {

    await new Promise(res => setTimeout( res, 100 ));

    if ( ! me.id || ! parcels.size )
        continue;

    console.log( `me(${me.x},${me.y})`,
        Array.from( parcels.values() )
        .map( p => `${p.reward}@(${p.x},${p.y})` )
        .join( ' ' )
    );

    // get nearest parcel
    const nearest = Array.from(parcels.values())
    .filter( p => ! p.carriedBy )
    .sort( (a, b) => {
        const d1 = distance( me, a );
        const d2 = distance( me, b );
        return d1 - d2;
    } ).shift();

    // if no parcels are available
    if (!nearest) {
        console.log( 'no parcels' );
        continue;
    }
    
    // else move to nearest parcel
    console.log( 'nearest', nearest.id, nearest.x, nearest.y );
    
    await blindMove(nearest)
    console.log( 'moved to parcel', nearest.id, me.x, me.y );
    
    await socket.emitPickup();
    
    console.log( 'picked up' );
}