/* Sector Packing Visualizer
   Fans & site dots render as native MapLibre GeoJSON layers (GPU, projection-correct).
   Measure overlay (transient lines/markers) stays on a 2D canvas. */

let N = 0;
let beamwidth = 120;         // sector beamwidth in degrees (120 or 180), global toggle
let HALF_BW = beamwidth/2;   // half-beamwidth used by the renderer
let sizeMode = 'px';         // 'px' = fixed on-screen pixels, 'm' = real-world meters
let sectorRadiusPx = 90;     // on-screen wedge radius in CSS pixels
let sectorRadiusM = 250;     // real-world wedge radius in meters
const SEC_COLORS = {1:"#f85149", 2:"#3fb950", 3:"#4f9dff"};
const MAX_SETS_LIST = 500;   // cap the in-view list for usability
const SITE_DOT = "#ffd500";  // yellow highlight for sites
const TWO_PI = Math.PI*2;

// measure tool
let measureMode=false;
let measurePts=[];           // up to 2 picked points: {lon,lat,i,label}
let measureEdges=[];         // drawn edge lines: {key, from:[lon,lat], to:[lon,lat], col}
const hiddenLines=new Set(); // line keys toggled off in the readout
let searchedSap=null;        // searched site highlight (sap_id) or null

// ---- data arrays (populated from a loaded CSV) ----
let lat,lon,az,siteOf,suffix,setId,sites;
let setType=new Map();       // set_id -> site_type (2/3) when the CSV provides it
let hasSiteType=false;
let beamwidthLocked=false;   // true when selection's site_type drives beamwidth
const TYPE_TO_BW = {2:180, 3:120};   // 2-sector sites = 180deg, 3-sector = 120deg
let uniqueSets=0;
const selected = new Set();  // selected set_ids
let dataLoaded=false;

/* =========================================================================
   CSV parsing / ingest
   ========================================================================= */
function parseCSV(text){
  text = text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  const lines = text.split('\n');
  let h=0; while(h<lines.length && lines[h].trim()==='') h++;
  if(h>=lines.length) throw new Error('Empty file');
  const header = lines[h].split(',').map(s=>s.trim().toLowerCase());
  // accepted column-name aliases (header already lowercased -> case-insensitive)
  const ALIASES = {
    sap: ['sap_id','site_id'],
    sec: ['sector_id','uid'],
    az:  ['azimuth','az'],
    lat: ['latitude','lat'],
    lon: ['longitude','long','lon'],
    set: ['set_id']
  };
  const OPTIONAL = { type: ['site_type','sector_count','sec_count'] };
  const resolve = names => { for(const n of names){ const idx=header.indexOf(n); if(idx>=0) return idx; } return -1; };
  const ci = { sap:resolve(ALIASES.sap), sec:resolve(ALIASES.sec), az:resolve(ALIASES.az),
               lat:resolve(ALIASES.lat), lon:resolve(ALIASES.lon), set:resolve(ALIASES.set),
               type:resolve(OPTIONAL.type) };   // -1 if absent (optional)
  for(const [k,v] of Object.entries(ci)){
    if(k==='type') continue;                    // site_type is optional
    if(v<0) throw new Error('Missing required column. Expected one of: '+ALIASES[k].join(', '));
  }
  const rows=[];
  for(let i=h+1;i<lines.length;i++){
    const ln=lines[i];
    if(!ln || ln.trim()==='') continue;
    const p=ln.split(',');
    const la=parseFloat(p[ci.lat]), lo=parseFloat(p[ci.lon]), a=parseFloat(p[ci.az]);
    const sid=parseInt(p[ci.set],10);
    if(!isFinite(la)||!isFinite(lo)||!isFinite(a)||!Number.isFinite(sid)) continue;
    const stype = ci.type>=0 ? parseInt(p[ci.type],10) : NaN;   // 2, 3, or NaN
    rows.push([ (p[ci.sap]||'').trim(), (p[ci.sec]||'').trim(), a, la, lo, sid, stype ]);
  }
  return rows;
}

function ingest(rows){
  N = rows.length;
  if(N===0) throw new Error('No valid data rows found');
  lat=new Float32Array(N); lon=new Float32Array(N); az=new Uint16Array(N);
  suffix=new Uint8Array(N); setId=new Uint32Array(N); siteOf=new Uint32Array(N);
  sites=[]; const sidx=new Map(); const us=new Set();
  setType=new Map();          // set_id -> site_type (2 or 3), if provided
  hasSiteType=false;
  for(let i=0;i<N;i++){
    const [sap,sec,a,la,lo,sid,stype]=rows[i];
    lat[i]=la; lon[i]=lo; az[i]=((Math.round(a)%360)+360)%360;
    let si=sidx.get(sap);
    if(si===undefined){ si=sites.length; sidx.set(sap,si); sites.push(sap); }
    siteOf[i]=si;
    const m=sec.lastIndexOf('_');
    const sfx = m>=0 ? parseInt(sec.slice(m+1),10) : NaN;
    suffix[i]= Number.isFinite(sfx) ? (sfx & 0xFF) : 0;
    setId[i]=sid>=0 ? sid : 0;
    us.add(setId[i]);
    if(Number.isFinite(stype)){ hasSiteType=true; if(!setType.has(setId[i])) setType.set(setId[i], stype); }
  }
  uniqueSets=us.size;
  dataLoaded=true;
}

async function loadCSVText(text){
  ingest(parseCSV(text));
  document.getElementById('tot').textContent=N.toLocaleString();
  document.getElementById('sitesN').textContent=sites.length.toLocaleString();
  document.getElementById('setsN').textContent=uniqueSets.toLocaleString();
  selected.clear();
  document.getElementById('selN').textContent='0';
  searchedSap=null;
  syncBeamwidthLock();
  refreshSetList(); rebuildLayers();
}
function secId(i){ return sites[siteOf[i]]+'_'+suffix[i]; }
function colorFor(i){ return SEC_COLORS[suffix[i]] || "#8b949e"; }

/* =========================================================================
   Geodesy helpers
   ========================================================================= */
function haversine(lo1,la1,lo2,la2){
  const R=6371008.8, toR=Math.PI/180;
  const dLa=(la2-la1)*toR, dLo=(lo2-lo1)*toR;
  const a=Math.sin(dLa/2)**2 + Math.cos(la1*toR)*Math.cos(la2*toR)*Math.sin(dLo/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function bearing(la1,lo1,la2,lo2){
  const toR=Math.PI/180;
  const y=Math.sin((lo2-lo1)*toR)*Math.cos(la2*toR);
  const x=Math.cos(la1*toR)*Math.sin(la2*toR)-Math.sin(la1*toR)*Math.cos(la2*toR)*Math.cos((lo2-lo1)*toR);
  return (Math.atan2(y,x)/toR+360)%360;
}
function destPoint(la,lo,distM,brg){
  const R=6371008.8,toR=Math.PI/180,dr=distM/R;
  const b=brg*toR,l1=la*toR;
  const l2=Math.asin(Math.sin(l1)*Math.cos(dr)+Math.cos(l1)*Math.sin(dr)*Math.cos(b));
  const g2=lo*toR+Math.atan2(Math.sin(b)*Math.sin(dr)*Math.cos(l1), Math.cos(dr)-Math.sin(l1)*Math.sin(l2));
  return [l2/toR, g2/toR];
}
function fmtDist(m){ return m>=1000 ? (m/1000).toFixed(2)+' km' : Math.round(m)+' m'; }

/* =========================================================================
   Map + controls
   ========================================================================= */
const map=new maplibregl.Map({
  container:'map', style:'https://tiles.openfreemap.org/styles/dark',
  center:[80.5,17.0], zoom:5, maxZoom:18
});

class ZoomReadout {
  onAdd(m){
    this._map=m;
    this._c=document.createElement('div');
    this._c.className='maplibregl-ctrl maplibregl-ctrl-group zoomctrl';
    this._c.innerHTML='<div class="zbtn"><span class="zicon">🔍</span><b id="zval">5.0</b></div>';
    return this._c;
  }
  onRemove(){ this._c.parentNode.removeChild(this._c); this._map=undefined; }
}
map.addControl(new ZoomReadout(),'bottom-right');
map.addControl(new maplibregl.NavigationControl(),'bottom-right');

// measure overlay canvas
const cv=document.getElementById('overlay'),ctx=cv.getContext('2d');
let dpr=window.devicePixelRatio||1;
function resize(){
  dpr=window.devicePixelRatio||1;
  const mc=map.getCanvas();
  const w=mc.clientWidth, h=mc.clientHeight;
  cv.width=Math.round(w*dpr); cv.height=Math.round(h*dpr);
  cv.style.width=w+'px'; cv.style.height=h+'px';
}
function ensureSize(){
  const mc=map.getCanvas();
  const w=mc.clientWidth, h=mc.clientHeight;
  if(cv.width!==Math.round(w*dpr) || cv.height!==Math.round(h*dpr)) resize();
}

/* =========================================================================
   Native GeoJSON layers: sector fans (fill+line) and site dots (circle)
   ========================================================================= */
const SRC_FANS='fans-src', LYR_FILL='fans-fill', LYR_LINE='fans-line';
const SRC_DOTS='dots-src', LYR_DOTS='dots-dots', LYR_RING='dots-ring';
let layersReady=false;

// current fan radius in meters, honoring px/m mode (px converted at current zoom+lat)
function fanRadiusMeters(lati){
  if(sizeMode==='m') return sectorRadiusM;
  // convert a pixel radius to ground meters at this latitude & zoom via projection
  const apex=map.project([0,lati]);            // lon irrelevant for the N-S metric
  const north=destPoint(lati,0,1000,0);
  const p=map.project([north[1],north[0]]);
  const pxPerKm=Math.hypot(p.x-apex.x,p.y-apex.y);
  const pxPerM=pxPerKm/1000;
  return pxPerM>0 ? sectorRadiusPx/pxPerM : 0;
}

// build a geodesic fan polygon (GeoJSON ring) for sector i
function fanPolygon(i){
  const la=lat[i], lo=lon[i];
  const radM=fanRadiusMeters(la);
  const a0=az[i]-HALF_BW, a1=az[i]+HALF_BW;
  const step=Math.max(2,(2*HALF_BW)/48);
  const ring=[[lo,la]];                          // apex
  for(let a=a0;a<=a1+1e-6;a+=step){
    const g=destPoint(la,lo,radM,a);             // [lat,lon]
    ring.push([g[1],g[0]]);
  }
  ring.push([lo,la]);                            // close
  return ring;
}

// (re)build the GeoJSON for selected sets + site dots, and push to the sources
function rebuildLayers(){
  if(!layersReady) return;
  updateZoomLabel();
  const fanFeats=[], dotSites=new Map();
  if(selected.size>0){
    for(let i=0;i<N;i++){
      if(!selected.has(setId[i])) continue;
      fanFeats.push({
        type:'Feature',
        properties:{ i, color:colorFor(i) },
        geometry:{ type:'Polygon', coordinates:[fanPolygon(i)] }
      });
      dotSites.set(siteOf[i],[lon[i],lat[i]]);
    }
  }
  // site dots (selected-set sites) + searched-site ring flag
  const dotFeats=[];
  for(const [si,ll] of dotSites){
    dotFeats.push({type:'Feature',properties:{ring:0},geometry:{type:'Point',coordinates:ll}});
  }
  if(searchedSap!==null){
    const idx=sites.indexOf(searchedSap);
    if(idx>=0){
      for(let i=0;i<N;i++){ if(siteOf[i]===idx){
        dotFeats.push({type:'Feature',properties:{ring:1},geometry:{type:'Point',coordinates:[lon[i],lat[i]]}});
        break;
      }}
    }
  }
  map.getSource(SRC_FANS).setData({type:'FeatureCollection',features:fanFeats});
  map.getSource(SRC_DOTS).setData({type:'FeatureCollection',features:dotFeats});
  document.getElementById('vis').textContent=fanFeats.length.toLocaleString();
  drawMeasure();  // keep transient overlay in sync
}

function addLayers(){
  map.addSource(SRC_FANS,{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({ id:LYR_FILL, type:'fill', source:SRC_FANS,
    paint:{ 'fill-color':['get','color'], 'fill-opacity':0.22 } });
  map.addLayer({ id:LYR_LINE, type:'line', source:SRC_FANS,
    paint:{ 'line-color':['get','color'], 'line-width':1.2, 'line-opacity':0.95 } });

  map.addSource(SRC_DOTS,{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({ id:LYR_RING, type:'circle', source:SRC_DOTS,
    filter:['==',['get','ring'],1],
    paint:{ 'circle-radius':9, 'circle-color':'rgba(0,0,0,0)',
            'circle-stroke-color':SITE_DOT, 'circle-stroke-width':1.6 } });
  map.addLayer({ id:LYR_DOTS, type:'circle', source:SRC_DOTS,
    paint:{ 'circle-radius':['case',['==',['get','ring'],1],5,3.2],
            'circle-color':SITE_DOT, 'circle-stroke-color':'#0d1117', 'circle-stroke-width':1.4 } });
  layersReady=true;
}

function updateZoomLabel(){
  const el=document.getElementById('zval');
  if(el) el.textContent=map.getZoom().toFixed(1);
}

/* =========================================================================
   Measure overlay (transient 2D canvas)
   ========================================================================= */
function drawMeasure(){
  ensureSize();
  ctx.clearRect(0,0,cv.width,cv.height);
  if(measurePts.length===0) return;
  if(measurePts.length===2){
    for(const e of measureEdges){
      if(hiddenLines.has(e.key)) continue;
      const f=map.project([e.from[0],e.from[1]]);
      const t=map.project([e.to[0],e.to[1]]);
      ctx.beginPath();
      ctx.moveTo(f.x*dpr,f.y*dpr);ctx.lineTo(t.x*dpr,t.y*dpr);
      ctx.lineWidth=2.4*dpr;ctx.strokeStyle=e.col;ctx.stroke();
      for(const pt of [f,t]){
        ctx.beginPath();ctx.arc(pt.x*dpr,pt.y*dpr,4*dpr,0,TWO_PI);
        ctx.fillStyle=e.col;ctx.fill();
        ctx.lineWidth=1.4*dpr;ctx.strokeStyle="#0d1117";ctx.stroke();
      }
    }
    if(!hiddenLines.has('ab')){
      const a=map.project([measurePts[0].lon,measurePts[0].lat]);
      const b=map.project([measurePts[1].lon,measurePts[1].lat]);
      ctx.beginPath();
      ctx.setLineDash([6*dpr,5*dpr]);
      ctx.moveTo(a.x*dpr,a.y*dpr);ctx.lineTo(b.x*dpr,b.y*dpr);
      ctx.lineWidth=2*dpr;ctx.strokeStyle="#ffffff";ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  for(const p of measurePts){
    const s=map.project([p.lon,p.lat]);
    ctx.beginPath();ctx.arc(s.x*dpr,s.y*dpr,6*dpr,0,TWO_PI);
    ctx.fillStyle="#ffffff";ctx.fill();
    ctx.lineWidth=2*dpr;ctx.strokeStyle="#58a6ff";ctx.stroke();
    if(p.label){
      ctx.fillStyle="#04101f";
      ctx.font="bold "+(9*dpr)+"px system-ui,sans-serif";
      ctx.textAlign="center";ctx.textBaseline="middle";
      ctx.fillText(p.label, s.x*dpr, s.y*dpr+0.5*dpr);
    }
  }
}

/* =========================================================================
   Sets-in-view list
   ========================================================================= */
function refreshSetList(){
  if(!dataLoaded) return;
  const b=map.getBounds(),w=b.getWest(),e=b.getEast(),s=b.getSouth(),n=b.getNorth(),pad=0.02;
  const seen=new Map();
  for(let i=0;i<N;i++){
    const la=lat[i],lo=lon[i];
    if(lo<w-pad||lo>e+pad||la<s-pad||la>n+pad) continue;
    seen.set(setId[i], (seen.get(setId[i])||0)+1);
  }
  const ids=[...seen.keys()].sort((a,b)=>a-b);
  document.getElementById('setInView').textContent=ids.length.toLocaleString();
  const list=document.getElementById('setlist');
  const empty=document.getElementById('setempty');
  if(ids.length===0){ list.innerHTML=''; empty.style.display='block';
    empty.textContent='No sets in the current view. Pan or zoom the map.'; return; }
  empty.style.display='none';
  const shown=ids.slice(0,MAX_SETS_LIST);
  let html=shown.map(id=>{
    const sel=selected.has(id)?' checked':'';
    const cls=selected.has(id)?' class="setrow sel"':' class="setrow"';
    return '<label'+cls+' data-id="'+id+'"><input type="checkbox"'+sel+'>'+
           '<span class="sid">Set '+id+'</span>'+
           '<span class="n">'+seen.get(id)+' sec</span></label>';
  }).join('');
  if(ids.length>MAX_SETS_LIST){
    html+='<div id="setempty" style="display:block">Showing first '+MAX_SETS_LIST+
          ' of '+ids.length.toLocaleString()+' sets in view. Zoom in to narrow down.</div>';
  }
  list.innerHTML=html;
  list.querySelectorAll('.setrow').forEach(row=>{
    const cb=row.querySelector('input');
    cb.addEventListener('change',()=>toggleSet(+row.dataset.id, cb.checked, row));
  });
}

function toggleSet(id, on, row){
  if(on) selected.add(id); else selected.delete(id);
  if(row) row.classList.toggle('sel', on);
  document.getElementById('selN').textContent=selected.size.toLocaleString();
  syncBeamwidthLock();
  rebuildLayers();
}

document.getElementById('clearSel').addEventListener('click',()=>{
  selected.clear();
  document.getElementById('selN').textContent='0';
  syncBeamwidthLock();
  refreshSetList(); rebuildLayers();
});

/* =========================================================================
   Size + beamwidth controls
   ========================================================================= */
const sizeRange=document.getElementById('sizeRange');
const sizeVal=document.getElementById('sizeVal');
const sizeUnit=document.getElementById('sizeUnit');
const btnPx=document.getElementById('modePx'), btnM=document.getElementById('modeM');

function fmtMeters(m){
  if(m>=1000){ sizeUnit.textContent='km'; return (m/1000).toFixed(m%1000===0?0:1); }
  sizeUnit.textContent='m'; return String(m);
}
function applyMode(mode){
  sizeMode=mode;
  if(mode==='px'){
    btnPx.classList.add('active'); btnM.classList.remove('active');
    sizeUnit.textContent='px';
    sizeRange.min=20; sizeRange.max=300; sizeRange.step=5;
    sizeRange.value=sectorRadiusPx; sizeVal.textContent=sectorRadiusPx;
  } else {
    btnM.classList.add('active'); btnPx.classList.remove('active');
    sizeRange.min=50; sizeRange.max=450000; sizeRange.step=50;
    sizeRange.value=sectorRadiusM; sizeVal.textContent=fmtMeters(sectorRadiusM);
  }
  rebuildLayers();
}
sizeRange.addEventListener('input',e=>{
  const v=+e.target.value;
  if(sizeMode==='px'){ sectorRadiusPx=v; sizeVal.textContent=v; }
  else { sectorRadiusM=v; sizeVal.textContent=fmtMeters(v); }
  scheduleRebuild();   // debounced; slider fires rapidly
});
btnPx.addEventListener('click',()=>applyMode('px'));
btnM.addEventListener('click',()=>applyMode('m'));

const bw120=document.getElementById('bw120'), bw180=document.getElementById('bw180');
const bwLockIcon=document.getElementById('bwLock');
function setBeamwidth(deg){
  beamwidth=deg; HALF_BW=deg/2;
  bw120.classList.toggle('active', deg===120);
  bw180.classList.toggle('active', deg===180);
  const sb=document.getElementById('subBw'); if(sb) sb.textContent=deg;
}
function applyBeamwidth(deg){          // manual click path
  if(beamwidthLocked) return;          // ignore while locked to data
  setBeamwidth(deg);
  rebuildLayers();
}
bw120.addEventListener('click',()=>applyBeamwidth(120));
bw180.addEventListener('click',()=>applyBeamwidth(180));

// derive beamwidth from the selection's site_type when uniform; lock the toggle if so
function syncBeamwidthLock(){
  let locked=false, deg=null;
  if(hasSiteType && selected.size>0){
    let type=null, uniform=true;
    for(const sid of selected){
      const t=setType.get(sid);
      if(t===undefined){ uniform=false; break; }
      if(type===null) type=t; else if(type!==t){ uniform=false; break; }
    }
    if(uniform && TYPE_TO_BW[type]!==undefined){ locked=true; deg=TYPE_TO_BW[type]; }
  }
  beamwidthLocked=locked;
  // reflect lock state in the UI
  bw120.disabled=locked; bw180.disabled=locked;
  document.getElementById('bwctl').classList.toggle('locked', locked);
  if(bwLockIcon) bwLockIcon.style.display = locked ? 'inline-flex' : 'none';
  if(locked && deg!==beamwidth) setBeamwidth(deg);
  return locked;
}

// debounce rapid slider input into ~1 rebuild per animation frame
let rebuildQueued=false;
function scheduleRebuild(){
  if(rebuildQueued) return;
  rebuildQueued=true;
  requestAnimationFrame(()=>{ rebuildQueued=false; rebuildLayers(); });
}

/* =========================================================================
   Measure tool
   ========================================================================= */
const measureBtn=document.getElementById('measureBtn');
const measureOut=document.getElementById('measureOut');
const SNAP_PX=14;

function setMeasureMode(on){
  measureMode=on;
  measureBtn.classList.toggle('active',on);
  map.getCanvas().style.cursor = on ? 'crosshair' : '';
  if(on){ measurePts=[]; renderMeasureOut(); drawMeasure(); }
}
measureBtn.addEventListener('click',()=>setMeasureMode(!measureMode));

// nearest selected-set sector apex to a screen point, within SNAP_PX
function snapToSector(mx,my){
  if(selected.size===0) return null;
  let best=null,bd=SNAP_PX;
  const b=map.getBounds(),w=b.getWest(),e=b.getEast(),s=b.getSouth(),n=b.getNorth(),pad=0.05;
  for(let i=0;i<N;i++){
    if(!selected.has(setId[i])) continue;
    const la=lat[i],lo=lon[i];
    if(lo<w-pad||lo>e+pad||la<s-pad||la>n+pad) continue;
    const p=map.project([lo,la]);
    const d=Math.hypot(mx-p.x,my-p.y);
    if(d<bd){bd=d;best=i;}
  }
  return best;   // sector index or null
}

function distToFanEdge(fromLon,fromLat, i){
  const alon=lon[i], alat=lat[i];
  const radM=fanRadiusMeters(alat);
  const distAP=haversine(alon,alat,fromLon,fromLat);
  const brg=bearing(alat,alon,fromLat,fromLon);
  let da=((brg-az[i]+540)%360)-180;
  const within = Math.abs(da)<=HALF_BW;
  if(within){
    const ep=destPoint(alat,alon,radM,brg);
    return {dist:Math.abs(distAP - radM), pt:[ep[1],ep[0]]};
  } else {
    const edgeAz = az[i] + (da>0 ? HALF_BW : -HALF_BW);
    const proj = distAP*Math.cos((da - (da>0?HALF_BW:-HALF_BW))*Math.PI/180);
    const clamped=Math.max(0,Math.min(radM,proj));
    const ep=destPoint(alat,alon,clamped,edgeAz);
    return {dist:haversine(ep[1],ep[0], fromLon,fromLat), pt:[ep[1],ep[0]]};
  }
}
function fanBoundaryPts(i){
  const alat=lat[i], alon=lon[i], radM=fanRadiusMeters(alat);
  const a0=az[i]-HALF_BW, a1=az[i]+HALF_BW;
  const pts=[[alon,alat]];
  const EDGE_STEPS=8, ARC_STEP=Math.max(2,(2*HALF_BW)/40);
  for(let s=1;s<=EDGE_STEPS;s++){ const g=destPoint(alat,alon,radM*s/EDGE_STEPS,a0); pts.push([g[1],g[0]]); }
  for(let a=a0;a<=a1+1e-6;a+=ARC_STEP){ const g=destPoint(alat,alon,radM,a); pts.push([g[1],g[0]]); }
  for(let s=EDGE_STEPS-1;s>=1;s--){ const g=destPoint(alat,alon,radM*s/EDGE_STEPS,a1); pts.push([g[1],g[0]]); }
  return pts;
}
function fanToFanDist(i,j){
  const P=fanBoundaryPts(i), Q=fanBoundaryPts(j);
  let best=Infinity, bp=null, bq=null;
  for(const p of P) for(const q of Q){
    const d=haversine(p[0],p[1],q[0],q[1]);
    if(d<best){best=d;bp=p;bq=q;}
  }
  return {dist:best, from:bp, to:bq};
}

function renderMeasureOut(){
  measureEdges=[];
  if(measurePts.length===0){ measureOut.style.display='none'; return; }
  measureOut.style.display='block';
  if(measurePts.length===1){
    const t=measurePts[0].i!=null?'site':'point';
    measureOut.innerHTML='<span class="mk">A set ('+t+'). Click point B.</span>'+
      '<button class="mclear" id="mClear">Clear</button>';
  } else {
    const A=measurePts[0], B=measurePts[1];
    const d=haversine(A.lon,A.lat,B.lon,B.lat);
    const C1="#f59e0b", C2="#22d3ee", C3="#c084fc";
    function row(key,col,label,dist){
      const off=hiddenLines.has(key);
      return '<div class="mline'+(off?' off':'')+'">'+
        '<span class="msw" data-line="'+key+'" style="background:'+col+'" title="toggle line"></span>'+
        '<span class="mk">'+label+'</span> <b>'+fmtDist(dist)+'</b></div>';
    }
    let html=row('ab','#ffffff','A \u2194 B',d);
    if(B.i!=null){
      const fe=distToFanEdge(A.lon,A.lat,B.i);
      measureEdges.push({key:'ab_edge', from:[A.lon,A.lat], to:fe.pt, col:C1});
      html+=row('ab_edge',C1,'A \u2192 B edge',fe.dist);
    }
    if(A.i!=null){
      const fe=distToFanEdge(B.lon,B.lat,A.i);
      measureEdges.push({key:'ba_edge', from:[B.lon,B.lat], to:fe.pt, col:C2});
      html+=row('ba_edge',C2,'B \u2192 A edge',fe.dist);
    }
    if(A.i!=null && B.i!=null){
      const ff=fanToFanDist(A.i,B.i);
      measureEdges.push({key:'ee', from:ff.from, to:ff.to, col:C3});
      const lbl = ff.dist<1 ? 'A edge \u2194 B edge <span class="mk">(overlap)</span>' : 'A edge \u2194 B edge';
      html+=row('ee',C3,lbl,ff.dist);
    }
    html+='<div class="mhint">tip: click a color to hide/show its line</div>';
    html+='<button class="mclear" id="mClear">Clear</button>';
    measureOut.innerHTML=html;
    measureOut.querySelectorAll('.msw[data-line]').forEach(el=>{
      el.addEventListener('click',()=>{
        const k=el.dataset.line;
        if(hiddenLines.has(k)) hiddenLines.delete(k); else hiddenLines.add(k);
        renderMeasureOut(); drawMeasure();
      });
    });
  }
  const c=document.getElementById('mClear');
  if(c) c.addEventListener('click',()=>{measurePts=[];hiddenLines.clear();renderMeasureOut();drawMeasure();});
}

map.getCanvas().addEventListener('click',ev=>{
  if(!measureMode) return;
  const rect=map.getCanvas().getBoundingClientRect();
  const mx=ev.clientX-rect.left,my=ev.clientY-rect.top;
  const si=snapToSector(mx,my);
  let pt;
  if(si!=null){ pt={lon:lon[si],lat:lat[si],i:si}; }
  else { const ll=map.unproject([mx,my]); pt={lon:ll.lng,lat:ll.lat,i:null}; }
  if(measurePts.length>=2){ measurePts=[]; hiddenLines.clear(); }
  pt.label = measurePts.length===0 ? 'A' : 'B';
  measurePts.push(pt);
  renderMeasureOut();
  drawMeasure();
});

/* =========================================================================
   Hover tooltip (native feature query)
   ========================================================================= */
const tip=document.getElementById('tip');
function compass(deg){
  const dirs=['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(((deg%360)/45))%8];
}
map.on('mousemove',ev=>{
  if(measureMode){tip.style.display='none';return;}
  if(!layersReady || selected.size===0){tip.style.display='none';return;}
  const feats=map.queryRenderedFeatures(ev.point,{layers:[LYR_FILL]});
  if(feats.length){
    const i=feats[0].properties.i;
    const col=colorFor(i), dir=compass(az[i]);
    tip.innerHTML=
      '<div class="thd"><span class="tsw" style="background:'+col+'"></span>'+
      '<span class="sid">'+secId(i)+'</span></div>'+
      '<div class="trow"><span class="tk">Set</span><span class="tv">'+setId[i]+'</span></div>'+
      '<div class="trow"><span class="tk">Azimuth</span><span class="tv">'+az[i]+'\u00b0 '+dir+'</span></div>'+
      '<div class="trow"><span class="tk">Beamwidth</span><span class="tv">'+beamwidth+'\u00b0</span></div>'+
      '<div class="trow"><span class="tk">Lat, Lon</span><span class="tv">'+lat[i].toFixed(5)+', '+lon[i].toFixed(5)+'</span></div>';
    tip.style.display='block';
    const rect=map.getCanvas().getBoundingClientRect();
    const mx=ev.point.x, my=ev.point.y;
    const tw=tip.offsetWidth, th=tip.offsetHeight, gap=14;
    let x=mx+gap, y=my+gap;
    if(x+tw>rect.width-6) x=mx-gap-tw;
    if(y+th>rect.height-6) y=my-gap-th;
    if(x<6) x=6; if(y<6) y=6;
    tip.style.left=x+'px'; tip.style.top=y+'px';
    map.getCanvas().style.cursor='pointer';
  } else {
    tip.style.display='none';
    map.getCanvas().style.cursor='';
  }
});

/* =========================================================================
   Init + map events
   ========================================================================= */
(function init(){
  map.on('load',()=>{
    addLayers();
    map.resize();
    resize(); refreshSetList(); rebuildLayers();
    document.getElementById('loading').style.display='none';
    requestAnimationFrame(()=>{map.resize();resize();drawMeasure();});
  });
  // panning: fans/dots are GPU layers (auto-transform); only the measure overlay needs redraw
  map.on('move',()=>{ updateZoomLabel(); drawMeasure(); });
  map.on('moveend',()=>{ refreshSetList(); });
  // px-mode radius is zoom-dependent -> rebuild fan geometry when zoom settles
  map.on('zoomend',()=>{ if(sizeMode==='px') rebuildLayers(); });
  map.on('resize',()=>{ resize(); drawMeasure(); });
  window.addEventListener('resize',()=>{ map.resize(); resize(); drawMeasure(); });
})();

/* =========================================================================
   Sidebar collapse
   ========================================================================= */
const appEl=document.getElementById('app');
const sidebarEl=document.getElementById('sidebar');
document.getElementById('sidebarToggle').addEventListener('click',()=>{
  appEl.classList.toggle('collapsed');
});
sidebarEl.addEventListener('transitionend',ev=>{
  if(ev.propertyName!=='width' && ev.propertyName!=='height') return;
  map.resize(); resize(); drawMeasure();
});

/* =========================================================================
   Style selector
   ========================================================================= */
document.getElementById('styleSel').addEventListener('change',e=>{
  const key=e.target.value;
  // re-add our layers after the new style finishes loading (setStyle wipes custom layers)
  layersReady=false;
  map.once('idle',()=>{
    if(!map.getSource(SRC_FANS)){ addLayers(); rebuildLayers(); }
    if(currentProjection==='globe') map.setProjection({type:'globe'}); // style change may reset it
  });
  map.setStyle('https://tiles.openfreemap.org/styles/'+key);
});

// ---- projection toggle (flat Mercator / globe) ----
let currentProjection='mercator';
const projMercator=document.getElementById('projMercator');
const projGlobe=document.getElementById('projGlobe');
function setProjection(type){
  currentProjection=type;
  map.setProjection({type});
  const globe = type==='globe';
  projGlobe.classList.toggle('active', globe);
  projMercator.classList.toggle('active', !globe);
  // fans/dots are geodesic GeoJSON -> they reproject automatically; just refresh the measure overlay
  drawMeasure();
}
projMercator.addEventListener('click',()=>setProjection('mercator'));
projGlobe.addEventListener('click',()=>setProjection('globe'));

/* =========================================================================
   Data picker
   ========================================================================= */
const picker=document.getElementById('picker');
const dropzone=document.getElementById('dropzone');
const fileInput=document.getElementById('fileInput');
const perr=document.getElementById('perr');
function showErr(msg){ perr.textContent=msg; }

async function handleFile(file){
  if(!file) return;
  showErr('');
  if(!/\.csv$/i.test(file.name) && file.type!=='text/csv' && file.type!==''){
    showErr('Please choose a .csv file.'); return;
  }
  document.getElementById('loading').style.display='flex';
  document.getElementById('lmsg').textContent='Parsing '+file.name+' ...';
  try{
    const text=await file.text();
    await loadCSVText(text);
    picker.style.display='none';
    document.getElementById('loading').style.display='none';
    fitToData();
  }catch(err){
    document.getElementById('loading').style.display='none';
    showErr(err.message||('Could not parse file'));
  }
}
function fitToData(){
  if(!dataLoaded||N===0) return;
  let mnLa=Infinity,mxLa=-Infinity,mnLo=Infinity,mxLo=-Infinity;
  for(let i=0;i<N;i++){
    if(lat[i]<mnLa)mnLa=lat[i]; if(lat[i]>mxLa)mxLa=lat[i];
    if(lon[i]<mnLo)mnLo=lon[i]; if(lon[i]>mxLo)mxLo=lon[i];
  }
  if(isFinite(mnLa)) map.fitBounds([[mnLo,mnLa],[mxLo,mxLa]],{padding:40,duration:0});
}
document.getElementById('pickBtn').addEventListener('click',()=>fileInput.click());
fileInput.addEventListener('change',e=>handleFile(e.target.files[0]));
['dragenter','dragover'].forEach(ev=>dropzone.addEventListener(ev,e=>{
  e.preventDefault();e.stopPropagation();dropzone.classList.add('drag');
}));
['dragleave','drop'].forEach(ev=>dropzone.addEventListener(ev,e=>{
  e.preventDefault();e.stopPropagation();dropzone.classList.remove('drag');
}));
dropzone.addEventListener('drop',e=>{
  const f=e.dataTransfer.files&&e.dataTransfer.files[0];
  handleFile(f);
});

/* =========================================================================
   SAP search
   ========================================================================= */
const q=document.getElementById('q'),go=document.getElementById('go'),resBox=document.getElementById('results');
function flyToSite(siteName){
  for(let i=0;i<N;i++){ if(sites[siteOf[i]]===siteName){ searchedSap=siteName; map.flyTo({center:[lon[i],lat[i]],zoom:15}); rebuildLayers(); return true; } }
  return false;
}

// ---- search mode (Site / Set) ----
let searchMode='site';
const smSite=document.getElementById('smSite'), smSet=document.getElementById('smSet');
function setSearchMode(mode){
  searchMode=mode;
  smSite.classList.toggle('active', mode==='site');
  smSet.classList.toggle('active', mode==='set');
  q.placeholder = mode==='site' ? 'Search SAP / site ID...' : 'Search set ID (number)...';
  q.value=''; resBox.style.display='none';
}
smSite.addEventListener('click',()=>setSearchMode('site'));
smSet.addEventListener('click',()=>setSearchMode('set'));

// select a set: check it in the list (if visible), draw it, and let beamwidth lock sync
function selectSet(id){
  selected.add(id);
  document.getElementById('selN').textContent=selected.size.toLocaleString();
  // reflect in the in-view list checkbox if present
  const row=document.querySelector('.setrow[data-id="'+id+'"]');
  if(row){ row.classList.add('sel'); const cb=row.querySelector('input'); if(cb) cb.checked=true; }
  syncBeamwidthLock();
  rebuildLayers();
}

function doSearchSet(){
  const term=q.value.trim();
  if(!term) return;
  const id=parseInt(term,10);
  if(!Number.isFinite(id) || String(id)!==term.replace(/^0+(?=\d)/,'')){
    resBox.innerHTML='<div>Enter a numeric set ID</div>'; resBox.style.display='block'; return;
  }
  // does this set exist in the data?
  let exists=false;
  for(let i=0;i<N;i++){ if(setId[i]===id){ exists=true; break; } }
  if(!exists){ resBox.innerHTML='<div>No set '+id+' in data</div>'; resBox.style.display='block'; return; }
  if(selected.has(id)){ resBox.innerHTML='<div>Set '+id+' already selected</div>'; resBox.style.display='block'; return; }
  selectSet(id);
  resBox.style.display='none';
}

function doSearch(){
  if(searchMode==='set'){ doSearchSet(); return; }
  const term=q.value.trim();
  if(!term)return;
  const parts=term.split(',');
  if(parts.length===2&&!isNaN(+parts[0])&&!isNaN(+parts[1])){
    map.flyTo({center:[+parts[1],+parts[0]],zoom:15});resBox.style.display='none';return;
  }
  const t=term.toLowerCase(),matches=[];
  for(let s=0;s<sites.length&&matches.length<50;s++) if(sites[s].toLowerCase().includes(t)) matches.push(sites[s]);
  if(matches.length===0){resBox.innerHTML='<div>No matching site</div>';resBox.style.display='block';return;}
  if(matches.length===1){flyToSite(matches[0]);resBox.style.display='none';return;}
  resBox.innerHTML=matches.map(m=>'<div data-s="'+m+'">'+m+'</div>').join('');
  resBox.style.display='block';
  resBox.querySelectorAll('div').forEach(d=>d.addEventListener('click',()=>{
    q.value=d.dataset.s;flyToSite(d.dataset.s);resBox.style.display='none';
  }));
}
go.addEventListener('click',doSearch);
q.addEventListener('keydown',e=>{if(e.key==='Enter')doSearch();});
