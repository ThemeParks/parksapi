import {server as httpServer} from './server.js';
import {Server as SocketServer} from "socket.io";

const maxMessagesToKeep = 100;

const getCircularReplacer = () => {
  const seen = new WeakSet()
  return (key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return
      }
      seen.add(value)
    }
    return value
  }
}

const io = new SocketServer(httpServer, {
  allowEIO3: true,
  cors: {
    origin: ['http://localhost:3000'],
    credentials: true,
  }
});

const sockets = [];
const messageHistory = [];
io.on('connection', (socket) => {
  sockets.push(socket);

  messageHistory.forEach((msg) => {
    socket.emit('livedata', msg);
  });

  socket.on('disconnect', () => {
    sockets.splice(sockets.indexOf(socket), 1);
  });
});

let counter = 0;
let lastTimestamp = 0;
export function sendMessage(msg) {
  while (messageHistory.length > maxMessagesToKeep) {
    messageHistory.shift();
  }
  const messageTime = +new Date();
  if (messageTime === lastTimestamp) {
    counter++;
  } else {
    counter = 0;
    lastTimestamp = messageTime;
  }

  const msgCopy = {
    data: JSON.stringify(msg, getCircularReplacer()),
    time: (messageTime * 100) + counter,
  };

  messageHistory.push(msgCopy);
  sockets.forEach((socket) => {
    socket.emit('livedata', msgCopy);
  });
}
