let N = 0;
let beamwidth = 120;         // sector beamwidth in degrees (120 or 180), global toggle
let HALF_BW = beamwidth/2;   // half-beamwidth used by the renderer
let sizeMode = 'px';         // 'px' = fixed on-screen pixels, 'm' = real-world meters
let sectorRadiusPx = 90;     // on-screen wedge radius in CSS pixels
let sectorRadiusM = 250;     // real-world wedge radius in meters
const SEC_COLORS = {1:"#f85149", 2:"#3fb950", 3:"#4f9dff"};
const MAX_SETS_LIST = 500; // cap the in-view list for usability
const SITE_DOT = "#ffd500"; // yellow highlight for sites

// measure tool
let measureMode=false;
let measurePts=[];          // up to 2 picked points: {lon,lat,i} (i = sector index if snapped)
let measureEdges=[];        // drawn edge lines: {key, from:[lon,lat], to:[lon,lat], col}
const hiddenLines=new Set(); // line keys toggled off in the readout
// searched site highlight (persists after a search): sap_id string or null
let searchedSap=null;

// ---- data arrays (populated from a loaded CSV) ----
let lat,lon,az,siteOf,suffix,setId,sites;
let uniqueSets=0;
const selected = new Set();       // selected set_ids
let dataLoaded=false;

// Parse a CSV with columns: sap_id,sector_id,azimuth,latitude,longitude,set_id
// (column order is detected from the header; extra columns are ignored)
function parseCSV(text){
  // strip BOM + normalise line endings
  text = text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  const lines = text.split('\n');
  // find first non-empty line as header
  let h=0; while(h<lines.length && lines[h].trim()==='') h++;
  if(h>=lines.length) throw new Error('Empty file');
  const header = lines[h].split(',').map(s=>s.trim().toLowerCase());
  const col = name => header.indexOf(name);
  const ci = {
    sap: col('sap_id'), sec: col('sector_id'), az: col('azimuth'),
    lat: col('latitude'), lon: col('longitude'), set: col('set_id')
  };
  for(const [k,v] of Object.entries(ci)){
    if(v<0) throw new Error('Missing required column: '+({sap:'sap_id',sec:'sector_id',az:'azimuth',lat:'latitude',lon:'longitude',set:'set_id'})[k]);
  }
  const rows=[];
  for(let i=h+1;i<lines.length;i++){
    const ln=lines[i];
    if(!ln || ln.trim()==='') continue;
    const p=ln.split(',');
    const la=parseFloat(p[ci.lat]), lo=parseFloat(p[ci.lon]), a=parseFloat(p[ci.az]);
    const sid=parseInt(p[ci.set],10);
    if(!isFinite(la)||!isFinite(lo)||!isFinite(a)||!Number.isFinite(sid)) continue;
    rows.push([ (p[ci.sap]||'').trim(), (p[ci.sec]||'').trim(), a, la, lo, sid ]);
  }
  return rows;
}

// Turn parsed rows into the typed arrays the renderer uses
function ingest(rows){
  N = rows.length;
  if(N===0) throw new Error('No valid data rows found');
  lat=new Float32Array(N); lon=new Float32Array(N); az=new Uint16Array(N);
  suffix=new Uint8Array(N); setId=new Uint32Array(N);
  siteOf=new Uint32Array(N);
  sites=[]; const sidx=new Map();
  const us=new Set();
  for(let i=0;i<N;i++){
    const [sap,sec,a,la,lo,sid]=rows[i];
    lat[i]=la; lon[i]=lo; az[i]=((Math.round(a)%360)+360)%360;
    let si=sidx.get(sap);
    if(si===undefined){ si=sites.length; sidx.set(sap,si); sites.push(sap); }
    siteOf[i]=si;
    // sector suffix = trailing number after last '_' in sector_id
    const m=sec.lastIndexOf('_');
    const sfx = m>=0 ? parseInt(sec.slice(m+1),10) : NaN;
    suffix[i]= Number.isFinite(sfx) ? (sfx & 0xFF) : 0;
    setId[i]=sid>=0 ? sid : 0;
    us.add(setId[i]);
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
  refreshSetList(); draw();
}
function secId(i){ return sites[siteOf[i]]+'_'+suffix[i]; }
function colorFor(i){ return SEC_COLORS[suffix[i]] || "#8b949e"; }

const map=new maplibregl.Map({
  container:'map', style:'https://tiles.openfreemap.org/styles/dark',
  center:[80.5,17.0], zoom:5, maxZoom:18
});

// custom control: live zoom-level readout, stacked into the bottom-right control group
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
map.addControl(new ZoomReadout(),'bottom-right');       // added first -> sits on top
map.addControl(new maplibregl.NavigationControl(),'bottom-right');

const cv=document.getElementById('overlay'),ctx=cv.getContext('2d');
let dpr=window.devicePixelRatio||1;
function resize(){
  dpr=window.devicePixelRatio||1;
  const mc=map.getCanvas();
  const w=mc.clientWidth, h=mc.clientHeight;
  cv.width=Math.round(w*dpr); cv.height=Math.round(h*dpr);
  cv.style.width=w+'px'; cv.style.height=h+'px';
}
// re-sync overlay to the map size if they ever drift (e.g. layout settled after load)
function ensureSize(){
  const mc=map.getCanvas();
  const w=mc.clientWidth, h=mc.clientHeight;
  if(cv.width!==Math.round(w*dpr) || cv.height!==Math.round(h*dpr)) resize();
}
let visList=[];

// Convert a ground distance (meters) at a given lon/lat to a screen-pixel radius,
// using MapLibre's own projection so it's correct at any zoom/latitude (no tile-size assumptions).
// `apex` is the already-projected screen point of (lon,lat) to avoid re-projecting.
function metersToPixels(distM, lon, lat, apex){
  const north=destPoint(lat,lon,distM,0);      // point distM meters due north -> [lat,lon]
  const p=map.project([north[1],north[0]]);
  return Math.hypot(p.x-apex.x, p.y-apex.y);
}

// draw: only sectors whose set is selected. Radius is either fixed pixels or real meters.
function draw(){
  ensureSize();
  ctx.clearRect(0,0,cv.width,cv.height);
  visList.length=0;
  const z=map.getZoom();
  document.getElementById('zval').textContent=z.toFixed(1);
  if(selected.size===0){
    document.getElementById('vis').textContent='0';
    // still draw searched-site dot and measure overlay
    if(searchedSap!==null){
      const idx=sites.indexOf(searchedSap);
      if(idx>=0) for(let i=0;i<N;i++){ if(siteOf[i]===idx){ const p=map.project([lon[i],lat[i]]); drawSiteDots([[p.x,p.y]],true); break; } }
    }
    drawMeasure();
    return;
  }
  const b=map.getBounds(),w=b.getWest(),e=b.getEast(),s=b.getSouth(),n=b.getNorth(),pad=0.02;
  let count=0;
  ctx.lineWidth=1.2*dpr;
  const siteDots=new Map();   // site index -> [screenX, screenY], for yellow highlight
  for(let i=0;i<N;i++){
    if(!selected.has(setId[i])) continue;
    const la=lat[i],lo=lon[i];
    if(lo<w-pad||lo>e+pad||la<s-pad||la>n+pad) continue;
    const apex=map.project([lo,la]);
    const col=colorFor(i);
    const a0deg=az[i]-HALF_BW, a1deg=az[i]+HALF_BW;
    if(sizeMode==='m'){
      // ---- geodesic fan: trace the arc as real lat/lon points, project each ----
      const STEP=Math.max(2, (2*HALF_BW)/48);   // ~48 segments across the arc
      const poly=[[apex.x,apex.y]];             // start at apex (screen px)
      for(let a=a0deg; a<=a1deg+1e-6; a+=STEP){
        const gp=destPoint(la,lo,sectorRadiusM,a);   // [lat,lon] on the arc
        const p=map.project([gp[1],gp[0]]);
        poly.push([p.x,p.y]);
      }
      ctx.beginPath();
      ctx.moveTo(poly[0][0]*dpr,poly[0][1]*dpr);
      for(let k=1;k<poly.length;k++) ctx.lineTo(poly[k][0]*dpr,poly[k][1]*dpr);
      ctx.closePath();
      ctx.fillStyle=col+'3a';ctx.strokeStyle=col+'ee';ctx.fill();ctx.stroke();
      if(count<80000) visList.push({i,ax:apex.x,ay:apex.y,poly});
    } else {
      // ---- fast screen-circle wedge (px mode: size is purely visual) ----
      const rpx = sectorRadiusPx;
      const h0=(HALF_BW)*Math.PI/180;
      const center=(az[i]-90)*Math.PI/180;
      const ang0=center-h0, ang1=center+h0;
      ctx.beginPath();
      ctx.moveTo(apex.x*dpr,apex.y*dpr);
      ctx.arc(apex.x*dpr,apex.y*dpr,rpx*dpr,ang0,ang1);
      ctx.closePath();
      ctx.fillStyle=col+'3a';ctx.strokeStyle=col+'ee';ctx.fill();ctx.stroke();
      if(count<80000) visList.push({i,ax:apex.x,ay:apex.y,rpx,ang0,ang1});
    }
    siteDots.set(siteOf[i],[apex.x,apex.y]);
    count++;
  }
  // yellow site dots on sites belonging to selected sets
  drawSiteDots([...siteDots.values()]);
  // yellow dot on the searched site (even if its set isn't selected)
  if(searchedSap!==null){
    const idx=sites.indexOf(searchedSap);
    if(idx>=0){
      // find any record for this site to get its coords
      for(let i=0;i<N;i++){ if(siteOf[i]===idx){ const p=map.project([lon[i],lat[i]]); drawSiteDots([[p.x,p.y]],true); break; } }
    }
  }
  drawMeasure();
  document.getElementById('vis').textContent=count.toLocaleString();
}

function drawSiteDots(pts, ring){
  for(const [x,y] of pts){
    ctx.beginPath();
    ctx.arc(x*dpr,y*dpr,(ring?5:3.2)*dpr,0,TWO_PI);
    ctx.fillStyle=SITE_DOT;
    ctx.fill();
    ctx.lineWidth=1.4*dpr; ctx.strokeStyle="#0d1117";
    ctx.stroke();
    if(ring){ // extra ring to make searched site pop
      ctx.beginPath();ctx.arc(x*dpr,y*dpr,9*dpr,0,TWO_PI);
      ctx.strokeStyle=SITE_DOT;ctx.lineWidth=1.6*dpr;ctx.stroke();
    }
  }
}

// haversine great-circle distance in meters
function haversine(lo1,la1,lo2,la2){
  const R=6371008.8, toR=Math.PI/180;
  const dLa=(la2-la1)*toR, dLo=(lo2-lo1)*toR;
  const a=Math.sin(dLa/2)**2 + Math.cos(la1*toR)*Math.cos(la2*toR)*Math.sin(dLo/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function fmtDist(m){
  return m>=1000 ? (m/1000).toFixed(2)+' km' : Math.round(m)+' m';
}

function drawMeasure(){
  if(measurePts.length===0) return;
  // edge lines first (so apex markers sit on top)
  if(measurePts.length===2){
    for(const e of measureEdges){
      if(hiddenLines.has(e.key)) continue;
      const f=map.project([e.from[0],e.from[1]]);
      const t=map.project([e.to[0],e.to[1]]);
      ctx.beginPath();
      ctx.moveTo(f.x*dpr,f.y*dpr);ctx.lineTo(t.x*dpr,t.y*dpr);
      ctx.lineWidth=2.4*dpr;ctx.strokeStyle=e.col;ctx.stroke();
      // markers at both ends (edge-edge line has no apex endpoint)
      for(const pt of [f,t]){
        ctx.beginPath();ctx.arc(pt.x*dpr,pt.y*dpr,4*dpr,0,TWO_PI);
        ctx.fillStyle=e.col;ctx.fill();
        ctx.lineWidth=1.4*dpr;ctx.strokeStyle="#0d1117";ctx.stroke();
      }
    }
  }
  // apex-to-apex straight line (white dashed) = A \u2194 B
  if(measurePts.length===2 && !hiddenLines.has('ab')){
    const a=map.project([measurePts[0].lon,measurePts[0].lat]);
    const b=map.project([measurePts[1].lon,measurePts[1].lat]);
    ctx.beginPath();
    ctx.setLineDash([6*dpr,5*dpr]);
    ctx.moveTo(a.x*dpr,a.y*dpr);ctx.lineTo(b.x*dpr,b.y*dpr);
    ctx.lineWidth=2*dpr;ctx.strokeStyle="#ffffff";ctx.stroke();
    ctx.setLineDash([]);
  }
  // picked point markers (white) with A / B labels
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

// build the "sets in view" list (ascending), independent of selection
function refreshSetList(){
  const b=map.getBounds(),w=b.getWest(),e=b.getEast(),s=b.getSouth(),n=b.getNorth(),pad=0.02;
  const seen=new Map(); // set_id -> sector count in view
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
    return '<label'+cls+' data-id="'+id+'"><input type="checkbox"'+sel+'> Set '+id+
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
  draw();
}


document.getElementById('clearSel').addEventListener('click',()=>{
  selected.clear();
  document.getElementById('selN').textContent='0';
  refreshSetList(); draw();
});

const sizeRange=document.getElementById('sizeRange');
const sizeVal=document.getElementById('sizeVal');
const sizeUnit=document.getElementById('sizeUnit');
const btnPx=document.getElementById('modePx'), btnM=document.getElementById('modeM');

// display a meter value, switching to km for readability at large sizes
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
  draw();
}
sizeRange.addEventListener('input',e=>{
  const v=+e.target.value;
  if(sizeMode==='px'){ sectorRadiusPx=v; sizeVal.textContent=v; }
  else { sectorRadiusM=v; sizeVal.textContent=fmtMeters(v); }
  draw();
});
btnPx.addEventListener('click',()=>applyMode('px'));
btnM.addEventListener('click',()=>applyMode('m'));

const bw120=document.getElementById('bw120'), bw180=document.getElementById('bw180');
function applyBeamwidth(deg){
  beamwidth=deg; HALF_BW=deg/2;
  bw120.classList.toggle('active', deg===120);
  bw180.classList.toggle('active', deg===180);
  document.getElementById('subBw').textContent=deg;
  draw();
}
bw120.addEventListener('click',()=>applyBeamwidth(120));
bw180.addEventListener('click',()=>applyBeamwidth(180));

// ---------- measure tool ----------
const measureBtn=document.getElementById('measureBtn');
const measureOut=document.getElementById('measureOut');
const SNAP_PX=14; // click within this many px of a drawn apex snaps to that sector/site

function setMeasureMode(on){
  measureMode=on;
  measureBtn.classList.toggle('active',on);
  map.getCanvas().style.cursor = on ? 'crosshair' : '';
  if(!on){ /* keep last result visible until cleared */ }
  else { measurePts=[]; renderMeasureOut(); draw(); }
}
measureBtn.addEventListener('click',()=>setMeasureMode(!measureMode));

// nearest drawn apex (sector) to a screen point, within SNAP_PX
function snapToSector(mx,my){
  let best=null,bd=SNAP_PX;
  for(const v of visList){
    const d=Math.hypot(mx-v.ax,my-v.ay);
    if(d<bd){bd=d;best=v;}
  }
  return best;
}

// closest distance (m) from an external point to a sector's fan.
// fan = wedge of angular half-width HALF_BW around azimuth, radius = current display radius in meters.
function distToFanEdge(fromLon,fromLat, i){
  // sector apex
  const alon=lon[i], alat=lat[i];
  const radM=fanRadiusM(i);
  // bearing & distance from apex to the external point
  const distAP=haversine(alon,alat,fromLon,fromLat);
  const brg=bearing(alat,alon,fromLat,fromLon);           // 0..360 from apex to point
  // angular offset from sector centre azimuth, wrapped to [-180,180]
  let da=((brg-az[i]+540)%360)-180;
  const within = Math.abs(da)<=HALF_BW;
  // Returns {dist, pt:[lon,lat]} where pt is the nearest point on the fan boundary.
  if(within){
    // nearest boundary point lies along the same bearing, at radius radM (the arc)
    const ep=destPoint(alat,alon,radM,brg);
    return {dist:Math.abs(distAP - radM), pt:[ep[1],ep[0]]};
  } else {
    // project onto the nearest radial edge (at azimuth az±HALF_BW), clamped to [0,radM]
    const edgeAz = az[i] + (da>0 ? HALF_BW : -HALF_BW);
    const proj = distAP*Math.cos((da - (da>0?HALF_BW:-HALF_BW))*Math.PI/180);
    const clamped=Math.max(0,Math.min(radM,proj));
    const ep=destPoint(alat,alon,clamped,edgeAz);
    return {dist:haversine(ep[1],ep[0], fromLon,fromLat), pt:[ep[1],ep[0]]};
  }
}
// initial bearing from (la1,lo1) to (la2,lo2) in degrees 0..360
function bearing(la1,lo1,la2,lo2){
  const toR=Math.PI/180;
  const y=Math.sin((lo2-lo1)*toR)*Math.cos(la2*toR);
  const x=Math.cos(la1*toR)*Math.sin(la2*toR)-Math.sin(la1*toR)*Math.cos(la2*toR)*Math.cos((lo2-lo1)*toR);
  return (Math.atan2(y,x)/toR+360)%360;
}
// destination point [lat,lon] given start, distance (m), bearing (deg)
function destPoint(la,lo,distM,brg){
  const R=6371008.8,toR=Math.PI/180,dr=distM/R;
  const b=brg*toR,l1=la*toR,g1=lo*toR;
  const l2=Math.asin(Math.sin(l1)*Math.cos(dr)+Math.cos(l1)*Math.sin(dr)*Math.cos(b));
  const g2=g1+Math.atan2(Math.sin(b)*Math.sin(dr)*Math.cos(l1), Math.cos(dr)-Math.sin(l1)*Math.sin(l2));
  return [l2/toR, g2/toR];
}

// fan display radius (meters) for sector i, honoring px/m mode
function fanRadiusM(i){
  if(sizeMode==='m') return sectorRadiusM;
  const alon=lon[i], alat=lat[i];
  const apex=map.project([alon,alat]);
  const ppm=metersToPixels(1000, alon, alat, apex)/1000; // px per meter
  return ppm>0 ? sectorRadiusPx/ppm : 0;
}
// sample points along a fan's outline (apex + two radial edges + arc), as [lon,lat]
function fanBoundaryPts(i){
  const alat=lat[i], alon=lon[i], radM=fanRadiusM(i);
  const a0=az[i]-HALF_BW, a1=az[i]+HALF_BW;
  const pts=[[alon,alat]];                       // apex
  const EDGE_STEPS=8, ARC_STEP=Math.max(2,(2*HALF_BW)/40);
  // outbound along first radial edge
  for(let s=1;s<=EDGE_STEPS;s++){ const g=destPoint(alat,alon,radM*s/EDGE_STEPS,a0); pts.push([g[1],g[0]]); }
  // along the arc
  for(let a=a0;a<=a1+1e-6;a+=ARC_STEP){ const g=destPoint(alat,alon,radM,a); pts.push([g[1],g[0]]); }
  // back along second radial edge
  for(let s=EDGE_STEPS-1;s>=1;s--){ const g=destPoint(alat,alon,radM*s/EDGE_STEPS,a1); pts.push([g[1],g[0]]); }
  return pts;
}
// shortest distance (m) between two fans' outlines, plus the closest pair of points
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
    measureEdges=[];
    const C1="#f59e0b", C2="#22d3ee", C3="#c084fc";  // amber=A→B edge, cyan=B→A edge, purple=edge↔edge
    // a row with a clickable swatch that toggles line `key`
    function row(key,col,label,dist){
      const off=hiddenLines.has(key);
      return '<div class="mline'+(off?' off':'')+'">'+
        '<span class="msw" data-line="'+key+'" style="background:'+col+'" title="toggle line"></span>'+
        '<span class="mk">'+label+'</span> <b>'+fmtDist(dist)+'</b></div>';
    }
    // A ↔ B straight line (drawn separately, not in measureEdges)
    let html=row('ab','#ffffff','A \u2194 B',d);
    // A → B's fan edge (B is a sector)
    if(B.i!=null){
      const fe=distToFanEdge(A.lon,A.lat,B.i);
      measureEdges.push({key:'ab_edge', from:[A.lon,A.lat], to:fe.pt, col:C1});
      html+=row('ab_edge',C1,'A \u2192 B edge',fe.dist);
    }
    // B → A's fan edge (A is a sector)
    if(A.i!=null){
      const fe=distToFanEdge(B.lon,B.lat,A.i);
      measureEdges.push({key:'ba_edge', from:[B.lon,B.lat], to:fe.pt, col:C2});
      html+=row('ba_edge',C2,'B \u2192 A edge',fe.dist);
    }
    // A edge ↔ B edge (both sectors): shortest gap between the two fan outlines
    if(A.i!=null && B.i!=null){
      const ff=fanToFanDist(A.i,B.i);
      measureEdges.push({key:'ee', from:ff.from, to:ff.to, col:C3});
      const lbl = ff.dist<1 ? 'A edge \u2194 B edge <span class="mk">(overlap)</span>' : 'A edge \u2194 B edge';
      html+=row('ee',C3,lbl,ff.dist);
    }
    html+='<div class="mhint">tip: click a color to hide/show its line</div>';
    html+='<button class="mclear" id="mClear">Clear</button>';
    measureOut.innerHTML=html;
    // wire swatch toggles
    measureOut.querySelectorAll('.msw[data-line]').forEach(el=>{
      el.addEventListener('click',()=>{
        const k=el.dataset.line;
        if(hiddenLines.has(k)) hiddenLines.delete(k); else hiddenLines.add(k);
        renderMeasureOut(); draw();
      });
    });
  }
  const c=document.getElementById('mClear');
  if(c) c.addEventListener('click',()=>{measurePts=[];hiddenLines.clear();renderMeasureOut();draw();});
}

// click handler for measuring
map.getCanvas().addEventListener('click',ev=>{
  if(!measureMode) return;
  const rect=map.getCanvas().getBoundingClientRect();
  const mx=ev.clientX-rect.left,my=ev.clientY-rect.top;
  const snap=snapToSector(mx,my);
  let pt;
  if(snap){ pt={lon:lon[snap.i],lat:lat[snap.i],i:snap.i}; }
  else { const ll=map.unproject([mx,my]); pt={lon:ll.lng,lat:ll.lat,i:null}; }
  if(measurePts.length>=2){ measurePts=[]; hiddenLines.clear(); }
  pt.label = measurePts.length===0 ? 'A' : 'B';
  measurePts.push(pt);
  renderMeasureOut();
  draw();
});

(function init(){
  map.on('load',()=>{
    map.resize();               // pick up the flex-sized #stage container
    resize(); refreshSetList(); draw();
    document.getElementById('loading').style.display='none';
    requestAnimationFrame(()=>{map.resize();resize();draw();});
  });
  map.on('move',()=>{draw();});
  map.on('moveend',()=>{refreshSetList();});
  map.on('zoom',()=>{draw();});
  map.on('resize',()=>{resize();draw();});
  window.addEventListener('resize',()=>{map.resize();resize();draw();});
})();

// ---- sidebar collapse toggle ----
const appEl=document.getElementById('app');
const sidebarEl=document.getElementById('sidebar');
document.getElementById('sidebarToggle').addEventListener('click',()=>{
  appEl.classList.toggle('collapsed');
  // let the sidebar slide via pure CSS; reflow the map + overlay once, after it settles
});
// fires when the sidebar's width/height transition finishes -> single map reflow
sidebarEl.addEventListener('transitionend',ev=>{
  if(ev.propertyName!=='width' && ev.propertyName!=='height') return;
  map.resize(); resize(); draw();
});

// ---- map style selector ----
document.getElementById('styleSel').addEventListener('change',e=>{
  const key=e.target.value;
  // the sector overlay lives on a separate canvas, so it survives setStyle;
  // redraw once the new basemap style has loaded
  map.once('styledata',()=>{ resize(); draw(); });
  map.setStyle('https://tiles.openfreemap.org/styles/'+key);
});


// ---- data picker (file input + drag & drop) ----
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
    // fit the map to the loaded data extent
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

// hover
const tip=document.getElementById('tip');
const TWO_PI=Math.PI*2;
// azimuth degrees -> 8-point cardinal direction
function compass(deg){
  const dirs=['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(((deg%360)/45))%8];
}
// does screen-space angle `a` fall on the canvas arc swept from ang0 to ang1
// (canvas arc default sweeps in increasing-angle / clockwise-on-screen direction)?
function onArc(a,ang0,ang1){
  let sweep=ang1-ang0;
  while(sweep<0)sweep+=TWO_PI;
  while(sweep>=TWO_PI)sweep-=TWO_PI;
  let rel=a-ang0;
  while(rel<0)rel+=TWO_PI;
  while(rel>=TWO_PI)rel-=TWO_PI;
  return rel<=sweep;
}
// ray-casting point-in-polygon test; poly = array of [x,y] screen points
function pointInPoly(px,py,poly){
  let inside=false;
  for(let a=0,b=poly.length-1;a<poly.length;b=a++){
    const xi=poly[a][0],yi=poly[a][1],xj=poly[b][0],yj=poly[b][1];
    if(((yi>py)!==(yj>py)) && (px < (xj-xi)*(py-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}
// is screen point (mx,my) inside sector entry v (handles circle and polygon shapes)?
function hitSector(v,mx,my){
  if(v.poly) return pointInPoly(mx,my,v.poly);
  const dx=mx-v.ax,dy=my-v.ay;
  if(Math.hypot(dx,dy)>v.rpx) return false;
  return onArc(Math.atan2(dy,dx),v.ang0,v.ang1);
}
map.getCanvas().addEventListener('mousemove',ev=>{
  if(measureMode){tip.style.display='none';return;}   // crosshair + no tooltip while measuring
  if(selected.size===0){tip.style.display='none';map.getCanvas().style.cursor='';return;}
  const rect=map.getCanvas().getBoundingClientRect();
  const mx=ev.clientX-rect.left,my=ev.clientY-rect.top;
  let hit=null;
  for(let k=visList.length-1;k>=0;k--){
    if(hitSector(visList[k],mx,my)){hit=visList[k];break;}
  }
  if(hit){
    const i=hit.i;
    const col=colorFor(i);
    const dir=compass(az[i]);
    tip.innerHTML=
      '<div class="thd"><span class="tsw" style="background:'+col+'"></span>'+
      '<span class="sid">'+secId(i)+'</span></div>'+
      '<div class="trow"><span class="tk">Set</span><span class="tv">'+setId[i]+'</span></div>'+
      '<div class="trow"><span class="tk">Azimuth</span><span class="tv">'+az[i]+'\u00b0 '+dir+'</span></div>'+
      '<div class="trow"><span class="tk">Beamwidth</span><span class="tv">'+beamwidth+'\u00b0</span></div>'+
      '<div class="trow"><span class="tk">Lat, Lon</span><span class="tv">'+lat[i].toFixed(5)+', '+lon[i].toFixed(5)+'</span></div>';
    tip.style.display='block';
    // edge-aware placement: measure, then flip toward whichever side has room
    const tw=tip.offsetWidth, th=tip.offsetHeight, gap=14;
    let x=mx+gap, y=my+gap;
    if(x+tw>rect.width-6) x=mx-gap-tw;      // flip left near right edge
    if(y+th>rect.height-6) y=my-gap-th;     // flip up near bottom edge
    if(x<6) x=6;
    if(y<6) y=6;
    tip.style.left=x+'px'; tip.style.top=y+'px';
    map.getCanvas().style.cursor='pointer';
  } else {
    tip.style.display='none';
    map.getCanvas().style.cursor='';
  }
});

// SAP search (kept from before)
const q=document.getElementById('q'),go=document.getElementById('go'),resBox=document.getElementById('results');
function flyToSite(siteName){
  for(let i=0;i<N;i++){ if(sites[siteOf[i]]===siteName){ searchedSap=siteName; map.flyTo({center:[lon[i],lat[i]],zoom:15}); draw(); return true; } }
  return false;
}
function doSearch(){
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
