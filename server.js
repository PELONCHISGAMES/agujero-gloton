/**
 * ==============================================================================
 * PELONCHIS GAMES — AGUJERO GLOTÓN MULTIPLAYER WEBSOCKET SERVER
 * ==============================================================================
 * Soporta salas de 10, 30 y 50 jugadores en tiempo real.
 * Si no hay suficientes jugadores reales tras la cuenta atrás, la sala se
 * autocompleta con bots inteligentes para que la partida arranque de inmediato.
 *
 * Funciona de forma 100% nativa en Node.js (cero dependencias externas requeridas).
 * ==============================================================================
 */

const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

// Constantes sincronizadas con el cliente de Agujero Glotón
const ARENA = 1400;
const ZONE_T = 150; // 2.5 minutos de partida
const ZONE_MIN = 60;
const EAT_RATIO = 0.9; // Para comer a otro agujero o ítem debes ser al menos 10% mayor
const TICK_RATE = 15; // 15 Hz de actualización
const TICK_DT = 1 / TICK_RATE;
const LOBBY_WAIT_SECONDS = 8; // Tiempo de espera en sala antes de arrancar con bots

const TYPES = [
  "pebble", "flower", "critter", "mushroom", "crystal", "bush",
  "tree", "rover", "house", "boulder", "tower", "mountain", "city",
  "satellite", "ufo", "asteroid", "moon", "redplanet", "earth", "ringed",
  "gas", "comet", "reddwarf", "star", "bluegiant", "nebula", "galaxy", "quasar"
];

const CAT_SIZES = {
  pebble: 0.6, flower: 0.7, critter: 1.0, mushroom: 1.2, crystal: 1.5,
  bush: 2.0, tree: 3.0, rover: 3.6, house: 5.0, boulder: 7.0, tower: 10.0,
  mountain: 16.0, city: 26.0, satellite: 40.0, ufo: 55.0, asteroid: 75.0,
  moon: 130.0, redplanet: 220.0, earth: 320.0, ringed: 460.0, gas: 700.0,
  comet: 520.0, reddwarf: 1100.0, star: 1800.0, bluegiant: 3000.0,
  nebula: 5500.0, galaxy: 11000.0, quasar: 24000.0
};

const BOT_NAMES = [
  "Zampón", "Glotonix", "Vortex", "Nomnom", "Bocazas", "Migas", "Kraken",
  "Tragón", "Chompy", "Abismo", "Zorg", "Glup", "Mordisco", "Nebulón",
  "AstroDevorador", "HoyoNegro", "Titán", "Comilón", "MegaFauces", "MiniVortex"
];

// Almacén de salas activas divididas por tamaño (10, 30, 50)
const rooms = [];
let nextRoomId = 1;
let nextEntityId = 1;

/**
 * Representa una sala de juego
 */
class GameRoom {
  constructor(maxPlayers, mode = "battle") {
    this.id = nextRoomId++;
    this.maxPlayers = [10, 30, 50].includes(Number(maxPlayers)) ? Number(maxPlayers) : 30;
    this.mode = mode;
    this.state = "lobby"; // lobby, playing, finished
    this.countdown = LOBBY_WAIT_SECONDS;
    this.zone = ARENA;
    this.zoneT = ZONE_T;

    this.clients = new Map(); // socket -> player
    this.entities = []; // Array de jugadores reales y bots
    this.items = []; // Mapa de ítems comestibles

    this.initItems();
  }

  initItems() {
    this.items = [];
    const itemCount = Math.min(300, 80 + this.maxPlayers * 4);
    for (let i = 0; i < itemCount; i++) {
      this.items.push(this.createRandomItem(i + 1));
    }
  }

  createRandomItem(id) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * (ARENA * 0.95);
    const typeIdx = Math.floor(Math.pow(Math.random(), 2.2) * Math.min(13, TYPES.length));
    const type = TYPES[typeIdx] || "pebble";
    const size = CAT_SIZES[type] || 1;
    return {
      id: id || nextEntityId++,
      typeIdx,
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      size
    };
  }

  addPlayer(socket, name, look) {
    if (this.state !== "lobby") return null;

    const player = {
      id: nextEntityId++,
      socket,
      name: (name || "Agujero").slice(0, 14),
      look: Array.isArray(look) ? look : [0, 0, 0, 0, 0],
      isBot: false,
      alive: true,
      x: 0,
      y: 0,
      targetX: 0,
      targetY: 0,
      r: 8.75, // Radio inicial
      score: 0,
      kills: 0
    };

    this.clients.set(socket, player);
    this.entities.push(player);

    return player;
  }

  removePlayer(socket) {
    const player = this.clients.get(socket);
    if (!player) return;

    this.clients.delete(socket);
    if (this.state === "lobby") {
      this.entities = this.entities.filter(p => p !== player);
    } else {
      player.alive = false;
      player.socket = null;
    }
  }

  getRealPlayerCount() {
    return Array.from(this.clients.values()).filter(p => !p.isBot).length;
  }

  getAliveCount() {
    return this.entities.filter(p => p.alive).length;
  }

  fillWithBots() {
    const needed = this.maxPlayers - this.entities.length;
    for (let i = 0; i < needed; i++) {
      const name = BOT_NAMES[i % BOT_NAMES.length] + (i >= BOT_NAMES.length ? `_${i}` : "") + " (bot)";
      const bot = {
        id: nextEntityId++,
        socket: null,
        name,
        look: [Math.floor(Math.random() * 8), Math.floor(Math.random() * 8), 0, Math.floor(Math.random() * 8), 0],
        isBot: true,
        alive: true,
        x: 0,
        y: 0,
        targetX: 0,
        targetY: 0,
        r: 8.75 * (0.85 + Math.random() * 0.3),
        score: 0,
        kills: 0,
        botTimer: Math.random() * 2
      };
      this.entities.push(bot);
    }
  }

  startMatch() {
    this.state = "playing";
    this.fillWithBots();

    // Distribuir a los jugadores y bots en un anillo inicial de spawn
    const total = this.entities.length;
    this.entities.forEach((p, idx) => {
      const a = (idx / total) * Math.PI * 2 + (Math.random() * 0.3 - 0.15);
      const d = 140 + Math.random() * (ARENA * 0.45);
      p.x = Math.cos(a) * d;
      p.y = Math.sin(a) * d;
      p.targetX = p.x;
      p.targetY = p.y;

      if (!p.isBot && p.socket) {
        sendWs(p.socket, {
          t: "start",
          mode: this.mode,
          id: p.id,
          max: this.maxPlayers,
          x: Math.round(p.x),
          y: Math.round(p.y),
          r0: p.r,
          zt: Math.round(this.zoneT)
        });
      }
    });

    console.log(`[Sala #${this.id}] Partida iniciada con ${this.maxPlayers} participantes (${this.getRealPlayerCount()} jugadores reales + ${this.maxPlayers - this.getRealPlayerCount()} bots).`);
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const [sock] of this.clients) {
      sendWsRaw(sock, msg);
    }
  }

  tick() {
    if (this.state === "lobby") {
      this.countdown -= TICK_DT;
      const realCount = this.getRealPlayerCount();

      // Enviar actualización del lobby a los clientes
      const lobbyMsg = {
        t: "lobby",
        n: realCount,
        max: this.maxPlayers,
        wait: Math.max(1, Math.ceil(this.countdown))
      };
      this.broadcast(lobbyMsg);

      // Si se acaba la cuenta atrás o se llena la sala, ¡comienza el juego!
      if ((this.countdown <= 0 && realCount >= 1) || realCount >= this.maxPlayers) {
        this.startMatch();
      }
      return;
    }

    if (this.state !== "playing") return;

    // 1. Reducir la zona tóxica con el tiempo
    this.zoneT = Math.max(0, this.zoneT - TICK_DT);
    const progress = (ZONE_T - this.zoneT) / ZONE_T;
    this.zone = Math.max(ZONE_MIN, ARENA * (1 - progress * 0.95));

    // 2. Actualizar posiciones e inteligencia de bots
    for (const p of this.entities) {
      if (!p.alive) continue;

      if (p.isBot) {
        this.updateBotAI(p, TICK_DT);
      }

      // Velocidad inversa al tamaño (los agujeros más grandes van más lentos)
      const speed = Math.max(65, 175 / Math.sqrt(p.r / 8.75));
      const dx = p.targetX - p.x;
      const dy = p.targetY - p.y;
      const dist = Math.hypot(dx, dy);

      if (dist > 1) {
        const step = Math.min(dist, speed * TICK_DT);
        p.x += (dx / dist) * step;
        p.y += (dy / dist) * step;
      }

      // Comprobar si está fuera de la zona segura
      const distFromCenter = Math.hypot(p.x, p.y);
      if (distFromCenter > this.zone) {
        p.r -= TICK_DT * 3.5;
        if (p.r <= 3.5) {
          this.eliminatePlayer(p, null, true);
        }
      }
    }

    // 3. Comprobar colisiones: comer ítems
    for (const p of this.entities) {
      if (!p.alive) continue;

      for (let i = 0; i < this.items.length; i++) {
        const it = this.items[i];
        const d = Math.hypot(it.x - p.x, it.y - p.y);

        if (d < p.r * 1.05 && it.size < p.r * EAT_RATIO) {
          // Comer ítem
          p.r += Math.min(0.75, it.size * 0.075);
          p.score += Math.ceil(it.size);

          // Reaparecer ítem en una nueva posición dentro de la zona
          this.items[i] = this.createRandomItem(it.id);
        }
      }
    }

    // 4. Comprobar colisiones: agujeros comiendo a otros agujeros
    const alive = this.entities.filter(p => p.alive);
    for (let i = 0; i < alive.length; i++) {
      const a = alive[i];
      if (!a.alive) continue;

      for (let j = 0; j < alive.length; j++) {
        if (i === j) continue;
        const b = alive[j];
        if (!b.alive) continue;

        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < a.r * 0.95 && b.r < a.r * EAT_RATIO) {
          // A se come a B
          a.r += Math.min(12, b.r * 0.35);
          a.kills++;
          this.eliminatePlayer(b, a.name, false, a.id);
        }
      }
    }

    // 5. Comprobar si queda un ganador
    const remaining = this.entities.filter(p => p.alive);
    if (remaining.length <= 1) {
      const winner = remaining[0];
      if (winner && !winner.isBot && winner.socket) {
        sendWs(winner.socket, { t: "win" });
      }
      this.state = "finished";
      console.log(`[Sala #${this.id}] Partida finalizada. Ganador: ${winner ? winner.name : 'Nadie'}`);
      return;
    }

    // 6. Difundir estado a todos los jugadores reales
    this.broadcastState();
  }

  updateBotAI(bot, dt) {
    bot.botTimer = (bot.botTimer || 0) - dt;
    if (bot.botTimer <= 0) {
      bot.botTimer = 0.5 + Math.random() * 0.8;

      let nearestDanger = null;
      let minDangerDist = bot.r * 8;
      let nearestPrey = null;
      let minPreyDist = bot.r * 7;

      for (const other of this.entities) {
        if (other === bot || !other.alive) continue;
        const d = Math.hypot(other.x - bot.x, other.y - bot.y);
        if (other.r > bot.r * EAT_RATIO && d < minDangerDist) {
          nearestDanger = other;
          minDangerDist = d;
        } else if (bot.r > other.r * EAT_RATIO && d < minPreyDist) {
          nearestPrey = other;
          minPreyDist = d;
        }
      }

      if (nearestDanger) {
        // Huir del peligro
        const dx = bot.x - nearestDanger.x;
        const dy = bot.y - nearestDanger.y;
        bot.targetX = bot.x + dx * 2;
        bot.targetY = bot.y + dy * 2;
      } else if (nearestPrey) {
        // Cazar a la presa más pequeña
        bot.targetX = nearestPrey.x;
        bot.targetY = nearestPrey.y;
      } else {
        // Buscar el ítem comestible más cercano
        let nearestItem = null;
        let minItemDist = bot.r * 15;
        for (const it of this.items) {
          if (it.size < bot.r * EAT_RATIO) {
            const d = Math.hypot(it.x - bot.x, it.y - bot.y);
            if (d < minItemDist) {
              minItemDist = d;
              nearestItem = it;
            }
          }
        }
        if (nearestItem) {
          bot.targetX = nearestItem.x;
          bot.targetY = nearestItem.y;
        } else {
          // Explorar hacia el centro de la zona
          const ang = Math.random() * Math.PI * 2;
          const dist = Math.random() * (this.zone * 0.7);
          bot.targetX = Math.cos(ang) * dist;
          bot.targetY = Math.sin(ang) * dist;
        }
      }
    }
  }

  eliminatePlayer(victim, killerName, isZone, killerId) {
    victim.alive = false;
    const pos = this.getAliveCount() + 1;

    // Enviar feed a todos
    this.broadcast({
      t: "feed",
      a: killerName || victim.name,
      b: killerName ? victim.name : "",
      ai: killerId || 0,
      zone: !!isZone
    });

    // Enviar muerte al jugador si es real
    if (!victim.isBot && victim.socket) {
      sendWs(victim.socket, {
        t: "dead",
        by: killerName || null,
        pos
      });
    }
  }

  broadcastState() {
    const aliveEntities = this.entities.filter(p => p.alive);
    const aliveCount = aliveEntities.length;

    // Muestreo de ítems relevantes
    const itemsData = this.items.map(it => [
      it.id,
      it.typeIdx,
      Math.round(it.x),
      Math.round(it.y),
      Math.round(it.size * 10) / 10
    ]);

    // Posiciones de todos los jugadores
    const playersData = aliveEntities.map(p => [
      p.id,
      Math.round(p.x * 10) / 10,
      Math.round(p.y * 10) / 10,
      Math.round(p.r * 10) / 10,
      p.name,
      p.look
    ]);

    for (const [sock, p] of this.clients) {
      if (!p.alive) continue;

      const stateMsg = {
        t: "s",
        z: Math.round(this.zone),
        zt: Math.round(this.zoneT),
        a: aliveCount,
        me: Math.round(p.r * 10) / 10,
        it: itemsData,
        ps: playersData
      };
      sendWs(sock, stateMsg);
    }
  }
}

/**
 * Gestor de Matchmaking para salas de 10, 30 y 50 jugadores
 */
function findOrCreateRoom(maxPlayers, mode) {
  const targetMax = [10, 30, 50].includes(Number(maxPlayers)) ? Number(maxPlayers) : 30;

  // Buscar una sala en lobby que no esté llena
  let room = rooms.find(r => r.maxPlayers === targetMax && r.state === "lobby" && r.getRealPlayerCount() < targetMax);

  if (!room) {
    room = new GameRoom(targetMax, mode || "battle");
    rooms.push(room);
  }

  return room;
}

// Bucle global de simulación a 15 Hz
setInterval(() => {
  for (let i = rooms.length - 1; i >= 0; i--) {
    const room = rooms[i];
    room.tick();

    // Eliminar salas terminadas o vacías después de 5 segundos
    if (room.state === "finished" || (room.state !== "lobby" && room.getRealPlayerCount() === 0)) {
      rooms.splice(i, 1);
    }
  }
}, 1000 / TICK_RATE);

/**
 * ==============================================================================
 * MOTOR NATIVO WEBSOCKET RFC 6455 (Cero dependencias)
 * ==============================================================================
 */
function sendWs(socket, obj) {
  if (!socket || socket.destroyed || !socket.writable) return;
  sendWsRaw(socket, JSON.stringify(obj));
}

function sendWsRaw(socket, text) {
  if (!socket || socket.destroyed || !socket.writable) return;
  try {
    const payload = Buffer.from(text);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  } catch (err) {}
}

const server = http.createServer((req, res) => {
  // Cabeceras CORS abiertas para permitir llamadas desde pelonchisgames.com
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  const totalPlayers = rooms.reduce((acc, r) => acc + r.getRealPlayerCount(), 0);
  const activeRooms = rooms.length;

  res.writeHead(200);
  res.end(JSON.stringify({
    studio: "Pelonchis Games",
    game: "Agujero Glotón",
    status: "online",
    activeRooms,
    onlinePlayers: totalPlayers,
    roomSizes: [10, 30, 50],
    time: new Date().toISOString()
  }));
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );

  let currentRoom = null;
  let playerRef = null;
  let buffer = Buffer.alloc(0);

  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      const isMasked = (second & 0x80) !== 0;
      let len = second & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buffer.length < 4) break;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) break;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = isMasked ? 4 : 0;
      if (buffer.length < offset + maskLen + len) break;

      let data = buffer.slice(offset + maskLen, offset + maskLen + len);
      if (isMasked) {
        const mask = buffer.slice(offset, offset + 4);
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = data[i] ^ mask[i % 4];
        data = unmasked;
      }

      buffer = buffer.slice(offset + maskLen + len);

      if (opcode === 8) { // Cierre
        socket.end();
        return;
      }
      if (opcode === 9) { // Ping
        socket.write(Buffer.from([0x8a, 0x00])); // Pong
        continue;
      }
      if (opcode === 1) { // Texto
        try {
          const msg = JSON.parse(data.toString("utf8"));
          if (msg.t === "join") {
            const max = [10, 30, 50].includes(Number(msg.max)) ? Number(msg.max) : 30;
            currentRoom = findOrCreateRoom(max, msg.mode || "battle");
            playerRef = currentRoom.addPlayer(socket, msg.name, msg.look);
          } else if (msg.t === "in" && playerRef) {
            playerRef.targetX = msg.x;
            playerRef.targetY = msg.y;
          }
        } catch (err) {}
      }
    }
  });

  const cleanup = () => {
    if (currentRoom) {
      currentRoom.removePlayer(socket);
    }
  };

  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

server.listen(PORT, () => {
  console.log(`========================================================`);
  console.log(`🎮 PELONCHIS GAMES — SERVIDOR AGUJERO GLOTÓN EN VIVO`);
  console.log(`📡 Escuchando en puerto ${PORT}`);
  console.log(`🌍 Salas disponibles: 10, 30 y 50 jugadores`);
  console.log(`🤖 Autocompletado con bots: Activado`);
  console.log(`========================================================`);
});
