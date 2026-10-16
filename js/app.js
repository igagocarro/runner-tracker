// ── Runner palette ─────────────────────────────────────────────────────────
const PALETTE = [
  '#c45c26','#2a7fc4','#3a7d58','#8b3ab5','#b08a20',
  '#c42671','#1eaaa0','#7a6030','#5060c8','#a04030'
];
const PALETTE_DARK = [
  '#e07040','#4da0e0','#5aaa7e','#b060e0','#d4a72a',
  '#e05090','#30d0c0','#c09850','#7888f0','#d06050'
];

// ── State ──────────────────────────────────────────────────────────────────
let gpxPoints = [];   // [{lat,lon,ele,dist}]
let gpxRaw    = '';   // texto original del GPX (para persistir en localStorage)
let gpxFileName = '';
let totalKm   = 0;
let waypoints = [];   // [{name, km}] shared across runners

// runners[] = [{ id, name, colorIdx, startMs, paceSecPerKm, realPasses:{wpIdx→ms} }]
let runners = [];
let activeRunnerIdx = 0;
let tickInterval = null;
let lastRunnerKms = [];  // km position per runner, updated each tick

let pendingWpKm = null;
let pendingWpMarker = null;
let markingWpIdx   = null;
let markingRunnerIdx = null;

// ── Leaflet map instances ──────────────────────────────────────────────────
let setupMap  = null;
let liveMap   = null;

let setupRouteLine  = null;
let setupWpMarkers  = [];

let liveRouteLine   = null;
let liveRunnerLines = [];
let liveRunnerMkrs  = [];
let liveWpMarkers   = [];

// ── Runner color helpers ───────────────────────────────────────────────────
function runnerColor(r) {
  return isDark() ? PALETTE_DARK[r.colorIdx % PALETTE_DARK.length]
                  : PALETTE[r.colorIdx % PALETTE.length];
}

// ── GPX parsing ────────────────────────────────────────────────────────────
function haversineKm(lat1,lon1,lat2,lon2){
  const R=6371,dLat=(lat2-lat1)*Math.PI/180,dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function parseGPX(text){
  const doc=new DOMParser().parseFromString(text,'application/xml');
  const nodes=doc.querySelectorAll('trkpt,rtept,wpt');
  if(!nodes.length)return null;
  const pts=[];
  nodes.forEach(n=>{
    const lat=parseFloat(n.getAttribute('lat')),lon=parseFloat(n.getAttribute('lon'));
    const ele=n.querySelector('ele');
    if(!isNaN(lat)&&!isNaN(lon))pts.push({lat,lon,ele:ele?parseFloat(ele.textContent):0});
  });
  if(pts.length<2)return null;
  let cum=0;
  pts[0].dist=0;
  for(let i=1;i<pts.length;i++){cum+=haversineKm(pts[i-1].lat,pts[i-1].lon,pts[i].lat,pts[i].lon);pts[i].dist=cum;}
  return pts;
}
function pointAtKm(km){
  if(!gpxPoints.length)return null;
  if(km<=0)return gpxPoints[0];
  if(km>=totalKm)return gpxPoints[gpxPoints.length-1];
  let lo=0,hi=gpxPoints.length-1;
  while(lo<hi-1){const mid=(lo+hi)>>1;gpxPoints[mid].dist<km?lo=mid:hi=mid;}
  const a=gpxPoints[lo],b=gpxPoints[hi],t=(km-a.dist)/(b.dist-a.dist);
  return{lat:a.lat+(b.lat-a.lat)*t,lon:a.lon+(b.lon-a.lon)*t,dist:km};
}
function nearestKmOnRoute(lat,lon){
  let best=Infinity,km=0;
  gpxPoints.forEach(p=>{const d=Math.hypot(p.lat-lat,p.lon-lon);if(d<best){best=d;km=p.dist;}});
  return km;
}
function routeBounds(){
  if(!gpxPoints.length) return null;
  const lats=gpxPoints.map(p=>p.lat), lons=gpxPoints.map(p=>p.lon);
  return L.latLngBounds(
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)]
  );
}
function routeLatLngs(){
  return gpxPoints.map(p=>[p.lat,p.lon]);
}

// ── Dark / accent ──────────────────────────────────────────────────────────
function isDark(){const dt=document.documentElement.getAttribute('data-theme');if(dt==='dark')return true;if(dt==='light')return false;return window.matchMedia('(prefers-color-scheme:dark)').matches;}

// ── OSM tile layer ─────────────────────────────────────────────────────────
function makeTileLayer(){
  const url = isDark()
    ? 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
    : 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}';
  return L.tileLayer(url, {
    attribution: 'Tiles © <a href="https://www.esri.com/">Esri</a>',
    maxZoom: 18
  });
}

// ── Setup map ──────────────────────────────────────────────────────────────
function initSetupMap(){
  if(setupMap) return;
  setupMap = L.map('route-map',{zoomControl:false,attributionControl:true});
  makeTileLayer().addTo(setupMap);
  setupMap.on('click', e=>{
    if(!gpxPoints.length) return;
    const km = nearestKmOnRoute(e.latlng.lat, e.latlng.lng);
    pendingWpKm = km;
    const routePt = pointAtKm(km);
    if(pendingWpMarker) pendingWpMarker.remove();
    pendingWpMarker = L.circleMarker([routePt.lat, routePt.lon], {
      radius: 10, color: '#c45c26', weight: 3,
      fillColor: '#ffffff', fillOpacity: 1
    }).addTo(setupMap);
    setTimeout(()=>{ const el=pendingWpMarker.getElement(); el&&el.classList.add('pending-wp-pulse'); },0);
    const cp = setupMap.latLngToContainerPoint(e.latlng);
    const wrap = document.getElementById('route-canvas-wrap');
    const popup = document.getElementById('wp-pending-popup');
    popup.style.display='block';
    popup.style.left = Math.min(cp.x+12, wrap.clientWidth-200)+'px';
    popup.style.top  = Math.min(cp.y+12, wrap.clientHeight-90)+'px';
    document.getElementById('popup-wp-name').value='';
    document.getElementById('popup-km-label').textContent = km.toFixed(2)+' km del recorrido';
    document.getElementById('popup-wp-name').focus();
  });
}

function drawSetupRoute(){
  if(!setupMap) return;
  if(setupRouteLine){ setupRouteLine.remove(); setupRouteLine=null; }
  setupWpMarkers.forEach(m=>m.remove()); setupWpMarkers=[];

  const col = isDark()?'#6a9fd8':'#2a7fc4';
  setupRouteLine = L.polyline(routeLatLngs(),{color:col,weight:3,opacity:.85}).addTo(setupMap);

  const startIcon = makeDivMarker('Salida', isDark()?'#5aaa7e':'#3a7d58');
  const finishIcon = makeDivMarker('Meta', isDark()?'#9b9690':'#5c5954');
  const sp=gpxPoints[0], ep=gpxPoints[gpxPoints.length-1];
  L.marker([sp.lat,sp.lon],{icon:startIcon,zIndexOffset:100}).addTo(setupMap);
  L.marker([ep.lat,ep.lon],{icon:finishIcon,zIndexOffset:100}).addTo(setupMap);

  refreshSetupWpMarkers();
}

function refreshSetupWpMarkers(){
  if(!setupMap) return;
  setupWpMarkers.forEach(m=>m.remove()); setupWpMarkers=[];
  waypoints.forEach(wp=>{
    const p=pointAtKm(wp.km); if(!p) return;
    const m=L.circleMarker([p.lat,p.lon],{
      radius:5,color:'#fff',weight:1.5,
      fillColor:isDark()?'#9b9690':'#7a7570',fillOpacity:1
    }).bindTooltip(wp.name,{permanent:false,direction:'right',className:'wp-tooltip'}).addTo(setupMap);
    setupWpMarkers.push(m);
  });
}

function fitSetupMap(){
  if(!setupMap||!gpxPoints.length) return;
  const b=routeBounds(); if(b) setupMap.fitBounds(b,{padding:[24,24]});
}

// ── Live map ───────────────────────────────────────────────────────────────
function initLiveMap(){
  if(liveMap){ destroyLiveMapLayers(); return; }
  liveMap = L.map('live-map',{zoomControl:false,attributionControl:true});
  makeTileLayer().addTo(liveMap);
}

function destroyLiveMapLayers(){
  if(liveRouteLine){ liveRouteLine.remove(); liveRouteLine=null; }
  liveRunnerLines.forEach(l=>l&&l.remove()); liveRunnerLines=[];
  liveRunnerMkrs.forEach(m=>m&&m.remove()); liveRunnerMkrs=[];
  liveWpMarkers.forEach(m=>m&&m.remove()); liveWpMarkers=[];
}

function buildLiveMap(){
  if(!liveMap) return;
  destroyLiveMapLayers();

  const dark=isDark();
  const trackCol = dark?'#4a4744':'#c8c4bc';

  liveRouteLine = L.polyline(routeLatLngs(),{color:trackCol,weight:2.5,opacity:1}).addTo(liveMap);

  runners.forEach(r=>{
    const col=runnerColor(r);
    const ln=L.polyline([],{color:col,weight:3.5,opacity:1}).addTo(liveMap);
    liveRunnerLines.push(ln);
  });

  runners.forEach(r=>{
    const col=runnerColor(r);
    const icon=makeRunnerIcon(r.name,col);
    const p=gpxPoints[0];
    const mk=L.marker([p.lat,p.lon],{icon,zIndexOffset:200}).addTo(liveMap);
    liveRunnerMkrs.push(mk);
  });

  waypoints.forEach(wp=>{
    const p=pointAtKm(wp.km); if(!p) return;
    const m=L.circleMarker([p.lat,p.lon],{
      radius:5,color:'#fff',weight:1.5,
      fillColor:isDark()?'#7a7570':'#9b9690',fillOpacity:1
    }).bindTooltip(wp.name,{permanent:false,direction:'right'}).addTo(liveMap);
    liveWpMarkers.push(m);
  });

  fitLiveMap();
}

function updateLiveMap(runnerKms){
  if(!liveMap||!liveRouteLine) return;
  runners.forEach((r,ri)=>{
    const rkm = runnerKms[ri]||0;
    if(liveRunnerLines[ri]){
      const cov = gpxPoints.filter(p=>p.dist<=rkm).map(p=>[p.lat,p.lon]);
      if(rkm>0 && rkm<totalKm){ const ep=pointAtKm(rkm); if(ep) cov.push([ep.lat,ep.lon]); }
      liveRunnerLines[ri].setLatLngs(cov);
    }
    if(liveRunnerMkrs[ri] && rkm>0 && rkm<totalKm){
      const p=pointAtKm(rkm); if(!p) return;
      liveRunnerMkrs[ri].setLatLng([p.lat,p.lon]);
      liveRunnerMkrs[ri].setIcon(makeRunnerIcon(r.name,runnerColor(r)));
    }
  });
}

function fitLiveMap(){
  if(!liveMap||!gpxPoints.length) return;
  const b=routeBounds(); if(b) liveMap.fitBounds(b,{padding:[20,20]});
}

// ── Marker icon builders ───────────────────────────────────────────────────
function makeDivMarker(label, color){
  const html=`<div class="runner-marker-label" style="color:${color};border-color:${color};">
    <div class="runner-marker-dot" style="background:${color};"></div>${label}</div>`;
  return L.divIcon({html,className:'',iconAnchor:[0,10]});
}
function makeRunnerIcon(name, color){
  const html=`<div class="runner-marker-label" style="color:${color};border-color:${color};">
    <div class="runner-marker-dot" style="background:${color};"></div>${name}</div>`;
  return L.divIcon({html,className:'',iconAnchor:[0,10]});
}

// ── File loading ───────────────────────────────────────────────────────────
function loadFile(file){
  if(!file||!file.name.endsWith('.gpx'))return;
  const r=new FileReader();
  r.onload=e=>{
    const pts=parseGPX(e.target.result);
    if(!pts){alert('No se pudo leer el GPX.');return;}
    gpxRaw=e.target.result; gpxFileName=file.name;
    gpxPoints=pts;totalKm=pts[pts.length-1].dist;
    document.getElementById('gpx-name-text').textContent=file.name;
    document.getElementById('gpx-name').style.display='flex';
    document.getElementById('route-preview').style.display='block';
    document.getElementById('route-stats').textContent=`${gpxPoints.length} puntos · ${totalKm.toFixed(2)} km totales`;
    if(waypoints.length===0){
      for(let k=5;k<totalKm;k+=5) waypoints.push({name:`km ${k}`,km:k});
      waypoints.sort((a,b)=>a.km-b.km);
      renderWpList();
      refreshSetupWpMarkers();
    }
    setTimeout(()=>{
      initSetupMap();
      drawSetupRoute();
      fitSetupMap();
    }, 50);
    checkReadyToStart();
    saveConfig();
  };
  r.readAsText(file);
}

const dz=document.getElementById('drop-zone');
dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('dragover');});
dz.addEventListener('dragleave',()=>dz.classList.remove('dragover'));
dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('dragover');loadFile(e.dataTransfer.files[0]);});
document.getElementById('gpx-input').addEventListener('change',e=>loadFile(e.target.files[0]));

// ── Waypoint popup (from map click) ───────────────────────────────────────
function clearPendingWpMarker(){
  if(pendingWpMarker){pendingWpMarker.remove();pendingWpMarker=null;}
}
function confirmMapWaypoint(){
  const name=document.getElementById('popup-wp-name').value.trim()||`km ${pendingWpKm.toFixed(1)}`;
  if(pendingWpKm!==null){waypoints.push({name,km:pendingWpKm});waypoints.sort((a,b)=>a.km-b.km);renderWpList();saveConfig();}
  document.getElementById('wp-pending-popup').style.display='none';pendingWpKm=null;
  clearPendingWpMarker();
  refreshSetupWpMarkers();
}
function cancelMapWaypoint(){
  document.getElementById('wp-pending-popup').style.display='none';pendingWpKm=null;
  clearPendingWpMarker();
}

// ── Runners setup ──────────────────────────────────────────────────────────
function defaultDate(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function defaultTime(){return'09:00';}

function addRunner(){
  const idx=runners.length;
  runners.push({id:'r'+Date.now(),name:'Corredor '+(idx+1),colorIdx:idx,startDate:defaultDate(),startTime:defaultTime(),mode:'pace',pace:'5:30',finish:'',realPasses:{}});
  renderRunnersSetup();checkReadyToStart();saveConfig();
}

function removeRunner(i){runners.splice(i,1);runners.forEach((r,j)=>{if(r.colorIdx>j)r.colorIdx=j;});renderRunnersSetup();checkReadyToStart();saveConfig();}

function renderRunnersSetup(){
  const el=document.getElementById('runners-setup-list');
  el.innerHTML='';
  runners.forEach((r,i)=>{
    const col=isDark()?PALETTE_DARK[r.colorIdx%PALETTE_DARK.length]:PALETTE[r.colorIdx%PALETTE.length];
    const div=document.createElement('div');div.className='runner-card';
    div.innerHTML=`
      <div class="runner-card-header">
        <div class="runner-swatch" style="background:${col}"></div>
        <input class="runner-card-name" type="text" value="${r.name}" oninput="runners[${i}].name=this.value;checkReadyToStart()" style="background:transparent;border:none;color:var(--fg);font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;outline:none;flex:1;">
        <button class="runner-card-del" onclick="removeRunner(${i})" title="Eliminar">×</button>
      </div>
      <div class="form-grid">
        <div class="field"><label>Hora de salida</label>
          <input type="time" value="${r.startTime}" oninput="runners[${i}].startTime=this.value;checkReadyToStart()"></div>
        <div class="field"><label>Fecha</label>
          <input type="date" value="${r.startDate}" oninput="runners[${i}].startDate=this.value;checkReadyToStart()"></div>
        <div class="field"><label>Objetivo</label>
          <select onchange="runners[${i}].mode=this.value;renderRunnersSetup();checkReadyToStart()">
            <option value="pace"${r.mode==='pace'?' selected':''}>Ritmo (min/km)</option>
            <option value="finish"${r.mode==='finish'?' selected':''}>Tiempo total</option>
          </select></div>
        <div class="field">${r.mode==='pace'
          ?`<label>Ritmo objetivo</label><input type="text" placeholder="5:30" value="${r.pace}" oninput="runners[${i}].pace=this.value;checkReadyToStart()">`
          :`<label>Tiempo total</label><input type="text" placeholder="2:15:00" value="${r.finish}" oninput="runners[${i}].finish=this.value;checkReadyToStart()">`
        }</div>
      </div>`;
    el.appendChild(div);
  });
  if(runners.length===0){
    const p=document.createElement('p');p.className='text-xs';p.style.marginBottom='10px';
    p.textContent='Añade al menos un corredor para empezar.';el.appendChild(p);
  }
}

// ── Waypoints ──────────────────────────────────────────────────────────────
function addWaypoint(){
  const name=document.getElementById('wp-name').value.trim();
  const km=parseFloat(document.getElementById('wp-km').value);
  if(!name){alert('Introduce un nombre.');return;}
  if(isNaN(km)||km<0){alert('Distancia inválida.');return;}
  waypoints.push({name,km});waypoints.sort((a,b)=>a.km-b.km);
  document.getElementById('wp-name').value='';document.getElementById('wp-km').value='';
  renderWpList();
  refreshSetupWpMarkers();
  saveConfig();
}
function removeWaypoint(i){waypoints.splice(i,1);renderWpList();refreshSetupWpMarkers();saveConfig();}
function updateWaypointKm(i,val){
  const km=parseFloat(val);
  if(isNaN(km)||km<0) return;
  waypoints[i].km=km;
  waypoints.sort((a,b)=>a.km-b.km);
  refreshSetupWpMarkers();
  renderWpList();
  saveConfig();
}
function renderWpList(){
  const ul=document.getElementById('wp-list');ul.innerHTML='';
  waypoints.forEach((wp,i)=>{
    const div=document.createElement('div');div.className='wp-item';
    div.innerHTML=`<span class="wp-item-name" title="${wp.name}">${wp.name}</span><input class="wp-item-km-input" type="number" step="0.1" min="0" value="${wp.km.toFixed(1)}" onchange="updateWaypointKm(${i},this.value)" title="Distancia en km"><button class="wp-item-del" onclick="removeWaypoint(${i})">×</button>`;
    ul.appendChild(div);
  });
}

// ── Ready check ────────────────────────────────────────────────────────────
function parsePace(s){const m=s.trim().match(/^(\d+):(\d{2})$/);return m?parseInt(m[1])*60+parseInt(m[2]):NaN;}
function parseFinish(s){const m=s.trim().match(/^(\d+):(\d{2}):(\d{2})$/);return m?parseInt(m[1])*3600+parseInt(m[2])*60+parseInt(m[3]):NaN;}
function secToHMS(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60);return h>0?`${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${m}:${String(sec).padStart(2,'0')}`;}
function secToMS(s){return`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;}
function timeOfDay(ms){const d=new Date(ms);return d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0')+':'+d.getSeconds().toString().padStart(2,'0');}

function runnerPaceSec(r){
  if(r.mode==='pace')return parsePace(r.pace);
  const f=parseFinish(r.finish);return isNaN(f)||totalKm<=0?NaN:f/totalKm;
}
function runnerStartMs(r){
  const d=r.startDate?new Date(r.startDate):new Date();
  const[hh,mm]=r.startTime.split(':').map(Number);
  d.setHours(hh,mm,0,0);return d.getTime();
}

function checkReadyToStart(){
  const ok=gpxPoints.length>0&&runners.length>0&&runners.every(r=>!isNaN(runnerPaceSec(r))&&runnerPaceSec(r)>0);
  document.getElementById('start-btn').disabled=!ok;
}

// ── Start tracking ─────────────────────────────────────────────────────────
function startTracking(){
  if(!waypoints.length||waypoints[0].km!==0)
    waypoints.unshift({name:'Salida',km:0});
  if(waypoints[waypoints.length-1].km!==totalKm)
    waypoints.push({name:'Meta',km:totalKm});

  runners.forEach(r=>{r.paceSecPerKm=runnerPaceSec(r);r.startMs=runnerStartMs(r);r.realPasses={};});
  lastRunnerKms=runners.map(()=>0);
  activeRunnerIdx=0;

  document.getElementById('setup-view').classList.add('hidden');
  document.getElementById('tracker-view').classList.remove('hidden');

  setTimeout(()=>{
    initLiveMap();
    buildLiveMap();
  },80);

  renderRunnerTabs();
  tick();
  tickInterval=setInterval(tick,1000);
}

// ── Runner tabs ────────────────────────────────────────────────────────────
function renderRunnerTabs(){
  const el=document.getElementById('runner-tabs');el.innerHTML='';
  runners.forEach((r,i)=>{
    const col=runnerColor(r);
    const btn=document.createElement('button');
    btn.className='runner-tab'+(i===activeRunnerIdx?' active':'');
    if(i===activeRunnerIdx)btn.style.background=col;
    btn.innerHTML=`<span class="tab-dot" style="background:${i===activeRunnerIdx?'rgba(255,255,255,.7)':col}"></span>${r.name}`;
    btn.onclick=()=>{activeRunnerIdx=i;renderRunnerTabs();renderRunnerPanel(lastRunnerKms);};
    el.appendChild(btn);
  });
}

// ── Per-runner panel ───────────────────────────────────────────────────────
function renderRunnerPanel(runnerKms){
  const el=document.getElementById('runner-panel');
  const r=runners[activeRunnerIdx];
  if(!r){el.innerHTML='';return;}
  const now=Date.now();
  const effStart=effectiveStartMs(r);
  const elapsed=(now-effStart)/1000;
  const started=elapsed>=0;
  const rkm=runnerKms[activeRunnerIdx]||0;
  const pct=rkm/totalKm;
  const col=runnerColor(r);
  const finishMs=effStart+r.paceSecPerKm*totalKm*1000;
  const finished=rkm>=totalKm;

  const startDiffSec=Math.round((effStart-r.startMs)/1000);
  const startCorrected=Math.abs(startDiffSec)>30;

  let diffHtml='';
  const passIdxs=Object.keys(r.realPasses).map(Number).sort((a,b)=>b-a);
  if(passIdxs.length>0){
    const lastWpIdx=passIdxs[0];
    const etaMs=effStart+waypoints[lastWpIdx].km*r.paceSecPerKm*1000;
    const diffSec=(r.realPasses[lastWpIdx]-etaMs)/1000;
    const abs=Math.abs(diffSec),sign=diffSec<0?'−':'+';
    const cls=diffSec<-10?'good':diffSec>10?'warn':'';
    diffHtml=`<div class="stat-value ${cls}">${sign}${secToHMS(abs)}</div><div class="stat-sub">${diffSec<-10?'adelantado':diffSec>10?'retrasado':'en ritmo'}</div>`;
  } else if(!finished&&started){
    const rem=(finishMs-now)/1000;
    diffHtml=`<div class="stat-value">${secToHMS(Math.max(0,rem))}</div><div class="stat-sub">para la meta</div>`;
  } else if(finished){
    diffHtml=`<div class="stat-value good">¡Meta!</div><div class="stat-sub">${secToHMS(r.paceSecPerKm*totalKm)}</div>`;
  } else {
    diffHtml=`<div class="stat-value">—</div><div class="stat-sub">antes de salida</div>`;
  }

  el.innerHTML=`
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
        <div>
          <div class="section-header">
            <div class="live-dot" style="background:${col}"></div>
            <span style="color:${col}">${r.name}</span>
          </div>
          <div class="time-big">${started?timeOfDay(finishMs):'—:——'}</div>
          <div class="time-label">${started?'hora est. llegada':'antes de la salida'}</div>
        </div>
        <div style="text-align:right;">
          <div class="text-xs" style="margin-bottom:2px;">${started?'Tiempo transcurrido':'Tiempo hasta salida'}</div>
          <div class="time-big" style="font-size:28px;">${started?secToHMS(elapsed):'-'+secToHMS(-elapsed)}</div>
          <div class="text-xs" style="margin-top:2px;">${
            startCorrected
              ? `<span style="color:var(--yellow);">⚡ salida real ~${timeOfDay(effStart)}</span> <span style="opacity:.6;">(obj. ${r.startTime})</span>`
              : started?'desde la salida':r.startTime
          }</div>
        </div>
      </div>
      <div style="margin-top:14px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:5px;">
          <span class="text-xs">${(pct*100).toFixed(1)}%</span>
          <span class="text-xs">${rkm.toFixed(2)} / ${totalKm.toFixed(2)} km</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${(pct*100).toFixed(2)}%;background:${col}"></div>
          <div class="runner-dot" style="right:${Math.max(0,((1-pct)*(document.querySelector('.progress-track')||{clientWidth:300}).clientWidth)-8)}px;color:${col};background:${col}"></div>
        </div>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="stat-label">Posición est.</div><div class="stat-value">${rkm.toFixed(2)}</div><div class="stat-sub">km recorridos</div></div>
      <div class="stat"><div class="stat-label">Ritmo obj.</div><div class="stat-value">${secToMS(r.paceSecPerKm)}</div><div class="stat-sub">min/km</div></div>
      <div class="stat"><div class="stat-label">Diferencia</div>${diffHtml}</div>
    </div>`;
}

// ── Waypoints table ────────────────────────────────────────────────────────
function effectiveStartMs(r){
  const salidaIdx=waypoints.findIndex(w=>w.km===0);
  if(salidaIdx>=0 && r.realPasses[salidaIdx]!=null) return r.realPasses[salidaIdx];
  let earliestKm=Infinity, earliestMs=null;
  Object.entries(r.realPasses).forEach(([wi,passMs])=>{
    const wkm=waypoints[parseInt(wi)]?.km??Infinity;
    if(wkm<earliestKm){earliestKm=wkm;earliestMs=passMs;}
  });
  if(earliestMs!==null && earliestKm<=2) return earliestMs - earliestKm*r.paceSecPerKm*1000;
  return r.startMs;
}

function projectedEtaMs(r, km){
  let anchorKm=0, anchorMs=effectiveStartMs(r);
  Object.entries(r.realPasses).forEach(([wi,passMs])=>{
    const wkm=waypoints[parseInt(wi)]?.km??0;
    if(wkm>anchorKm){anchorKm=wkm;anchorMs=passMs;}
  });
  return anchorMs+(km-anchorKm)*r.paceSecPerKm*1000;
}
function hasRealAnchorBefore(r, wi){
  const wkm=waypoints[wi]?.km??Infinity;
  const hasAnyPass=Object.keys(r.realPasses).length>0;
  if(hasAnyPass&&wkm>0) return true;
  return Object.keys(r.realPasses).some(k=>waypoints[parseInt(k)]?.km<wkm);
}

function renderWaypointsTable(runnerKms){
  const thead=document.getElementById('wp-thead');
  const tbody=document.getElementById('wp-tbody');
  let th=`<tr><th>Punto</th><th>km</th>`;
  runners.forEach(r=>{
    const col=runnerColor(r);
    th+=`<th style="text-align:center;"><span style="color:${col};font-weight:700;">${r.name}</span></th>`;
  });
  th+=`</tr>`;thead.innerHTML=th;

  tbody.innerHTML='';
  waypoints.forEach((wp,wi)=>{
    const tr=document.createElement('tr');
    let row=`<td class="wp-name">${wp.name}</td><td>${wp.km.toFixed(1)}</td>`;
    runners.forEach((r,ri)=>{
      const col=runnerColor(r);
      const rkm=runnerKms[ri]||0;
      const passed=rkm>=wp.km;
      const objEtaMs=effectiveStartMs(r)+wp.km*r.paceSecPerKm*1000;
      const realMs=r.realPasses[wi];
      let cell='';

      if(realMs!=null){
        const diffSec=(realMs-objEtaMs)/1000;
        const abs=Math.abs(diffSec),sign=diffSec<0?'−':'+';
        const cls=diffSec<-10?'diff-early':diffSec>10?'diff-late':'diff-neutral';
        cell=`<div class="eta-line">${timeOfDay(realMs)}</div>
              <div class="diff-line ${cls}">${sign}${secToHMS(abs)} vs obj.</div>
              <button class="btn-mark marked" onclick="openMarkPass(${ri},${wi})">✏️</button>`;

      } else if(!passed){
        const hasAnchor=hasRealAnchorBefore(r,wi);
        if(hasAnchor){
          const projMs=projectedEtaMs(r,wp.km);
          const projDiffSec=(projMs-objEtaMs)/1000;
          const abs=Math.abs(projDiffSec),sign=projDiffSec<0?'−':'+';
          const cls=projDiffSec<-10?'diff-early':projDiffSec>10?'diff-late':'diff-neutral';
          cell=`<div class="eta-line" style="color:${col};font-weight:600;">${timeOfDay(projMs)}</div>
                <div class="diff-line diff-neutral" style="text-decoration:line-through;opacity:.55;">${timeOfDay(objEtaMs)} obj.</div>
                <div class="diff-line ${cls}">${sign}${secToHMS(abs)}</div>
                <button class="btn-mark" onclick="openMarkPass(${ri},${wi})">📍 Marcar</button>`;
        } else {
          const rem=(objEtaMs-Date.now())/1000;
          cell=`<div class="eta-line">${timeOfDay(objEtaMs)}</div>
                ${rem>0?`<div class="diff-line diff-neutral">−${secToHMS(rem)}</div>`:''}
                <button class="btn-mark" onclick="openMarkPass(${ri},${wi})">📍 Marcar</button>`;
        }

      } else {
        cell=`<div class="eta-line" style="color:var(--fg-3)">${timeOfDay(objEtaMs)}</div>
              <button class="btn-mark" onclick="openMarkPass(${ri},${wi})">📍 Marcar</button>`;
      }
      row+=`<td class="runner-col">${cell}</td>`;
    });
    tr.innerHTML=row;tbody.appendChild(tr);
  });
}

// ── Mark pass ──────────────────────────────────────────────────────────────
function openMarkPass(ri,wi){
  markingRunnerIdx=ri;markingWpIdx=wi;
  const r=runners[ri],wp=waypoints[wi];
  const etaMs=effectiveStartMs(r)+wp.km*r.paceSecPerKm*1000;
  document.getElementById('mark-popup-title').textContent=`Marcar paso — ${r.name}`;
  document.getElementById('mark-popup-sub').textContent=`${wp.name} · km ${wp.km.toFixed(1)} · ETA obj: ${timeOfDay(etaMs)}`;
  const existing=r.realPasses[wi];
  const pre=existing!=null?new Date(existing):new Date();
  document.getElementById('mark-time-input').value=pre.getHours().toString().padStart(2,'0')+':'+pre.getMinutes().toString().padStart(2,'0')+':'+pre.getSeconds().toString().padStart(2,'0');
  document.getElementById('mark-popup').style.display='flex';
}
function markPassNow(){const n=new Date();document.getElementById('mark-time-input').value=n.getHours().toString().padStart(2,'0')+':'+n.getMinutes().toString().padStart(2,'0')+':'+n.getSeconds().toString().padStart(2,'0');}
function confirmMarkPass(){
  if(markingRunnerIdx===null)return;
  const val=document.getElementById('mark-time-input').value;
  if(val){
    const[hh,mm,ss=0]=val.split(':').map(Number);
    const d=new Date(runners[markingRunnerIdx].startMs);d.setHours(hh,mm,ss,0);
    runners[markingRunnerIdx].realPasses[markingWpIdx]=d.getTime();
  }
  cancelMarkPass();
  renderRunnerPanel(lastRunnerKms);
  renderWaypointsTable(lastRunnerKms);
}
function cancelMarkPass(){document.getElementById('mark-popup').style.display='none';markingWpIdx=null;markingRunnerIdx=null;}

// ── Add waypoint during live tracking ──────────────────────────────────────
function openAddLiveWp(){
  document.getElementById('live-wp-name').value='';
  document.getElementById('live-wp-km').value='';
  document.getElementById('add-live-wp-popup').style.display='flex';
  setTimeout(()=>document.getElementById('live-wp-km').focus(),50);
}
function closeAddLiveWp(){document.getElementById('add-live-wp-popup').style.display='none';}
function confirmAddLiveWp(){
  const km=parseFloat(document.getElementById('live-wp-km').value);
  if(isNaN(km)||km<0||km>totalKm){alert('Distancia inválida.');return;}
  const name=document.getElementById('live-wp-name').value.trim()||`km ${km.toFixed(1)}`;
  if(waypoints.some(w=>w.km===km)){alert('Ya existe un punto en ese km.');return;}
  waypoints.push({name,km});
  waypoints.sort((a,b)=>a.km-b.km);
  closeAddLiveWp();
  renderWaypointsTable(lastRunnerKms);
  buildLiveMap();
}

// ── Tick ────────────────────────────────────────────────────────────────────
function runnerKmAt(r, now){
  let anchorKm = 0, anchorMs = effectiveStartMs(r);
  Object.entries(r.realPasses).forEach(([wi, passMs])=>{
    const wkm = waypoints[parseInt(wi)]?.km ?? 0;
    if(wkm > anchorKm){ anchorKm = wkm; anchorMs = passMs; }
  });
  const elapsed = (now - anchorMs) / 1000;
  if(elapsed < 0) return Math.max(0, anchorKm);
  return Math.min(anchorKm + elapsed / r.paceSecPerKm, totalKm);
}

function tick(){
  const now=Date.now();
  lastRunnerKms=runners.map(r=>runnerKmAt(r,now));
  renderRunnerTabs();
  renderRunnerPanel(lastRunnerKms);
  renderWaypointsTable(lastRunnerKms);
  updateLiveMap(lastRunnerKms);
}

// ── Back ───────────────────────────────────────────────────────────────────
function goBack(){
  const hasProgress = runners.some(r=>Object.keys(r.realPasses||{}).length>0);
  if(hasProgress && !confirm('¿Volver a configuración? Perderás todos los pasos registrados en esta sesión.')) return;
  if(tickInterval){clearInterval(tickInterval);tickInterval=null;}
  document.getElementById('tracker-view').classList.add('hidden');
  document.getElementById('setup-view').classList.remove('hidden');
}

// ── Persistencia localStorage ───────────────────────────────────────────────
const LS_KEY = 'runner-tracker-v1';

function saveConfig(){
  try{
    const data = {
      gpxRaw, gpxFileName,
      waypoints,
      runners: runners.map(r=>({
        id:r.id, name:r.name, colorIdx:r.colorIdx,
        startDate:r.startDate, startTime:r.startTime,
        mode:r.mode, pace:r.pace, finish:r.finish
      }))
    };
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  }catch(e){console.warn('saveConfig error',e);}
}

function loadConfig(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return false;
    const data = JSON.parse(raw);
    if(data.gpxRaw && data.gpxFileName){
      const pts = parseGPX(data.gpxRaw);
      if(pts){
        gpxRaw=data.gpxRaw; gpxFileName=data.gpxFileName;
        gpxPoints=pts; totalKm=pts[pts.length-1].dist;
        document.getElementById('gpx-name-text').textContent=gpxFileName;
        document.getElementById('gpx-name').style.display='flex';
        document.getElementById('route-preview').style.display='block';
        document.getElementById('route-stats').textContent=`${gpxPoints.length} puntos · ${totalKm.toFixed(2)} km totales`;
        setTimeout(()=>{initSetupMap();drawSetupRoute();fitSetupMap();},80);
      }
    }
    if(Array.isArray(data.waypoints)) waypoints=data.waypoints;
    if(Array.isArray(data.runners) && data.runners.length>0){
      runners=data.runners.map(r=>({...r,realPasses:{}}));
    }
    return true;
  }catch(e){console.warn('loadConfig error',e);return false;}
}

// ── Init ───────────────────────────────────────────────────────────────────
loadConfig();
if(runners.length===0) addRunner();
renderRunnersSetup();
if(waypoints.length>0){
  const ul=document.getElementById('wp-list');
  ul.innerHTML='';
  waypoints.forEach((wp,i)=>{
    const div=document.createElement('div');
    div.className='wp-item';
    div.innerHTML=`<span class="wp-item-name" title="${wp.name}">${wp.name}</span><input class="wp-item-km-input" type="number" step="0.1" min="0" value="${wp.km.toFixed(1)}" onchange="updateWaypointKm(${i},this.value)" title="Distancia en km"><button class="wp-item-del" onclick="removeWaypoint(${i})">×</button>`;
    ul.appendChild(div);
  });
}
checkReadyToStart();

// ── Service Worker (PWA) ───────────────────────────────────────────────────
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('./sw.js').catch(e=>console.warn('SW registration failed',e));
  });
}
