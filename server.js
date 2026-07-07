import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 5000;
const PASSCODE = process.env.PASSCODE || '1234';
const DB_FILE = path.join(__dirname, 'db_store.json');

app.use(cors());
app.use(express.json());

// Initialize Local JSON Database
function initDB() {
  if (!fs.existsSync(DB_FILE)) {
    const defaultData = {
      history: [],
      geofences: [
        { id: '1', name: '집 (Home)', lat: 37.5665, lng: 126.9780, radius: 100 }, // Default Seoul City Hall
        { id: '2', name: '학교 (School)', lat: 37.5695, lng: 126.9820, radius: 150 }
      ],
      currentLocation: null
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2), 'utf8');
  }
}
initDB();

function readDB() {
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading database file, returning defaults', err);
    return { history: [], geofences: [], currentLocation: null };
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing to database file', err);
  }
}

// Authentication Middleware
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '인증 헤더가 누락되었습니다.' });
  }
  const token = authHeader.split(' ')[1];
  if (token !== PASSCODE) {
    return res.status(401).json({ error: '유효하지 않은 패스코드입니다.' });
  }
  next();
};

// --- REST API Endpoints ---

// Login Endpoint
app.post('/api/login', (req, res) => {
  const { passcode } = req.body;
  if (passcode === PASSCODE) {
    res.json({ success: true, token: PASSCODE });
  } else {
    res.status(401).json({ error: '패스코드가 일치하지 않습니다.' });
  }
});

// Update Location (Child -> Server)
app.post('/api/location/update', authMiddleware, (req, res) => {
  const { lat, lng, speed, heading, accuracy, battery, timestamp } = req.body;

  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ error: '위도(lat)와 경도(lng)는 필수 입력 사항입니다.' });
  }

  const db = readDB();
  
  const newLocation = {
    id: Date.now().toString(),
    lat: Number(lat),
    lng: Number(lng),
    speed: speed !== null ? Number(speed) : 0,
    heading: heading !== null ? Number(heading) : 0,
    accuracy: accuracy !== null ? Number(accuracy) : 0,
    battery: battery !== null ? Number(battery) : 100,
    timestamp: timestamp || new Date().toISOString()
  };

  db.currentLocation = newLocation;
  db.history.push(newLocation);

  // Keep history size reasonable (limit to last 2000 points, approx 7 days at 5 min intervals)
  if (db.history.length > 2000) {
    db.history.shift();
  }

  writeDB(db);

  // Broadcast to all connected WebSocket clients
  broadcastToParents({
    type: 'location_update',
    data: newLocation
  });

  res.json({ success: true, message: '위치 정보가 성공적으로 기록되었습니다.', data: newLocation });
});

// Get Current Location
app.get('/api/location/current', authMiddleware, (req, res) => {
  const db = readDB();
  res.json(db.currentLocation || { error: '기록된 위치 정보가 없습니다.' });
});

// Get Location History
app.get('/api/location/history', authMiddleware, (req, res) => {
  const db = readDB();
  res.json(db.history);
});

// Clear Location History
app.delete('/api/location/history', authMiddleware, (req, res) => {
  const db = readDB();
  db.history = [];
  db.currentLocation = null;
  writeDB(db);
  
  broadcastToParents({
    type: 'history_cleared'
  });
  
  res.json({ success: true, message: '이동 경로가 초기화되었습니다.' });
});

// Get Geofences
app.get('/api/geofences', authMiddleware, (req, res) => {
  const db = readDB();
  res.json(db.geofences);
});

// Add Geofence
app.post('/api/geofences', authMiddleware, (req, res) => {
  const { name, lat, lng, radius } = req.body;
  if (!name || lat === undefined || lng === undefined || !radius) {
    return res.status(400).json({ error: '필수 항목이 누락되었습니다.' });
  }

  const db = readDB();
  const newGeofence = {
    id: Date.now().toString(),
    name,
    lat: Number(lat),
    lng: Number(lng),
    radius: Number(radius)
  };

  db.geofences.push(newGeofence);
  writeDB(db);

  broadcastToParents({
    type: 'geofences_updated',
    data: db.geofences
  });

  res.json({ success: true, data: newGeofence });
});

// Delete Geofence
app.delete('/api/geofences/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const db = readDB();
  db.geofences = db.geofences.filter(g => g.id !== id);
  writeDB(db);

  broadcastToParents({
    type: 'geofences_updated',
    data: db.geofences
  });

  res.json({ success: true, message: '안심구역이 삭제되었습니다.' });
});

// --- WebSocket Support ---
const connectedClients = new Set();

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const token = url.searchParams.get('token');

  if (token !== PASSCODE) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  connectedClients.add(ws);
  console.log(`Parent client connected. Active connections: ${connectedClients.size}`);

  // Send current state on connect
  const db = readDB();
  ws.send(JSON.stringify({
    type: 'init_state',
    data: {
      currentLocation: db.currentLocation,
      geofences: db.geofences
    }
  }));

  ws.on('close', () => {
    connectedClients.delete(ws);
    console.log(`Parent client disconnected. Active connections: ${connectedClients.size}`);
  });
});

function broadcastToParents(message) {
  const payload = JSON.stringify(message);
  for (const client of connectedClients) {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

// --- Serve Frontend Static Files ---
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.send('API Server is running. Frontend needs to be built with "npm run build" to serve here.');
  });
}

// Start HTTP & WS Server
server.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`  AxialSafe Location Tracker Server running!`);
  console.log(`  - API Port: ${PORT}`);
  console.log(`  - Passcode: ${PASSCODE}`);
  console.log(`  - Dev Frontend: http://localhost:5173`);
  console.log(`  - Prod Server:  http://localhost:${PORT}`);
  console.log(`===============================================`);
});
