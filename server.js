import { createServer } from 'node:http';
import { PORT } from './src/config.js';
import { createHttpHandler } from './src/httpHandler.js';
import { createWsServer } from './src/wsHandler.js';

let websocketAccepting = true;
const getAccepting = () => websocketAccepting;
const setAccepting = (v) => { websocketAccepting = v; };

const httpServer = createServer();
const wss        = createWsServer(httpServer, getAccepting);

httpServer.on('request', createHttpHandler({ wss, getAccepting, setAccepting }));

httpServer.listen(PORT, () => {
  console.log(`HTTP:      http://localhost:${PORT}/`);
  console.log(`POST:      http://localhost:${PORT}/post`);
  console.log(`WebSocket: ws://localhost:${PORT}/?username=...&password=...`);
});
