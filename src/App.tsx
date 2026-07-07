import React, { useState, useEffect, useRef } from 'react';
import { 
  Shield, 
  MapPin, 
  Battery, 
  Navigation, 
  Lock, 
  Trash2, 
  Play, 
  Pause, 
  LogOut, 
  Compass, 
  AlertTriangle, 
  Signal, 
  RefreshCw, 
  Volume2, 
  VolumeX, 
  Info,
  Clock
} from 'lucide-react';
import L from 'leaflet';

// Haversine distance calculation (in meters)
const getDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371e3; // Earth radius in meters
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const deltaPhi = (lat2 - lat1) * Math.PI / 180;
  const deltaLambda = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
            Math.cos(phi1) * Math.cos(phi2) *
            Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
};

// Web Audio API Warning Sound
const playWarningSound = () => {
  if (typeof window === 'undefined') return;
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(987.77, ctx.currentTime); // B5
    osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.12); // G5
    
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch (err) {
    console.error("Audio playback failed:", err);
  }
};

interface LocationPoint {
  id: string;
  lat: number;
  lng: number;
  speed: number;
  heading: number;
  accuracy: number;
  battery: number;
  timestamp: string;
}

interface Geofence {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius: number;
}

export default function App() {
  // Navigation & Authentication states
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [loginError, setLoginError] = useState('');
  const [role, setRole] = useState<'select' | 'parent' | 'child'>('select');

  // Common tracking states
  const [currentLocation, setCurrentLocation] = useState<LocationPoint | null>(null);
  const [history, setHistory] = useState<LocationPoint[]>([]);
  const [geofences, setGeofences] = useState<Geofence[]>([]);

  // Parent view states
  const [wsConnected, setWsConnected] = useState(false);
  const [playbackIndex, setPlaybackIndex] = useState<number>(-1);
  const [isPlayingHistory, setIsPlayingHistory] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [addGeofenceMode, setAddGeofenceMode] = useState(false);
  const [newGeofence, setNewGeofence] = useState({ name: '', radius: 100, lat: 0, lng: 0 });
  const [showGeofenceModal, setShowGeofenceModal] = useState(false);
  
  // Child view states
  const [isTracking, setIsTracking] = useState(false);
  const [updatesSent, setUpdatesSent] = useState(0);
  const [trackingError, setTrackingError] = useState('');
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [wakeLockObj, setWakeLockObj] = useState<any>(null);
  const [isBlackScreen, setIsBlackScreen] = useState(false);

  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleBlackScreenTouchStart = () => {
    longPressTimerRef.current = setTimeout(() => {
      setIsBlackScreen(false);
    }, 1500);
  };

  const handleBlackScreenTouchEnd = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const enterBlackScreen = async () => {
    if (!wakeLockActive) {
      try {
        if ('wakeLock' in navigator) {
          const lock = await (navigator as any).wakeLock.request('screen');
          setWakeLockObj(lock);
          setWakeLockActive(true);
          lock.addEventListener('release', () => {
            setWakeLockActive(false);
            setWakeLockObj(null);
          });
        }
      } catch (err) {
        console.error('Failed to acquire wake lock:', err);
      }
    }
    setIsBlackScreen(true);
  };


  // Map refs
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<L.Map | null>(null);
  const currentMarker = useRef<L.Marker | null>(null);
  const playbackMarker = useRef<L.Marker | null>(null);
  const historyPolyline = useRef<L.Polyline | null>(null);
  const geofenceCircles = useRef<{ [key: string]: L.Circle }>({});
  
  const wsRef = useRef<WebSocket | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const playbackIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Check stored passcode on mount
  useEffect(() => {
    const savedToken = localStorage.getItem('axial_safe_token');
    if (savedToken) {
      validateToken(savedToken);
    }
  }, []);

  const validateToken = async (token: string) => {
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: token })
      });
      if (res.ok) {
        setIsAuthenticated(true);
        setPasscode(token);
      } else {
        localStorage.removeItem('axial_safe_token');
      }
    } catch (e) {
      // Offline fallback if localstorage matches
      if (token) {
        setIsAuthenticated(true);
        setPasscode(token);
      }
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode })
      });
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem('axial_safe_token', data.token);
        setIsAuthenticated(true);
      } else {
        setLoginError('패스코드가 올바르지 않습니다.');
      }
    } catch (err) {
      setLoginError('서버 연결에 실패했습니다.');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('axial_safe_token');
    setIsAuthenticated(false);
    setPasscode('');
    setRole('select');
    
    // Stop any active child tracking
    if (isTracking) {
      stopChildTracking();
    }
    // Close websocket if parent
    if (wsRef.current) {
      wsRef.current.close();
    }
  };

  // --- PARENT DASHBOARD LOGIC ---
  useEffect(() => {
    if (role !== 'parent' || !isAuthenticated) return;

    // Fetch initial history
    fetchHistory();

    // Establish WebSocket Connection
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${passcode}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
    };

    ws.onclose = () => {
      setWsConnected(false);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'init_state') {
        if (msg.data.currentLocation) {
          setCurrentLocation(msg.data.currentLocation);
        }
        if (msg.data.geofences) {
          setGeofences(msg.data.geofences);
        }
      } else if (msg.type === 'location_update') {
        const newLoc = msg.data;
        setCurrentLocation(newLoc);
        setHistory(prev => {
          const updated = [...prev, newLoc];
          return updated.slice(-2000); // Limit locally too
        });
      } else if (msg.type === 'geofences_updated') {
        setGeofences(msg.data);
      } else if (msg.type === 'history_cleared') {
        setHistory([]);
        setCurrentLocation(null);
      }
    };

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [role, isAuthenticated]);

  const fetchHistory = async () => {
    try {
      const res = await fetch('/api/location/history', {
        headers: { 'Authorization': `Bearer ${passcode}` }
      });
      if (res.ok) {
        const data = await res.json();
        setHistory(data);
      }
    } catch (e) {
      console.error('Failed to fetch location history', e);
    }
  };

  // Check geofence logic for alarm triggering
  const checkGeofenceStatus = () => {
    if (!currentLocation || geofences.length === 0) return { isSafe: true, activeZones: [] };

    let isSafe = false;
    const activeZones: string[] = [];

    geofences.forEach(zone => {
      const dist = getDistance(currentLocation.lat, currentLocation.lng, zone.lat, zone.lng);
      if (dist <= zone.radius) {
        isSafe = true;
        activeZones.push(zone.name);
      }
    });

    return { isSafe, activeZones };
  };

  const status = checkGeofenceStatus();
  const isOutsideAllZones = geofences.length > 0 && !status.isSafe;

  // Trigger sound alarm if outside safe zone
  useEffect(() => {
    if (role === 'parent' && isOutsideAllZones && !isMuted && currentLocation) {
      playWarningSound();
      const interval = setInterval(() => {
        playWarningSound();
      }, 5000); // Warn every 5 seconds
      return () => clearInterval(interval);
    }
  }, [role, isOutsideAllZones, isMuted, currentLocation]);

  // Leaflet Map Initialization & Rendering
  useEffect(() => {
    if (role !== 'parent' || !mapRef.current) return;

    // Create map if it doesn't exist
    if (!leafletMap.current) {
      const initialLat = currentLocation?.lat || 37.5665;
      const initialLng = currentLocation?.lng || 126.9780;
      
      const map = L.map(mapRef.current, {
        zoomControl: false // position manually
      }).setView([initialLat, initialLng], 15);

      L.control.zoom({ position: 'topright' }).addTo(map);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(map);

      leafletMap.current = map;

      // Add Click Listener to Map (for Geofence creation)
      map.on('click', (e: L.LeafletMouseEvent) => {
        // If geofence add mode is active, set coordinates and open modal
        setAddGeofenceMode(prev => {
          if (prev) {
            setNewGeofence(g => ({ ...g, lat: e.latlng.lat, lng: e.latlng.lng }));
            setShowGeofenceModal(true);
            return false; // Exit mode
          }
          return prev;
        });
      });
    }

    const map = leafletMap.current;

    // Update History Polyline
    if (history.length > 1) {
      const latlngs = history.map(h => [h.lat, h.lng] as L.LatLngTuple);
      if (historyPolyline.current) {
        historyPolyline.current.setLatLngs(latlngs);
      } else {
        historyPolyline.current = L.polyline(latlngs, {
          color: '#a78bfa',
          weight: 4,
          opacity: 0.6,
          dashArray: '5, 8'
        }).addTo(map);
      }
    } else {
      if (historyPolyline.current) {
        historyPolyline.current.remove();
        historyPolyline.current = null;
      }
    }

    // Update current location marker
    if (currentLocation) {
      const pos: L.LatLngTuple = [currentLocation.lat, currentLocation.lng];
      
      const markerHtml = `
        <div class="pulsing-marker">
          <div class="pulsing-marker-core ${isOutsideAllZones ? 'pulsing-marker-core-danger' : ''}"></div>
          <div class="pulsing-marker-ring ${isOutsideAllZones ? 'pulsing-marker-ring-danger' : ''}"></div>
        </div>
      `;

      const customIcon = L.divIcon({
        html: markerHtml,
        className: 'custom-div-icon',
        iconSize: [40, 40],
        iconAnchor: [20, 20]
      });

      if (currentMarker.current) {
        currentMarker.current.setLatLng(pos);
        currentMarker.current.setIcon(customIcon);
      } else {
        currentMarker.current = L.marker(pos, { icon: customIcon }).addTo(map);
        map.setView(pos, 16); // Center on first position
      }
    }

    // Update Geofence circles
    // 1. Remove circles not in list
    Object.keys(geofenceCircles.current).forEach(id => {
      if (!geofences.find(g => g.id === id)) {
        geofenceCircles.current[id].remove();
        delete geofenceCircles.current[id];
      }
    });

    // 2. Add or update circles
    geofences.forEach(g => {
      const isInsideThis = currentLocation ? (getDistance(currentLocation.lat, currentLocation.lng, g.lat, g.lng) <= g.radius) : false;
      const color = isInsideThis ? '#10b981' : '#8b5cf6'; // Green if child inside, purple otherwise
      
      if (geofenceCircles.current[g.id]) {
        geofenceCircles.current[g.id].setLatLng([g.lat, g.lng]);
        geofenceCircles.current[g.id].setRadius(g.radius);
        geofenceCircles.current[g.id].setStyle({ color, fillColor: color });
      } else {
        geofenceCircles.current[g.id] = L.circle([g.lat, g.lng], {
          radius: g.radius,
          color,
          fillColor: color,
          fillOpacity: 0.12,
          weight: 2
        }).addTo(map);
      }
    });

  }, [role, history, currentLocation, geofences, isOutsideAllZones]);

  // Center Map on Child Location
  const centerMapOnChild = () => {
    if (leafletMap.current && currentLocation) {
      leafletMap.current.setView([currentLocation.lat, currentLocation.lng], 16, {
        animate: true,
        duration: 0.5
      });
    }
  };

  // Add Geofence API Call
  const handleAddGeofence = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGeofence.name || !newGeofence.radius) return;

    try {
      const res = await fetch('/api/geofences', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${passcode}`
        },
        body: JSON.stringify(newGeofence)
      });
      if (res.ok) {
        setShowGeofenceModal(false);
        setNewGeofence({ name: '', radius: 100, lat: 0, lng: 0 });
      }
    } catch (err) {
      console.error('Failed to add geofence', err);
    }
  };

  // Delete Geofence API Call
  const handleDeleteGeofence = async (id: string) => {
    try {
      await fetch(`/api/geofences/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${passcode}` }
      });
    } catch (err) {
      console.error('Failed to delete geofence', err);
    }
  };

  // Clear History API Call
  const handleClearHistory = async () => {
    if (!window.confirm('이동 경로 히스토리를 정말 초기화하시겠습니까?')) return;
    try {
      await fetch('/api/location/history', {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${passcode}` }
      });
    } catch (err) {
      console.error('Failed to clear history', err);
    }
  };

  // Playback History Timeline Logic
  const handleTimelineChange = (index: number) => {
    setPlaybackIndex(index);
    if (leafletMap.current && history[index]) {
      const point = history[index];
      const pos: L.LatLngTuple = [point.lat, point.lng];

      const playbackIcon = L.divIcon({
        html: `
          <div class="relative">
            <div class="w-4 h-4 bg-emerald-400 border-2 border-white rounded-full shadow-lg"></div>
            <div class="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-emerald-950/90 text-white text-[10px] px-1.5 py-0.5 rounded border border-emerald-500 whitespace-nowrap">
              ${new Date(point.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
            </div>
          </div>
        `,
        className: 'custom-div-icon',
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      });

      if (playbackMarker.current) {
        playbackMarker.current.setLatLng(pos);
        playbackMarker.current.setIcon(playbackIcon);
      } else {
        playbackMarker.current = L.marker(pos, { icon: playbackIcon }).addTo(leafletMap.current);
      }

      leafletMap.current.setView(pos, leafletMap.current.getZoom(), { animate: true });
    }
  };

  // Auto-play history timeline
  useEffect(() => {
    if (isPlayingHistory) {
      playbackIntervalRef.current = setInterval(() => {
        setPlaybackIndex(prev => {
          const next = prev + 1;
          if (next >= history.length) {
            setIsPlayingHistory(false);
            return prev;
          }
          handleTimelineChange(next);
          return next;
        });
      }, 800);
    } else {
      if (playbackIntervalRef.current) clearInterval(playbackIntervalRef.current);
    }

    return () => {
      if (playbackIntervalRef.current) clearInterval(playbackIntervalRef.current);
    };
  }, [isPlayingHistory, history]);

  // Clean playback marker when closing slider or resetting
  const resetPlayback = () => {
    setIsPlayingHistory(false);
    setPlaybackIndex(-1);
    if (playbackMarker.current) {
      playbackMarker.current.remove();
      playbackMarker.current = null;
    }
    if (leafletMap.current && currentLocation) {
      leafletMap.current.setView([currentLocation.lat, currentLocation.lng], leafletMap.current.getZoom());
    }
  };


  // --- CHILD SENDER LOGIC ---
  const getBatteryLevel = async () => {
    if (typeof window !== 'undefined' && 'getBattery' in navigator) {
      try {
        const battery = await (navigator as any).getBattery();
        return Math.round(battery.level * 100);
      } catch (e) {
        return 100;
      }
    }
    return 100;
  };

  const startChildTracking = async () => {
    if (!('geolocation' in navigator)) {
      setTrackingError('이 브라우저는 GPS를 지원하지 않습니다.');
      return;
    }

    setTrackingError('');
    setIsTracking(true);

    const sendUpdate = async (position: GeolocationPosition) => {
      const { latitude, longitude, speed, heading, accuracy } = position.coords;
      const battery = await getBatteryLevel();

      try {
        const res = await fetch('/api/location/update', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${passcode}`
          },
          body: JSON.stringify({
            lat: latitude,
            lng: longitude,
            speed: speed,
            heading: heading,
            accuracy: accuracy,
            battery: battery,
            timestamp: new Date().toISOString()
          })
        });

        if (res.ok) {
          const data = await res.json();
          setCurrentLocation(data.data);
          setUpdatesSent(prev => prev + 1);
        } else {
          setTrackingError('서버 전송 중 에러가 발생했습니다.');
        }
      } catch (e) {
        setTrackingError('네트워크 연결이 끊겼습니다.');
      }
    };

    // Immediate initial push
    navigator.geolocation.getCurrentPosition(
      sendUpdate,
      (err) => setTrackingError(`GPS 접근 실패: ${err.message}`),
      { enableHighAccuracy: true }
    );

    // Watch position
    watchIdRef.current = navigator.geolocation.watchPosition(
      sendUpdate,
      (err) => setTrackingError(`위치 관측 실패: ${err.message}`),
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  };

  const stopChildTracking = () => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setIsTracking(false);
  };

  // Toggle Screen Wake Lock
  const toggleWakeLock = async () => {
    if (!('wakeLock' in navigator)) {
      alert('이 기기는 화면 켜짐 유지(Wake Lock) API를 지원하지 않습니다.');
      return;
    }

    try {
      if (wakeLockActive && wakeLockObj) {
        await wakeLockObj.release();
        setWakeLockObj(null);
        setWakeLockActive(false);
      } else {
        const lock = await (navigator as any).wakeLock.request('screen');
        setWakeLockObj(lock);
        setWakeLockActive(true);
        
        lock.addEventListener('release', () => {
          setWakeLockActive(false);
          setWakeLockObj(null);
        });
      }
    } catch (err: any) {
      console.error(`Wake Lock error: ${err.message}`);
    }
  };

  // Clean up child resources on unmount
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
      if (wakeLockObj) {
        wakeLockObj.release();
      }
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
    };
  }, [wakeLockObj]);


  // === RENDER GATE 1: AUTHENTICATION ===
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center relative px-4 bg-dark-950 overflow-hidden">
        {/* Glowing Ambient Background Circles */}
        <div className="absolute top-[-10%] left-[-10%] w-[50vw] h-[50vw] rounded-full bg-primary-500/10 blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[50vw] h-[50vw] rounded-full bg-indigo-500/10 blur-[120px]" />

        <div className="w-full max-w-md relative z-10">
          <div className="glass-panel-heavy rounded-3xl p-8 shadow-2xl relative overflow-hidden">
            {/* Design header */}
            <div className="flex justify-center mb-6">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-primary-500 to-indigo-500 flex items-center justify-center shadow-xl shadow-primary-500/30 animate-pulse-slow">
                <Shield className="w-8 h-8 text-white" />
              </div>
            </div>

            <h1 className="text-3xl font-extrabold text-center tracking-tight mb-2">
              <span className="bg-gradient-to-r from-primary-400 to-indigo-300 bg-clip-text text-transparent">AxialSafe</span>
            </h1>
            <p className="text-dark-400 text-sm text-center mb-8">
              가족의 위치를 실시간으로 확인하는 사설 보안 시스템
            </p>

            <form onSubmit={handleLogin} className="space-y-5">
              <div>
                <label className="block text-xs font-semibold text-dark-300 uppercase tracking-wider mb-2">
                  접근 패스코드 입력
                </label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-dark-500">
                    <Lock className="w-5 h-5" />
                  </span>
                  <input
                    type="password"
                    value={passcode}
                    onChange={(e) => setPasscode(e.target.value)}
                    placeholder="패스코드를 입력하세요"
                    className="w-full glass-input rounded-xl py-3.5 pl-11 pr-4 text-center text-lg tracking-widest font-bold placeholder:tracking-normal placeholder:font-normal"
                    autoFocus
                  />
                </div>
                {loginError && (
                  <p className="text-red-400 text-xs mt-2 flex items-center gap-1.5 justify-center">
                    <AlertTriangle className="w-4 h-4" /> {loginError}
                  </p>
                )}
              </div>

              <button
                type="submit"
                className="w-full bg-gradient-to-r from-primary-600 to-indigo-600 hover:from-primary-500 hover:to-indigo-500 text-white font-semibold py-3.5 rounded-xl transition duration-300 shadow-lg shadow-primary-900/30 active:scale-[0.98]"
              >
                시스템 접속
              </button>
            </form>

            <div className="mt-8 border-t border-dark-800/50 pt-4 text-center">
              <span className="text-[11px] text-dark-600">
                AxialSafe &copy; 2026 &middot; Private Location Tracking System
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // === RENDER GATE 2: MODE SELECT ===
  if (role === 'select') {
    return (
      <div className="min-h-screen flex items-center justify-center relative px-4 bg-dark-950 overflow-hidden">
        {/* Glow rings */}
        <div className="absolute top-[-10%] right-[-10%] w-[45vw] h-[45vw] rounded-full bg-purple-500/10 blur-[100px]" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[45vw] h-[45vw] rounded-full bg-primary-500/10 blur-[100px]" />

        <div className="w-full max-w-2xl relative z-10">
          <div className="flex justify-between items-center mb-6">
            <div className="flex items-center gap-2">
              <Shield className="w-6 h-6 text-primary-500" />
              <span className="font-bold text-lg tracking-wider text-dark-200">AxialSafe</span>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-dark-900 hover:bg-dark-800 border border-dark-800 text-xs text-dark-400 hover:text-white transition"
            >
              <LogOut className="w-3.5 h-3.5" />
              로그아웃
            </button>
          </div>

          <h2 className="text-3xl sm:text-4xl font-extrabold text-center mb-2 tracking-tight">
            사용 모드 선택
          </h2>
          <p className="text-center text-dark-400 text-sm sm:text-base mb-10">
            기기의 사용 목적에 맞게 인터페이스를 선택해 주세요.
          </p>

          <div className="grid md:grid-cols-2 gap-6">
            {/* Mode 1: Parent Dashboard */}
            <button
              onClick={() => setRole('parent')}
              className="group text-left glass-panel rounded-3xl p-8 border border-dark-800 hover:border-primary-500/40 shadow-xl hover:shadow-primary-500/5 transition duration-300 relative overflow-hidden flex flex-col justify-between h-[260px] active:scale-[0.98]"
            >
              <div className="absolute top-0 right-0 w-32 h-32 bg-primary-500/5 rounded-bl-[120px] transition duration-300 group-hover:bg-primary-500/10" />
              <div className="w-12 h-12 rounded-2xl bg-primary-950/60 border border-primary-500/20 flex items-center justify-center text-primary-400 mb-6 group-hover:scale-110 transition duration-300">
                <Shield className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-white mb-2 group-hover:text-primary-300 transition duration-200">
                  부모 관리자 모드
                </h3>
                <p className="text-dark-400 text-sm leading-relaxed">
                  자녀의 현재 실시간 위치를 관제하고, 이동 경로 히스토리 및 안전구역 이탈 알림을 수신하는 모니터링 화면입니다.
                </p>
              </div>
            </button>

            {/* Mode 2: Child GPS Reporter */}
            <button
              onClick={() => setRole('child')}
              className="group text-left glass-panel rounded-3xl p-8 border border-dark-800 hover:border-emerald-500/40 shadow-xl hover:shadow-emerald-500/5 transition duration-300 relative overflow-hidden flex flex-col justify-between h-[260px] active:scale-[0.98]"
            >
              <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 rounded-bl-[120px] transition duration-300 group-hover:bg-emerald-500/10" />
              <div className="w-12 h-12 rounded-2xl bg-emerald-950/60 border border-emerald-500/20 flex items-center justify-center text-emerald-400 mb-6 group-hover:scale-110 transition duration-300">
                <Navigation className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-white mb-2 group-hover:text-emerald-300 transition duration-200">
                  자녀 위치 송신기 모드
                </h3>
                <p className="text-dark-400 text-sm leading-relaxed">
                  자녀 스마트폰에 설치하여 실시간 GPS 위치 데이터를 서버로 안전하게 전송하는 송신기용 화면입니다.
                </p>
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // === RENDER GATE 3: CHILD SENDER PAGE ===
  if (role === 'child') {
    if (isBlackScreen) {
      return (
        <div 
          className="fixed inset-0 bg-black z-[9999] flex flex-col items-center justify-center select-none cursor-none"
          onTouchStart={handleBlackScreenTouchStart}
          onTouchEnd={handleBlackScreenTouchEnd}
          onMouseDown={handleBlackScreenTouchStart}
          onMouseUp={handleBlackScreenTouchEnd}
        >
          <div className="text-center opacity-[0.03] hover:opacity-10 transition-opacity duration-500 px-6 pointer-events-none">
            <Shield className="w-12 h-12 mx-auto mb-4 text-emerald-500" />
            <p className="text-sm font-semibold text-white">화면 잠금 및 절전 모드 작동 중</p>
            <p className="text-xs text-dark-400 mt-1">화면을 2초간 길게 누르면 잠금이 해제됩니다.</p>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-dark-950 flex flex-col justify-between p-4 overflow-y-auto">
        {/* Child Header */}
        <div className="flex justify-between items-center glass-panel rounded-2xl px-5 py-4 mb-6">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping"></span>
            <span className="font-extrabold text-sm tracking-widest text-emerald-400">TRACKER ACTIVE</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setRole('select')}
              className="px-3 py-1.5 rounded-xl bg-dark-900 border border-dark-800 text-xs text-dark-300 hover:text-white"
            >
              이전으로
            </button>
            <button
              onClick={handleLogout}
              className="p-1.5 rounded-xl bg-dark-900 border border-dark-800 text-xs text-red-400 hover:text-red-300"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Main Status & Tracker Toggle Button */}
        <div className="flex-1 flex flex-col items-center justify-center max-w-md mx-auto w-full my-4">
          <div className="text-center mb-6">
            <h2 className="text-2xl font-bold text-white mb-1">자녀 기기 송신기</h2>
            <p className="text-xs text-dark-400">아래 버튼을 눌러 위치 공유를 시작하거나 중지하세요.</p>
          </div>

          {/* Big Transmitter Button */}
          <button
            onClick={isTracking ? stopChildTracking : startChildTracking}
            className={`w-48 h-48 rounded-full flex flex-col items-center justify-center transition-all duration-500 border-4 focus:outline-none select-none active:scale-95 ${
              isTracking 
                ? 'bg-emerald-950/40 border-emerald-500 text-emerald-400 neon-glow-primary animate-glow-pulse' 
                : 'bg-dark-900 border-dark-800 text-dark-500'
            }`}
          >
            <Navigation className={`w-14 h-14 mb-2 ${isTracking ? 'animate-bounce text-emerald-400' : 'text-dark-600'}`} />
            <span className="font-bold text-lg">{isTracking ? '위치 전송 중' : '전송 시작'}</span>
            <span className="text-[10px] mt-1 opacity-70">
              {isTracking ? `${updatesSent}회 전송됨` : '꺼짐 상태'}
            </span>
          </button>

          {/* Tracking Errors */}
          {trackingError && (
            <div className="mt-6 glass-panel border-red-500/20 rounded-xl p-3 text-center text-red-400 text-xs w-full flex items-center justify-center gap-1.5">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>{trackingError}</span>
            </div>
          )}

          {/* Real-time Status Card */}
          <div className="w-full glass-panel rounded-2xl p-5 mt-8 space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-dark-400 border-b border-dark-800 pb-2">
              실시간 상태 정보
            </h3>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-dark-900/60 rounded-xl p-3 border border-dark-800/40">
                <div className="flex items-center gap-1.5 text-dark-400 text-xs mb-1">
                  <Battery className="w-3.5 h-3.5" /> 배터리 잔량
                </div>
                <div className="text-lg font-bold text-white">
                  {currentLocation ? `${currentLocation.battery}%` : '조회 중'}
                </div>
              </div>

              <div className="bg-dark-900/60 rounded-xl p-3 border border-dark-800/40">
                <div className="flex items-center gap-1.5 text-dark-400 text-xs mb-1">
                  <Signal className="w-3.5 h-3.5" /> GPS 정확도
                </div>
                <div className="text-lg font-bold text-white">
                  {currentLocation ? `±${Math.round(currentLocation.accuracy)}m` : '측정 중'}
                </div>
              </div>
            </div>

            {/* Wake Lock Toggle Switch */}
            <div className="flex items-center justify-between bg-dark-900/60 rounded-xl p-3.5 border border-dark-800/40">
              <div className="flex flex-col">
                <span className="text-sm font-semibold text-white">화면 켜짐 유지</span>
                <span className="text-[10px] text-dark-500">배경 대기 모드 멈춤 방지</span>
              </div>
              <button
                onClick={toggleWakeLock}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                  wakeLockActive ? 'bg-emerald-500' : 'bg-dark-800'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    wakeLockActive ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {/* Black Screen Power Saving Mode */}
            <div className="flex items-center justify-between bg-dark-900/60 rounded-xl p-3.5 border border-dark-800/40 mt-3">
              <div className="flex flex-col">
                <span className="text-sm font-semibold text-white">블랙스크린 절전 모드</span>
                <span className="text-[10px] text-dark-500">화면을 어둡게 잠궈 백그라운드 전송 유지</span>
              </div>
              <button
                onClick={enterBlackScreen}
                disabled={!isTracking}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  isTracking
                    ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-900/30'
                    : 'bg-dark-800 text-dark-600 cursor-not-allowed'
                }`}
              >
                모드 시작
              </button>
            </div>
          </div>

          {/* Samsung Optimization Guide Accordion */}
          <div className="w-full glass-panel rounded-2xl p-5 mt-4">
            <h3 className="text-xs font-bold text-white flex items-center gap-1.5 mb-2">
              <Info className="w-3.5 h-3.5 text-indigo-400" />
              갤럭시 백그라운드 수신 유지 안내
            </h3>
            <p className="text-[11px] text-dark-400 leading-relaxed">
              위치 전송이 화면이 꺼진 후 중단된다면 아래 설정을 적용해 주세요:
            </p>
            <ol className="list-decimal list-inside text-[11px] text-dark-300 space-y-1 mt-2.5 font-medium pl-1">
              <li>휴대폰의 <strong className="text-indigo-300">설정 &gt; 애플리케이션</strong>으로 이동합니다.</li>
              <li>위치 전송 브라우저(예: <strong className="text-indigo-300">Chrome</strong>)를 선택합니다.</li>
              <li><strong className="text-indigo-300">배터리</strong>를 탭한 뒤 <strong className="text-emerald-400">제한 없음(Unrestricted)</strong>으로 변경합니다.</li>
            </ol>
          </div>
        </div>

        {/* Child Footer */}
        <div className="text-center py-4 text-[10px] text-dark-600 mt-4 border-t border-dark-900">
          AxialSafe Child Client &middot; Private Server Link
        </div>
      </div>
    );
  }

  // === RENDER GATE 4: PARENT MONITORING DASHBOARD ===
  return (
    <div className="h-screen w-screen flex flex-col md:flex-row bg-dark-950 relative overflow-hidden">
      
      {/* 1. MAP SECTION (FILLS SCREEN) */}
      <div className="flex-1 h-[50vh] md:h-screen w-full relative dark-map z-0">
        <div ref={mapRef} className="h-full w-full" />
        
        {/* Floating Quick Map Buttons */}
        <div className="absolute top-4 left-4 z-[40] flex flex-col gap-2">
          {/* Status Alert Badge */}
          {geofences.length > 0 && (
            <div className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl shadow-2xl backdrop-blur-md border ${
              isOutsideAllZones 
                ? 'bg-red-950/80 border-red-500/40 text-red-200 animate-glow-pulse-danger' 
                : 'bg-dark-950/80 border-emerald-500/30 text-emerald-300'
            }`}>
              {isOutsideAllZones ? (
                <>
                  <AlertTriangle className="w-4 h-4 text-red-400 animate-bounce" />
                  <span className="text-xs font-bold tracking-tight">안심구역 이탈 경보!</span>
                </>
              ) : (
                <>
                  <Shield className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-semibold">
                    {status.activeZones.length > 0 ? `${status.activeZones.join(', ')} 내부` : '구역 안전 상태'}
                  </span>
                </>
              )}
            </div>
          )}

          {/* WebSockets Link Indicator */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-dark-950/80 border border-dark-800 text-[11px] text-dark-300 backdrop-blur-md">
            <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
            <span>{wsConnected ? '실시간 연동 중' : '서버 오프라인'}</span>
          </div>
        </div>

        {/* Floating Bottom Center Timeline (Desktop) / Action Bar */}
        {history.length > 0 && (
          <div className="absolute bottom-4 left-4 right-4 md:right-[380px] z-[40] glass-panel rounded-2xl p-4 shadow-2xl backdrop-blur-md flex flex-col gap-3">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-primary-400" />
                <span className="text-xs font-bold text-white">경로 타임라인 재생</span>
                {playbackIndex !== -1 && (
                  <span className="text-[10px] bg-primary-950 text-primary-300 border border-primary-500/20 px-2 py-0.5 rounded-full">
                    {new Date(history[playbackIndex].timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                  </span>
                )}
              </div>
              
              <div className="flex gap-2">
                {playbackIndex !== -1 && (
                  <button 
                    onClick={resetPlayback}
                    className="text-[10px] text-dark-400 hover:text-white px-2 py-1 bg-dark-900 border border-dark-800 rounded-lg"
                  >
                    초기화
                  </button>
                )}
                <button
                  onClick={() => setIsPlayingHistory(!isPlayingHistory)}
                  className="flex items-center gap-1 text-[10px] text-white px-2.5 py-1 bg-primary-600 hover:bg-primary-500 rounded-lg transition"
                >
                  {isPlayingHistory ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                  {isPlayingHistory ? '일시정지' : '자동재생'}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <input
                type="range"
                min="0"
                max={history.length - 1}
                value={playbackIndex === -1 ? history.length - 1 : playbackIndex}
                onChange={(e) => handleTimelineChange(Number(e.target.value))}
                className="flex-1 accent-primary-500 h-1.5 bg-dark-900 rounded-lg cursor-pointer"
              />
              <span className="text-[10px] text-dark-500 font-mono">
                {playbackIndex === -1 ? history.length : playbackIndex + 1}/{history.length}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* 2. SIDEBAR PANEL (STATUS & CONTROLS) */}
      <div className="w-full md:w-[360px] h-[50vh] md:h-screen glass-panel-heavy border-t md:border-t-0 md:border-l border-dark-800 flex flex-col justify-between z-10 shadow-2xl">
        
        {/* Panel Header */}
        <div className="p-4 border-b border-dark-800/60 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary-500" />
            <h1 className="font-extrabold text-base tracking-tight text-white">AxialSafe 관제</h1>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setIsMuted(!isMuted)}
              className={`p-1.5 rounded-lg border transition ${
                isMuted 
                  ? 'bg-red-950/20 border-red-500/20 text-red-400' 
                  : 'bg-dark-900 border-dark-800 text-dark-400 hover:text-white'
              }`}
              title={isMuted ? '음소거 해제' : '음소거'}
            >
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <button
              onClick={() => setRole('select')}
              className="p-1.5 rounded-lg bg-dark-900 border border-dark-800 text-xs text-dark-400 hover:text-white transition"
              title="모드 전환"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={handleLogout}
              className="p-1.5 rounded-lg bg-dark-900 border border-dark-800 text-xs text-red-400 hover:text-red-300 transition"
              title="로그아웃"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Panel Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          
          {/* Widget 1: Child Device Status */}
          <div className="bg-dark-900/40 rounded-2xl p-4 border border-dark-800/40">
            <div className="flex items-center justify-between mb-3 border-b border-dark-800/40 pb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-dark-400 flex items-center gap-1.5">
                <Compass className="w-3.5 h-3.5 text-primary-400" /> 기기 상태 정보
              </span>
              {currentLocation && (
                <button
                  onClick={centerMapOnChild}
                  className="text-[10px] text-primary-400 hover:text-primary-300 flex items-center gap-1"
                >
                  <MapPin className="w-3 h-3" /> 지도 중앙
                </button>
              )}
            </div>

            {currentLocation ? (
              <div className="space-y-3.5">
                {/* Lat/Lng detail */}
                <div className="flex justify-between items-center">
                  <span className="text-xs text-dark-400">최근 좌표</span>
                  <span className="text-xs text-white font-mono">{currentLocation.lat.toFixed(5)}, {currentLocation.lng.toFixed(5)}</span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {/* Battery */}
                  <div className="bg-dark-950/60 rounded-xl p-3 border border-dark-900 flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${
                      currentLocation.battery > 50 
                        ? 'bg-emerald-950/40 text-emerald-400' 
                        : currentLocation.battery > 20 
                          ? 'bg-amber-950/40 text-amber-400' 
                          : 'bg-red-950/40 text-red-400 animate-pulse'
                    }`}>
                      <Battery className="w-5 h-5" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] text-dark-500">배터리</span>
                      <span className="text-sm font-bold text-white">{currentLocation.battery}%</span>
                    </div>
                  </div>

                  {/* GPS Accuracy */}
                  <div className="bg-dark-950/60 rounded-xl p-3 border border-dark-900 flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${
                      currentLocation.accuracy < 15 
                        ? 'bg-emerald-950/40 text-emerald-400' 
                        : currentLocation.accuracy < 50 
                          ? 'bg-amber-950/40 text-amber-400' 
                          : 'bg-red-950/40 text-red-400'
                    }`}>
                      <Signal className="w-5 h-5" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] text-dark-500">GPS 오차</span>
                      <span className="text-sm font-bold text-white">±{Math.round(currentLocation.accuracy)}m</span>
                    </div>
                  </div>
                </div>

                {/* Updates clock info */}
                <div className="flex justify-between items-center text-[11px] text-dark-500 bg-dark-950/40 p-2 rounded-lg border border-dark-900">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" /> 최종 수신
                  </span>
                  <span>{new Date(currentLocation.timestamp).toLocaleTimeString()}</span>
                </div>
              </div>
            ) : (
              <div className="py-6 text-center text-xs text-dark-500 flex flex-col items-center gap-2">
                <Navigation className="w-8 h-8 text-dark-700 animate-pulse" />
                수신된 위치 데이터가 없습니다.<br />자녀 기기에서 위치 전송을 시작해 주세요.
              </div>
            )}
          </div>

          {/* Widget 2: Geofence Safe Zones Manager */}
          <div className="bg-dark-900/40 rounded-2xl p-4 border border-dark-800/40">
            <div className="flex items-center justify-between mb-3 border-b border-dark-800/40 pb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-dark-400 flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-primary-400" /> 안심구역 목록
              </span>
              <button
                onClick={() => setAddGeofenceMode(!addGeofenceMode)}
                className={`text-[10px] px-2 py-1 rounded-lg transition ${
                  addGeofenceMode 
                    ? 'bg-purple-600 text-white font-bold animate-pulse' 
                    : 'bg-dark-900 text-primary-400 border border-dark-800 hover:text-white'
                }`}
              >
                {addGeofenceMode ? '지도 클릭대기...' : '+ 구역추가'}
              </button>
            </div>

            {addGeofenceMode && (
              <div className="mb-3 p-2 bg-purple-950/20 border border-purple-500/20 rounded-xl text-center text-[10px] text-purple-300">
                구역의 중심이 될 지도의 지점을 마우스로 클릭해 주세요.
              </div>
            )}

            {geofences.length > 0 ? (
              <div className="space-y-2">
                {geofences.map(zone => {
                  const dist = currentLocation ? getDistance(currentLocation.lat, currentLocation.lng, zone.lat, zone.lng) : null;
                  const isInside = dist !== null ? dist <= zone.radius : false;
                  
                  return (
                    <div key={zone.id} className="flex justify-between items-center bg-dark-950/50 rounded-xl p-3 border border-dark-900">
                      <div className="flex flex-col">
                        <span className="text-xs font-bold text-white flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full ${isInside ? 'bg-emerald-500 animate-pulse' : 'bg-dark-600'}`} />
                          {zone.name}
                        </span>
                        <span className="text-[10px] text-dark-500">반경 {zone.radius}m</span>
                      </div>

                      <div className="flex items-center gap-3">
                        {dist !== null && (
                          <span className={`text-[10px] font-bold ${isInside ? 'text-emerald-400' : 'text-dark-500'}`}>
                            {isInside ? '내부' : `${Math.round(dist)}m 밖`}
                          </span>
                        )}
                        <button
                          onClick={() => handleDeleteGeofence(zone.id)}
                          className="text-dark-500 hover:text-red-400 p-1 transition"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="py-4 text-center text-[11px] text-dark-500">
                설정된 안심구역이 없습니다.
              </div>
            )}
          </div>

          {/* Widget 3: Management Utility */}
          <div className="bg-dark-900/40 rounded-2xl p-4 border border-dark-800/40 flex justify-between items-center">
            <span className="text-xs text-dark-400">데이터 청소</span>
            <button
              onClick={handleClearHistory}
              disabled={history.length === 0}
              className="text-[10px] text-red-400 hover:text-red-300 bg-red-950/20 border border-red-500/20 hover:border-red-500/40 px-2.5 py-1.5 rounded-xl disabled:opacity-40 transition"
            >
              이동 기록 전체 삭제
            </button>
          </div>
        </div>

        {/* Panel Footer */}
        <div className="p-4 border-t border-dark-800/60 text-center">
          <span className="text-[10px] text-dark-600">
            AxialSafe Parent Console &middot; Private System
          </span>
        </div>
      </div>

      {/* 3. ADD GEOFENCE CONFIG MODAL */}
      {showGeofenceModal && (
        <div className="fixed inset-0 bg-dark-950/70 backdrop-blur-sm z-[99] flex items-center justify-center p-4">
          <div className="w-full max-w-sm glass-panel-heavy rounded-2xl p-6 shadow-2xl">
            <div className="flex items-center gap-2 mb-4 border-b border-dark-800 pb-2">
              <Shield className="w-5 h-5 text-primary-500" />
              <h2 className="text-base font-bold text-white">안심구역(지오펜스) 추가</h2>
            </div>
            
            <form onSubmit={handleAddGeofence} className="space-y-4">
              <div>
                <label className="block text-xs text-dark-400 mb-1.5">구역 이름</label>
                <input
                  type="text"
                  required
                  value={newGeofence.name}
                  onChange={(e) => setNewGeofence(g => ({ ...g, name: e.target.value }))}
                  placeholder="예: 학교, 학원, 집"
                  className="w-full glass-input rounded-xl px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs text-dark-400 mb-1.5">반경 (미터)</label>
                <input
                  type="number"
                  required
                  min="30"
                  max="1000"
                  value={newGeofence.radius}
                  onChange={(e) => setNewGeofence(g => ({ ...g, radius: Number(e.target.value) }))}
                  placeholder="100"
                  className="w-full glass-input rounded-xl px-3 py-2 text-sm"
                />
              </div>

              <div className="text-[11px] text-dark-500 bg-dark-950 p-2.5 rounded-lg border border-dark-900 font-mono">
                위도: {newGeofence.lat.toFixed(6)}<br />
                경도: {newGeofence.lng.toFixed(6)}
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowGeofenceModal(false)}
                  className="flex-1 bg-dark-900 hover:bg-dark-800 border border-dark-800 text-dark-300 text-xs py-2 rounded-xl"
                >
                  취소
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-primary-600 hover:bg-primary-500 text-white text-xs py-2 rounded-xl font-bold"
                >
                  구역 저장
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
