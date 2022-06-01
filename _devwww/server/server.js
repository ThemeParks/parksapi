import express from 'express';
export const app = express();

import http from 'http';
export const server = http.createServer(app);

export default server;
