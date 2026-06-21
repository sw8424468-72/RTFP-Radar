import RadarScanner from './radar-scanner.js';

const RSS_FEEDS = [];
const TOOL_ENDPOINT_BASE = '/api/radar';
const DEFAULT_RADIUS = 250;
const STACK_RINGS = 2;
const PER_RING = 8;

const map = L.map('map').setView([34.2, -77.9], 9);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);

const placeBtn = document.getElementById('place-node');
const startBtn = document.getElementById('start-scan');
const stopBtn = document.getElementById('stop-scan');
const nightToggle = document.getElementById('night-toggle');
const wheelEl = document.getElementById('tool-wheel');

const scanner = new RadarScanner({ rssFeeds: RSS_FEEDS });

let radar = {
  centerMarker: null,
  circle: null,
  blipMarkers: [],
  sweepLayer: null,
  isRunning: false,
  animationHandle: null,
  sweepAngle: 0,
  nightVision: false,
  blips: [],
  scanLoopHandle: null
};

function openToolWheel() { wheelEl.classList.remove('closed'); wheelEl.classList.add('open'); wheelEl.setAttribute('aria-hidden','false'); }
function closeToolWheel() { wheelEl.classList.remove('open'); wheelEl.classList.add('closed'); wheelEl.setAttribute('aria-hidden','true'); }
function renderToolWheelItems(cards) {
  wheelEl.innerHTML = '';
  const n = cards.length;
  if (n === 0) { closeToolWheel(); return; }
  const cx = 110, cy = 110, radius = 78;
  cards.forEach((card, i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI/2;
    const x = Math.round(cx + Math.cos(angle)*radius - 44);
    const y = Math.round(cy + Math.sin(angle)*radius - 34);
    const el = document.createElement('div');
    el.className = 'tool-item';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    const title = document.createElement('div'); title.className='title';
    title.textContent = card.stations && card.stations.length ? (card.stations[0].id || card.stations[0].name) : `Blip ${i+1}`;
    const meta = document.createElement('small');
    meta.textContent = `${card.stationCount} stations • ${card.rssCount} feeds`;
    const btn = document.createElement('button');
    btn.textContent = 'Open';
    btn.onclick = () => {
      const uri = generateEndpointURI(TOOL_ENDPOINT_BASE, card);
      fetch(uri).then(r => { if (!r.ok) throw new Error('no-server'); return r.json(); }).then(json => {
        const blob = new Blob([JSON.stringify(json, null, 2)], {type:'application/json'});
        window.open(URL.createObjectURL(blob), '_blank');
      }).catch(()=>{
        const blob = new Blob([JSON.stringify(card, null, 2)], {type:'application/json'});
        window.open(URL.createObjectURL(blob), '_blank');
      });
    };
    el.appendChild(title); el.appendChild(meta); el.appendChild(btn);
    wheelEl.appendChild(el);
  });
  openToolWheel();
}

function generateEndpointURI(base, card) {
  const p = new URLSearchParams();
  p.set('blipId', card.blipId);
  p.set('lat', card.center.lat.toFixed(6));
  p.set('lon', card.center.lon.toFixed(6));
  p.set('radius', card.radius || DEFAULT_RADIUS);
  p.set('ts', encodeURIComponent(card.foundAt));
  if (card.stations && card.stations.length) p.set('stationIds', card.stations.map(s => s.id || s.name).join(','));
  return `${base}?${p.toString()}`;
}

function clearRadarGraphics() {
  if (radar.centerMarker) { map.removeLayer(radar.centerMarker); radar.centerMarker = null; }
  if (radar.circle) { map.removeLayer(radar.circle); radar.circle = null; }
  radar.blipMarkers.forEach(m => map.removeLayer(m)); radar.blipMarkers = [];
  if (radar.sweepLayer && radar.sweepLayer.parentNode) { radar.sweepLayer.parentNode.removeChild(radar.sweepLayer); radar.sweepLayer = null; }
  radar.blips = [];
}

function placeNodeOnMap(latlng) {
  clearRadarGraphics();
  radar.centerMarker = L.marker(latlng, {draggable:true}).addTo(map);
  radar.circle = L.circle(latlng, { radius: DEFAULT_RADIUS, color: radar.nightVision ? '#39ff14' : '#f00', weight: 1 }).addTo(map);
  radar.centerMarker.on('drag', e => { const ll = e.target.getLatLng(); radar.circle.setLatLng(ll); updateBlipMarkers(); });
  radar.circle.on('dblclick', () => { const newR = radar.circle.getRadius() === DEFAULT_RADIUS ? DEFAULT_RADIUS * 2 : DEFAULT_RADIUS; radar.circle.setRadius(newR); updateBlipMarkers(); });
}

function buildStackBlips(center, baseRadius, rings = STACK_RINGS, perRing = PER_RING) {
  const blips = [];
  blips.push({ lat: center.lat, lon: center.lon, radius: baseRadius });
  for (let r = 1; r <= rings; r++) {
    const ringRadius = baseRadius * r;
    for (let k = 0; k < perRing; k++) {
      const angle = (k / perRing) * Math.PI * 2;
      const dy = Math.cos(angle) * ringRadius;
      const dx = Math.sin(angle) * ringRadius;
      const dLat = (dy / 111320);
      const dLon = dx / (111320 * Math.cos(center.lat * Math.PI/180));
      blips.push({ lat: center.lat + dLat, lon: center.lon + dLon, radius: baseRadius });
    }
  }
  return blips;
}

function updateBlipMarkers() {
  radar.blipMarkers.forEach(m => map.removeLayer(m)); radar.blipMarkers = [];
  radar.blips.forEach(b => {
    const m = L.circleMarker([b.lat, b.lon], { radius: 6, fillColor: radar.nightVision ? '#40ff40' : '#ff4500', color: '#000', weight: 0.8, fillOpacity: 0.85 }).addTo(map);
    radar.blipMarkers.push(m);
  });
}

function createSweepLayer() {
  if (radar.sweepLayer) return;
  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute'; canvas.style.pointerEvents = 'none';
  canvas.width = map.getSize().x; canvas.height = map.getSize().y;
  radar.sweepLayer = canvas; map.getPanes().overlayPane.appendChild(canvas);
  map.on('move resize zoom', () => { canvas.width = map.getSize().x; canvas.height = map.getSize().y; });
}

function drawSweep() {
  if (!radar.sweepLayer || !radar.circle) return;
  const canvas = radar.sweepLayer; const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const centerPt = map.latLngToContainerPoint(radar.circle.getLatLng());
  const maxPxRadius = map.latLngToContainerPoint([radar.circle.getLatLng().lat + (radar.circle.getRadius()/111320), radar.circle.getLatLng().lng]).y - centerPt.y;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = radar.nightVision ? 'rgba(0,16,0,0.06)' : 'rgba(255,255,255,0.02)';
  ctx.beginPath(); ctx.arc(centerPt.x, centerPt.y, Math.abs(maxPxRadius), 0, Math.PI*2); ctx.fill();
  const sweepWidth = 0.20; const start = radar.sweepAngle - sweepWidth/2; const end = radar.sweepAngle + sweepWidth/2;
  ctx.beginPath();
  const grad = ctx.createRadialGradient(centerPt.x, centerPt.y, 0, centerPt.x, centerPt.y, Math.abs(maxPxRadius));
  if (radar.nightVision) { grad.addColorStop(0,'rgba(90,255,90,0.28)'); grad.addColorStop(1,'rgba(0,40,0,0.04)'); }
  else { grad.addColorStop(0,'rgba(255,160,50,0.28)'); grad.addColorStop(1,'rgba(255,160,50,0.02)'); }
  ctx.fillStyle = grad; ctx.moveTo(centerPt.x, centerPt.y); ctx.arc(centerPt.x, centerPt.y, Math.abs(maxPxRadius), start, end); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.fillStyle = radar.nightVision ? '#39ff14' : '#ff3333'; ctx.arc(centerPt.x, centerPt.y, 4, 0, Math.PI*2); ctx.fill();
  radar.blips.forEach(b => { const pt = map.latLngToContainerPoint([b.lat, b.lon]); const angle = Math.atan2(pt.y - centerPt.y, pt.x - centerPt.x); let da = angle - radar.sweepAngle; da = Math.atan2(Math.sin(da), Math.cos(da)); if (Math.abs(da) < sweepWidth/2) { ctx.beginPath(); ctx.fillStyle = radar.nightVision ? 'rgba(120,255,120,0.9)' : 'rgba(255,240,140,0.95)'; ctx.arc(pt.x, pt.y, 6, 0, Math.PI*2); ctx.fill(); }});
}

function animateSweep() { radar.sweepAngle += 0.015; if (radar.sweepAngle > Math.PI*2) radar.sweepAngle -= Math.PI*2; drawSweep(); radar.animationHandle = requestAnimationFrame(animateSweep); }

async function startScanningBlips() {
  if (radar.scanLoopHandle) return; radar.isRunning = true; const results = []; let idx = 0;
  while (radar.isRunning) {
    if (!radar.blips || radar.blips.length === 0) { await new Promise(r => setTimeout(r, 400)); continue; }
    const b = radar.blips[idx % radar.blips.length];
    try {
      const card = await scanner.radialScan({lat:b.lat, lon:b.lon}, b.radius, { timeWindowMinutes: 30, includeRealtime: true, blipId: `blip-${idx}-${Date.now()}` });
      card.radius = b.radius; results[idx % radar.blips.length] = card; renderToolWheelItems(results.filter(Boolean));
    } catch (err) { console.warn('scan failed', err); }
    idx++; await new Promise(r => setTimeout(r, 600));
  }
  radar.scanLoopHandle = null;
}

function startRadarProcess(){ if (!radar.circle || !radar.centerMarker) return; radar.blips = buildStackBlips(radar.circle.getLatLng(), radar.circle.getRadius(), STACK_RINGS, PER_RING); updateBlipMarkers(); createSweepLayer(); radar.sweepAngle = 0; if (!radar.animationHandle) animateSweep(); if (!radar.scanLoopHandle) radar.scanLoopHandle = startScanningBlips(); }

function stopRadarProcess(){ radar.isRunning = false; if (radar.animationHandle) { cancelAnimationFrame(radar.animationHandle); radar.animationHandle = null; } if (radar.sweepLayer) { const ctx = radar.sweepLayer.getContext('2d'); ctx.clearRect(0,0,radar.sweepLayer.width, radar.sweepLayer.height); } }

placeBtn.addEventListener('click', () => { alert('Click on the map to place a node (center of radar).'); const onClick = (e) => { placeNodeOnMap(e.latlng); map.off('click', onClick); }; map.on('click', onClick); });

startBtn.addEventListener('click', () => { if (!radar.circle) { alert('Place a node first.'); return; } radar.nightVision = nightToggle.checked; radar.circle.setStyle({ color: radar.nightVision ? '#39ff14' : '#f00' }); startRadarProcess(); });

stopBtn.addEventListener('click', () => { stopRadarProcess(); });

nightToggle.addEventListener('change', () => { radar.nightVision = nightToggle.checked; if (radar.circle) radar.circle.setStyle({ color: radar.nightVision ? '#39ff14' : '#f00' }); updateBlipMarkers(); });

document.addEventListener('keydown', (e) => { if (e.key === 's') startBtn.click(); else if (e.key === 'x') stopBtn.click(); });

placeNodeOnMap(L.latLng(34.178, -77.972));
