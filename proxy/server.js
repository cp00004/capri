// Simple Express proxy that forwards Capri API requests and adds CORS headers
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();
const TARGET = 'https://capricorn.de.deplexo.com';

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://cp00004.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Capri-Profile');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use('/', createProxyMiddleware({ target: TARGET, changeOrigin: true, secure: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Capri API proxy listening on ${PORT}`));
