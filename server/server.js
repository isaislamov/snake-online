import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8080);
const WORLD = 5200;
const CENTER = WORLD / 2;
const RADIUS = CENTER - 45;
const SPEED = 125;
const TICK_RATE = 30;
const BOT_COUNT = 4;
const players = new Map();
const GAME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mp3': 'audio/mpeg' };

const server = http.createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(GAME_DIR, relative);
  if (!filePath.startsWith(GAME_DIR + path.sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const file = await readFile(filePath);
    response.setHeader('Content-Type', contentTypes[path.extname(filePath)] || 'application/octet-stream');
    if (['.html', '.js', '.css'].includes(path.extname(filePath))) response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.end(file);
  } catch {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ online: true, players: players.size }));
  }
});

const sockets = new WebSocketServer({ server });
const randomColor = () => `hsl(${Math.floor(Math.random() * 360)} 78% 56%)`;
const cleanName = value => String(value || 'Анаконда').trim().slice(0, 20) || 'Анаконда';
const cleanColor = value => /^#[0-9a-f]{6}$/i.test(value) ? value : randomColor();

function spawnPoint() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * (RADIUS - 350);
    const point = { x: CENTER + Math.cos(angle) * radius, y: CENTER + Math.sin(angle) * radius };
    if ([...players.values()].filter(player => player.alive).every(player => Math.hypot(player.x - point.x, player.y - point.y) > 420)) return point;
  }
  return { x: CENTER, y: CENTER };
}

function createBot(index) {
  const point = spawnPoint();
  const angle = Math.random() * Math.PI * 2;
  const id = `bot-${index}`;
  players.set(id, {
    id,
    name: ['Змей Горыныч', 'Шустрый пельмень', 'Дядя Удав', 'Лютый огурец'][index],
    color: randomColor(),
    isBot: true,
    x: point.x,
    y: point.y,
    angle,
    targetAngle: angle,
    score: 75 + Math.floor(Math.random() * 200),
    boost: false,
    alive: true,
    shieldUntil: Date.now() + 3000,
    trail: Array.from({ length: 110 }, (_, trailIndex) => ({
      x: point.x - Math.cos(angle) * trailIndex * 4,
      y: point.y - Math.sin(angle) * trailIndex * 4
    })),
    aiClock: 0,
    lastSeen: Date.now()
  });
}

for (let index = 0; index < BOT_COUNT; index++) createBot(index);

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    x: Math.round(player.x * 10) / 10,
    y: Math.round(player.y * 10) / 10,
    angle: player.angle,
    score: player.score,
    boost: player.boost,
    alive: player.alive,
    isBot: Boolean(player.isBot),
    skin: player.skin || ''
  };
}

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const socket of sockets.clients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  }
}

sockets.on('connection', socket => {
  const id = crypto.randomUUID();
  socket.playerId = id;
  send(socket, { type: 'welcome', id, world: { size: WORLD, radius: RADIUS } });

  socket.on('message', raw => {
    if (raw.length > 1024) return;
    let message;
    try { message = JSON.parse(raw); } catch { return; }

    if (message.type === 'join' && !players.has(id)) {
      const point = spawnPoint();
      players.set(id, {
        id,
        name: cleanName(message.name),
        color: cleanColor(message.color),
        x: point.x,
        y: point.y,
        angle: Math.random() * Math.PI * 2,
        targetAngle: 0,
        score: 0,
        boost: false,
        alive: true,
        shieldUntil: Date.now() + 3000,
        isBot: false,
        skin: ['spider', 'batman', 'hulk', 'thor', 'gold'].includes(message.skin) ? message.skin : '',
        trail: Array.from({ length: 80 }, (_, index) => ({
          x: point.x - Math.cos(0) * index * 4,
          y: point.y - Math.sin(0) * index * 4
        })),
        lastSeen: Date.now()
      });
      broadcast({ type: 'joined', player: publicPlayer(players.get(id)) });
      return;
    }

    const player = players.get(id);
    if (!player) return;
    player.lastSeen = Date.now();
    if (message.type === 'input') {
      if (Number.isFinite(message.angle)) player.targetAngle = message.angle;
      player.boost = Boolean(message.boost) && player.score >= 5;
    }
    if (message.type === 'eat' && [10, 25, 50].includes(message.value)) {
      player.score = Math.min(1_000_000, player.score + message.value);
    }
  });

  socket.on('close', () => {
    if (players.delete(id)) broadcast({ type: 'left', id });
  });
});

function turnTowards(player, target, maximum) {
  const difference = Math.atan2(Math.sin(target - player.angle), Math.cos(target - player.angle));
  player.angle += Math.max(-maximum, Math.min(maximum, difference));
}

function addTrail(player, newX, newY) {
  const previous = player.trail[0] || { x: player.x, y: player.y };
  const dx = newX - previous.x;
  const dy = newY - previous.y;
  const distance = Math.hypot(dx, dy);
  if (distance >= 4) {
    const steps = Math.floor(distance / 4);
    for (let index = 1; index <= steps; index++) {
      const amount = Math.min(index * 4, distance) / distance;
      player.trail.unshift({ x: previous.x + dx * amount, y: previous.y + dy * amount });
    }
  }
  const segments = 3 + Math.floor(player.score / 25);
  const maximum = segments * 9 + 30;
  if (player.trail.length > maximum) player.trail.length = maximum;
}

function checkCollisions() {
  const collisionNow = Date.now();
  const alive = [...players.values()].filter(player => player.alive && collisionNow >= (player.shieldUntil || 0));
  const cellSize = 70;
  const grid = new Map();
  const cellKey = (x, y) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;

  for (const owner of alive) {
    const segments = 3 + Math.floor(owner.score / 25);
    const bodyEnd = Math.min(owner.trail.length - 1, 8 + segments * 9);
    for (let index = 8; index <= bodyEnd; index += 4) {
      const point = owner.trail[index];
      if (!point) continue;
      const key = cellKey(point.x, point.y);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push({ point, owner });
    }
  }

  for (const player of alive) {
    const cellX = Math.floor(player.x / cellSize);
    const cellY = Math.floor(player.y / cellSize);
    collision: for (let x = cellX - 1; x <= cellX + 1; x++) {
      for (let y = cellY - 1; y <= cellY + 1; y++) {
        for (const hit of grid.get(`${x},${y}`) || []) {
          if (hit.owner !== player && Math.hypot(player.x - hit.point.x, player.y - hit.point.y) < 28) {
            player.alive = false;
            player.boost = false;
            if (player.isBot) player.respawnAt = Date.now() + 5000;
            break collision;
          }
        }
      }
    }
  }

  for (let first = 0; first < alive.length; first++) {
    for (let second = first + 1; second < alive.length; second++) {
      const a = alive[first];
      const b = alive[second];
      if (a.alive && b.alive && Math.hypot(a.x - b.x, a.y - b.y) < 32) {
        a.alive = false;
        b.alive = false;
        a.boost = false;
        b.boost = false;
        if (a.isBot) a.respawnAt = Date.now() + 5000;
        if (b.isBot) b.respawnAt = Date.now() + 5000;
      }
    }
  }
}

setInterval(() => {
  const dt = 1 / TICK_RATE;
  const now = Date.now();
  for (const [id, player] of players) {
    if (!player.isBot && now - player.lastSeen > 30_000) {
      players.delete(id);
      continue;
    }
    if (!player.alive) {
      if (player.isBot && now >= (player.respawnAt || 0)) createBot(Number(id.split('-')[1]));
      continue;
    }
    if (player.isBot) {
      player.aiClock -= dt;
      if (player.aiClock <= 0) {
        player.aiClock = .5 + Math.random() * 1.2;
        const edgeDistance = Math.hypot(player.x - CENTER, player.y - CENTER);
        player.targetAngle = edgeDistance > RADIUS - 500
          ? Math.atan2(CENTER - player.y, CENTER - player.x)
          : player.angle + (Math.random() - .5) * 1.5;
        player.boost = Math.random() < .12 && player.score >= 5;
      }
    }
    if (player.boost) {
      player.boostClock = (player.boostClock || 0) + dt;
      while (player.boostClock >= .5) {
        player.boostClock -= .5;
        player.score = Math.max(0, player.score - 5);
        if (player.score < 5) player.boost = false;
      }
    } else player.boostClock = 0;
    turnTowards(player, player.targetAngle, 2.7 * dt);
    const speed = SPEED * (player.boost ? 2 : 1);
    const newX = player.x + Math.cos(player.angle) * speed * dt;
    const newY = player.y + Math.sin(player.angle) * speed * dt;
    addTrail(player, newX, newY);
    player.x = newX;
    player.y = newY;
    if (Math.hypot(player.x - CENTER, player.y - CENTER) > RADIUS - 20) {
      player.alive = false;
      if (player.isBot) player.respawnAt = now + 5000;
    }
  }
  checkCollisions();
  broadcast({ type: 'state', time: now, players: [...players.values()].map(publicPlayer) });
}, 1000 / TICK_RATE);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Snake server is running on port ${PORT}`);
});
