# Super Mario

A Deliveroo agent implementation using the @unitn-asa/deliveroo-js-sdk.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure your environment variables in `.env`:
   - `HOST`: The host URL of the Deliveroo server (e.g., http://localhost:8080)
   - `TOKEN`: Your authentication token
   - `NAME`: Name of your agent

3. Run the agent:
   ```bash
   npm start
   ```

## What the Agent Does

The current `index.js` establishes a connection to the Deliveroo server and listens for 'sensing' events, which provide information about the map, other agents, parcels, and the agent's own position. It logs the agent's current position and the number of visible parcels to the console.

## Development

- Edit `index.js` to implement your agent logic (e.g., movement, parcel pickup/delivery).
