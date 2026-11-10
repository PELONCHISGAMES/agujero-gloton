/**
 * ==============================================================================
 * PELONCHIS GAMES — AGUJERO GLOTÓN MULTIPLAYER WEBSOCKET SERVER (V2 MEJORADO)
 * ==============================================================================
 * - Movimiento ultra suave y fluido de los bots con inercia (sin saltos bruscos).
 * - Velocidad balanceada: los bots se mueven a un 75% de la velocidad del jugador
 *   para que las partidas sean justas y divertidas de ganar.
 * - Mapa repleto de comida (400-600 objetos): flores, piedras, setas, árboles,
 *   cristales y casas repartidos por toda la arena para crecer desde el inicio.
 * - Regeneración dinámica de ítems con nuevos IDs únicos para activar la
 *   animación de absorción y los efectos de sonido de tragar (gulp).
 * - Crecimiento por conservación de área matemáticamente equilibrado.
 * ==============================================================================
 */

const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

// Constantes oficiales del juego
const ARENA = 1400;
const ZONE_T = 150; // 2.5 minutos de partida
const ZONE_MIN = 60;
const EAT_RATIO = 0.90; // Debes ser al menos 10% mayor para comer
const GROW_FACTOR = 0.35; // Crecimiento por conservación de área
const TICK_RATE = 15; // 15 Hz de sincronización
const TICK_DT = 1 / TICK_RATE;
const LOBBY_WAIT_SECONDS = 8; // Tiempo de espera en matchmaking antes de iniciar

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
  "AstroDevorador", "HoyoNegro", "Titán", "Comilón", "MegaFauces", "MiniVortex",
  "Devorador", "Pillín", "Cometodo", "Glotonazo", "Tragalotodo"
];

const rooms = [];
let nextRoomId = 1;
let nextEntityId = 1;

/**
 * Clase que gestiona una Sala de Juego en tiempo real
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
    this.entities = []; // Jugadores humanos y bots
    this.items = []; // Lista de objetos comestibles

    this.initItems();
  }

  initItems() {
    this.items = [];
    // Número abundante de objetos para que la arena esté llena de vida
    const itemCount = this.maxPlayers === 10 ? 320 : (this.maxPlayers === 30 ? 460 : 600);

    for (let i = 0; i < itemCount; i++) {
      this.items.push(this.createRandomItem());
    }
  }

  createRandomItem() {
    // Concentración de objetos en la zona de juego inicial
    const angle = Math.random() * Math.PI * 2;
    // Distribución suave hacia el centro donde están los jugadores
    const maxDist = Math.max(120, this.zone * 0.92);
    const dist = Math.sqrt(Math.random()) * maxDist;

    // 70% de objetos pequeños y medianos para crecimiento inicial rápido
    let typeIdx;
    const roll = Math.random();
    if (roll < 0.45) {
      typeIdx = Math.floor(Math.random() * 4); // pebble, flower, critter, mushroom (0.6 - 1.2)
    } else if (roll < 0.80) {
      typeIdx = 4 + Math.floor(Math.random() * 4); // crystal, bush, tree, rover (1.5 - 3.6)
    } else if (roll < 0.95) {
      typeIdx = 8 + Math.floor(Math.random() * 3); // house, boulder, tower (5.0 - 10.0)
    } else {
      typeIdx = 11 + Math.floor(Math.random() * 2); // mountain, city (16.0 - 26.0)
    }

    const type = TYPES[typeIdx] || "pebble";
    const size = CAT_SIZES[type] || 1;

    return {
      id: nextEntityId++, // SIEMPRE UN ID NUEVO para que el cliente detecte cuando se come
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
      vx: 0,
      vy: 0,
      r: 8.75, // Radio inicial oficial
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
        vx: 0,
        vy: 0,
        wa: Math.random() * Math.PI * 2, // Ángulo de deambular
        r: 8.75 * (0.80 + Math.random() * 0.25),
        score: 0,
        kills: 0,
        botTimer: Math.random() * 1.5,
        targetItem: null
      };
      this.entities.push(bot);
    }
  }

  startMatch() {
    this.state = "playing";
    this.fillWithBots();

    // Distribuir a los jugadores en un anillo de spawn bien espaciado
    const total = this.entities.length;
    this.entities.forEach((p, idx) => {
      const a = (idx / total) * Math.PI * 2 + (Math.random() * 0.2 - 0.1);
      const d = 160 + Math.random() * 320;
      p.x = Math.cos(a) * d;
      p.y = Math.sin(a) * d;
      p.targetX = p.x;
      p.targetY = p.y;
      p.vx = 0;
      p.vy = 0;

      if (!p.isBot && p.socket) {
        sendWs(p.socket, {
          t: "start",
          mode: this.mode,
          id: p.id,
          max: this.maxPlayers,
          x: Math.round(p.x),
          y: Math.round(p.y),
          r0: Math.round(p.r * 10) / 10,
          zt: Math.round(this.zoneT)
        });
      }
    });

    console.log(`[Sala #${this.id}] Partida arrancada: ${this.maxPlayers} participantes (${this.getRealPlayerCount()} humanos + ${this.maxPlayers - this.getRealPlayerCount()} bots).`);
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

      this.broadcast({
        t: "lobby",
        n: realCount,
        max: this.maxPlayers,
        wait: Math.max(1, Math.ceil(this.countdown))
      });

      if ((this.countdown <= 0 && realCount >= 1) || realCount >= this.maxPlayers) {
        this.startMatch();
      }
      return;
    }

    if (this.state !== "playing") return;

    // 1. Reducción gradual y suave de la zona
    this.zoneT = Math.max(0, this.zoneT - TICK_DT);
    const progress = (ZONE_T - this.zoneT) / ZONE_T;
    this.zone = Math.max(ZONE_MIN, ARENA * (1 - Math.pow(progress, 1.1) * 0.95));

    // 2. Físicas y movimiento fluido
    for (const p of this.entities) {
      if (!p.alive) continue;

      if (p.isBot) {
        this.updateBotAI(p, TICK_DT);
      }

      // Velocidad base ajustada con la del cliente (~50-65 unidades/segundo a tamaño base)
      // Escala suave con el tamaño: los agujeros grandes son ligeramente más pesados
      const baseSpeed = 58 * Math.pow(8.75 / Math.max(8, p.r), 0.35);

      // Los bots son intencionalmente un 25% más lentos (factor 0.75) para que
      // el jugador humano pueda maniobrar, huir o cazarlos justamente
      const speed = p.isBot ? (baseSpeed * 0.74) : baseSpeed;

      const dx = p.targetX - p.x;
      const dy = p.targetY - p.y;
      const dist = Math.hypot(dx, dy);

      if (dist > 2) {
        const targetVx = (dx / dist) * speed;
        const targetVy = (dy / dist) * speed;

        // Inercia fluida: acelera suavemente hacia la dirección objetivo (sin saltos bruscos)
        p.vx += (targetVx - p.vx) * Math.min(1, TICK_DT * 5.0);
        p.vy += (targetVy - p.vy) * Math.min(1, TICK_DT * 5.0);
      } else {
        p.vx *= Math.max(0, 1 - TICK_DT * 4.0);
        p.vy *= Math.max(0, 1 - TICK_DT * 4.0);
      }

      p.x += p.vx * TICK_DT;
      p.y += p.vy * TICK_DT;

      // Mantener dentro de la arena
      const distCenter = Math.hypot(p.x, p.y);
      if (distCenter > ARENA) {
        p.x *= (ARENA / distCenter);
        p.y *= (ARENA / distCenter);
      }

      // Daño por zona tóxica exterior
      if (distCenter > this.zone) {
        p.r -= TICK_DT * 2.8;
        if (p.r <= 3.2) {
          this.eliminatePlayer(p, null, true);
        }
      }
    }

    // 3. Absorción de ítems con conservación de área real
    for (const p of this.entities) {
      if (!p.alive) continue;

      for (let i = this.items.length - 1; i >= 0; i--) {
        const it = this.items[i];
        const d = Math.hypot(it.x - p.x, it.y - p.y);

        // Puedes tragar si estás encima del ítem y eres al menos 10% mayor
        if (d < p.r * 1.05 && it.size < p.r * EAT_RATIO) {
          // Fórmula matemática de crecimiento por área
          p.r = Math.sqrt(p.r * p.r + GROW_FACTOR * it.size * it.size);
          p.score += Math.ceil(it.size);

          // ELIMINAR el ítem viejo (el cliente reproducirá la animación de tragar y sonido gulp)
          this.items.splice(i, 1);

          // REAPARECER un nuevo ítem con un ID NUEVO dentro del mapa
          this.items.push(this.createRandomItem());
        }
      }
    }

    // 4. Combate entre agujeros (comer a rivales menores)
    const alive = this.entities.filter(p => p.alive);
    for (let i = 0; i < alive.length; i++) {
      const a = alive[i];
      if (!a.alive) continue;

      for (let j = 0; j < alive.length; j++) {
        if (i === j) continue;
        const b = alive[j];
        if (!b.alive) continue;

        const d = Math.hypot(a.x - b.x, a.y - b.y);
        // Si el centro de B entra dentro del radio de A y A es mayor por al menos 10%
        if (d < a.r * 0.90 && b.r < a.r * EAT_RATIO) {
          // A se traga a B: gana un gran impulso de tamaño
          a.r = Math.sqrt(a.r * a.r + GROW_FACTOR * b.r * b.r * 0.85);
          a.kills++;
          a.score += 50;
          this.eliminatePlayer(b, a.name, false, a.id);
        }
      }
    }

    // 5. Comprobar ganador
    const remaining = this.entities.filter(p => p.alive);
    if (remaining.length <= 1) {
      const winner = remaining[0];
      if (winner && !winner.isBot && winner.socket) {
        sendWs(winner.socket, { t: "win" });
      }
      this.state = "finished";
      console.log(`[Sala #${this.id}] Partida terminada. Ganador: ${winner ? winner.name : 'Nadie'}`);
      return;
    }

    // 6. Enviar actualización a los jugadores conectados
    this.broadcastState();
  }

  updateBotAI(bot, dt) {
    bot.botTimer = (bot.botTimer || 0) - dt;

    if (bot.botTimer <= 0) {
      bot.botTimer = 0.6 + Math.random() * 0.8;

      let nearestDanger = null;
      let minDangerDist = bot.r * 7;
      let nearestPrey = null;
      let minPreyDist = bot.r * 6;

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
        // Huir del agujero más grande
        const dx = bot.x - nearestDanger.x;
        const dy = bot.y - nearestDanger.y;
        const len = Math.hypot(dx, dy) || 1;
        bot.targetX = bot.x + (dx / len) * (bot.r * 8);
        bot.targetY = bot.y + (dy / len) * (bot.r * 8);
      } else if (nearestPrey && Math.random() < 0.75) {
        // Cazar a la presa pequeña
        bot.targetX = nearestPrey.x;
        bot.targetY = nearestPrey.y;
      } else {
        // Buscar comida cercana
        let bestItem = null;
        let bestDist = bot.r * 12;

        for (let i = 0; i < Math.min(100, this.items.length); i++) {
          const it = this.items[i];
          if (it.size < bot.r * EAT_RATIO) {
            const d = Math.hypot(it.x - bot.x, it.y - bot.y);
            if (d < bestDist) {
              bestDist = d;
              bestItem = it;
            }
          }
        }

        if (bestItem) {
          bot.targetX = bestItem.x;
          bot.targetY = bestItem.y;
        } else {
          // Deambular suavemente
          bot.wa += (Math.random() - 0.5) * 1.2;
          const wanderDist = bot.r * 5;
          bot.targetX = bot.x + Math.cos(bot.wa) * wanderDist;
          bot.targetY = bot.y + Math.sin(bot.wa) * wanderDist;
        }
      }
    }
  }

  eliminatePlayer(victim, killerName, isZone, killerId) {
    victim.alive = false;
    const pos = this.getAliveCount() + 1;

    this.broadcast({
      t: "feed",
      a: killerName || victim.name,
      b: killerName ? victim.name : "",
      ai: killerId || 0,
      zone: !!isZone
    });

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

      // Filtrar ítems relevantes: los que están en el campo de visión del jugador
      // o un límite de 160 objetos para mantener la red ligera y a 60 FPS estables
      const maxViewDist = Math.max(450, p.r * 16);
      const relevantItems = this.items
        .filter(it => Math.hypot(it.x - p.x, it.y - p.y) < maxViewDist)
        .slice(0, 160)
        .map(it => [
          it.id,
          it.typeIdx,
          Math.round(it.x),
          Math.round(it.y),
          Math.round(it.size * 10) / 10
        ]);

      const stateMsg = {
        t: "s",
        z: Math.round(this.zone),
        zt: Math.round(this.zoneT),
        a: aliveCount,
        me: Math.round(p.r * 10) / 10,
        it: relevantItems,
        ps: playersData
      };
      sendWs(sock, stateMsg);
    }
  }
}

function findOrCreateRoom(maxPlayers, mode) {
  const targetMax = [10, 30, 50].includes(Number(maxPlayers)) ? Number(maxPlayers) : 30;
  let room = rooms.find(r => r.maxPlayers === targetMax && r.state === "lobby" && r.getRealPlayerCount() < targetMax);

  if (!room) {
    room = new GameRoom(targetMax, mode || "battle");
    rooms.push(room);
  }

  return room;
}

// Bucle global del servidor a 15 Hz
setInterval(() => {
  for (let i = rooms.length - 1; i >= 0; i--) {
    const room = rooms[i];
    room.tick();

    if (room.state === "finished" || (room.state !== "lobby" && room.getRealPlayerCount() === 0)) {
      rooms.splice(i, 1);
    }
  }
}, 1000 / TICK_RATE);

/**
 * ==============================================================================
 * MOTOR NATIVO WEBSOCKET RFC 6455
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
    version: "2.0-smooth",
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

      if (opcode === 8) {
        socket.end();
        return;
      }
      if (opcode === 9) {
        socket.write(Buffer.from([0x8a, 0x00]));
        continue;
      }
      if (opcode === 1) {
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
  console.log(`🎮 PELONCHIS GAMES — AGUJERO GLOTÓN MULTIJUGADOR V2`);
  console.log(`📡 Puerto: ${PORT} | Balance de velocidad: 75% bots`);
  console.log(`🍎 Generación dinámica de ítems y físicas suaves`);
  console.log(`========================================================`);
});
