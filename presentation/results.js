/* Presentation-only rendering. Saved coordinates and labels are never modified. */
'use strict';
const project = JSON.parse(document.getElementById('project-data').textContent);
const number = n => n.toLocaleString('en-US');
const percent = n => (100*n).toFixed(1)+'%';
const clone = x => JSON.parse(JSON.stringify(x));
const palette = ['#2864c8','#b85612','#23835a','#8c52b1','#c53751','#008493',
  '#9a6b09','#5b55b2','#b34782','#517b27','#387fbb','#bb672d','#338477',
  '#a23f4e','#8662a1','#655c35','#00709e','#8b7134','#a24cba','#3c6a53',
  '#ad4e32','#5e678a','#b37e00','#237b7b'];
const NOISE = '#9ba6b3';
const cameraPresets = {
  clustering:{eye:{x:1.5,y:1.7,z:1.0},up:{x:0,y:0,z:1},center:{x:0,y:0,z:0},projection:{type:'perspective'}},
  depth:{eye:{x:1.5,y:-1.8,z:1.2},up:{x:0,y:0,z:1},center:{x:0,y:0,z:0},projection:{type:'perspective'}},
  top:{eye:{x:0,y:0,z:2.5},up:{x:0,y:1,z:0},center:{x:0,y:0,z:0},projection:{type:'orthographic'}}
};
let camera = clone(cameraPresets.depth), dragMode='orbit',viewSpace='geographic';
const plots = [document.getElementById('custom-plot'),document.getElementById('reference-plot')];
const state = window.resultsView = {ready:false,batch:1000,preset:'depth',dragMode,mode:'comparison',viewSpace,renderedBatches:[]};
let queue = Promise.resolve();
const west=project.bounds.longitude[0],east=project.bounds.longitude[1];
const south=project.bounds.latitude[0],north=project.bounds.latitude[1];
const maxDepth=Math.ceil(Math.max(...project.geographic_coordinates.map(p=>p[2]))/50)*50;
const ranges=[[west-.12,east+.12],[south-.12,north+.12],[maxDepth,-8]];
// Approximate equirectangular horizontal scaling at the study-box midlatitude.
// Coordinates and hover stay in degrees/km; this is not a metric distance plot.
const kmPerDegree=project.display.sphere_radius_km*Math.PI/180;
const spans=[(ranges[0][1]-ranges[0][0])*kmPerDegree*Math.cos(project.display.reference_latitude_deg*Math.PI/180),
  (ranges[1][1]-ranges[1][0])*kmPerDegree,
  (ranges[2][0]-ranges[2][1])*project.display.vertical_exaggeration];
const unit=Math.max(spans[0],spans[1]);
const metricRanges=[0,1,2].map(axis=>{const v=project.coordinates.map(p=>p[axis]);
  const lo=Math.min(...v),hi=Math.max(...v),pad=(hi-lo)*.06||1;return [lo-pad,hi+pad];});
const aspectratio={x:1.4*spans[0]/unit,y:1.4*spans[1]/unit,z:1.4*spans[2]/unit};

function surfaceTraces() {
  const x=[],y=[],z=[];
  for(const line of project.map.coastlines) {
    for(const [lon,lat] of line){x.push(lon);y.push(lat);z.push(0);}
    x.push(null);y.push(null);z.push(null);
  }
  return [
    // A filled mesh intercepts WebGL picking for earthquakes below it even
    // with hoverinfo:'skip'. Keep the zero-depth reference as an open outline.
    {type:'scatter3d',mode:'lines',name:'Surface reference (0 km)',meta:{role:'surface'},
      x:[west,east,east,west,west],y:[south,south,north,north,south],z:[0,0,0,0,0],
      line:{color:'#b6d1dd',width:1.5},hoverinfo:'skip',showlegend:false},
    {type:'scatter3d',mode:'lines',name:'Natural Earth coastline',meta:{role:'coastline'},
      x,y,z,line:{color:'#4d6b75',width:2.2},hoverinfo:'skip',showlegend:false,connectgaps:false},
    {type:'scatter3d',mode:'markers',name:'Orientation labels',meta:{role:'places'},
      x:project.map.places.map(p=>p.longitude),y:project.map.places.map(p=>p.latitude),
      z:project.map.places.map(()=>0),text:project.map.places.map(p=>p.name),
      textposition:project.map.places.map(p=>p.name==='Baguio'?'middle right':'top center'),
      textfont:{size:12,color:'#294a55'},marker:{size:2.5,color:'#294a55'},hoverinfo:'skip',showlegend:false},
    {type:'scatter3d',mode:'text',name:'Surface label',meta:{role:'surface-label'},
      x:[west+.3],y:[south+.35],z:[0],text:['Surface · 0 km'],
      textfont:{size:12,color:'#4d6b75'},hoverinfo:'skip',showlegend:false}
  ];
}

function locationLines(text) {
  const words=text.split(/\s+/),lines=[''];
  for(const word of words) {
    const last=lines.length-1;
    if(lines[last] && lines[last].length+word.length>43)lines.push(word);
    else lines[last]+=(lines[last]?' ':'')+word;
  }
  return lines.map(line=>line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')).join('<br>');
}
function traces(kind,n) {
  const batch = project.batches[n], labels = batch[kind];
  const coordinates=viewSpace==='metric'?project.coordinates:project.geographic_coordinates;
  const groups = [...new Set(labels)].sort((a,b)=>a-b);
  return groups.map(label => {
    const indices = labels.flatMap((value,i)=>value===label?[i]:[]);
    const colorIndex = batch.colors[kind][label];
    const color = label===-1 ? NOISE : palette[colorIndex] || `hsl(${(colorIndex*137.5)%360},58%,42%)`;
    return {type:'scatter3d',mode:'markers',meta:{role:'earthquake'},name:label===-1?'Noise (−1)':`Cluster ${label}`,
      x:indices.map(i=>coordinates[i][0]),y:indices.map(i=>coordinates[i][1]),
      z:indices.map(i=>coordinates[i][2]),
      customdata:indices.map(i=>[project.events[i][0],project.events[i][1],project.events[i][2],label,
        project.events[i][3],locationLines(project.events[i][3]),
        project.geographic_coordinates[i][1],project.geographic_coordinates[i][0]]),
      marker:{size:label===-1?3.0:4.2,color,opacity:label===-1?.6:.95},
      hovertemplate:'<b>%{customdata[0]}</b><br>Location: %{customdata[5]}<br>Latitude: %{customdata[6]:.2f}°N · Longitude: %{customdata[7]:.2f}°E<br>Catalog depth: %{customdata[1]:.0f} km'+
        '<br>Magnitude: %{customdata[2]:.1f}<br>Assigned cluster: %{customdata[3]}'+
        '<extra>'+ (kind==='custom'?'Custom':'Reference')+' · '+(label===-1?'Noise':`Cluster ${label}`)+'</extra>',
      showlegend:false};
  });
}
function layout() {
  const metric=viewSpace==='metric';
  const axis = i => ({title:{text:(metric?['Xc (km)','Yc (km)','Zc (km)']:['Longitude (°E)','Latitude (°N)','Depth (km) ↓'])[i],font:{size:12,color:'#53677b'}},
    range:(metric?metricRanges:ranges)[i],nticks:4,tickfont:{size:11,color:'#53677b'},showbackground:true,
    backgroundcolor:'#fafbfd',gridcolor:'#e2e8f0',zerolinecolor:'#d2dce7',showspikes:false,
    ...(!metric?(i===2?{tickmode:'array',tickvals:[0,50,100,150,200],ticktext:['0 · surface','50','100','150','200']}:{ticksuffix:i===0?'°E':'°N'}):{})});
  return {margin:{l:8,r:8,t:10,b:12},paper_bgcolor:'#ffffff',font:{family:'system-ui, sans-serif',color:'#172b40'},
    hoverlabel:{bgcolor:'#ffffff',font:{size:13,color:'#172b40'},namelength:-1},
    scene:{xaxis:axis(0),yaxis:axis(1),zaxis:{...axis(2),visible:metric||state.preset!=='top'},aspectmode:metric?'data':'manual',...(metric?{}:{aspectratio}),
      annotations:metric?[]:project.map.places.map(p=>({x:p.longitude,y:p.latitude,z:0,text:p.name,
        showarrow:false,xanchor:'right',xshift:-7,font:{size:12,color:'#294a55'},
        bgcolor:'rgba(255,255,255,0.88)',borderpad:2})),
      camera:clone(camera),uirevision:'coordinates-'+viewSpace,dragmode:dragMode},uirevision:'coordinates-'+viewSpace,showlegend:false};
}
const config = {responsive:true,displayModeBar:false,displaylogo:false,scrollZoom:true,showTips:false};

// Suppress programmatic echoes only on the target; retain the latest source camera
// during a drag, then flush again if it changed while the target was updating.
const updating = new Set();
let frame = null, sourcePlot = plots[0], busy = false, cameraUpdate=Promise.resolve();
function scheduleCamera() {
  if(frame!==null || busy)return;
  frame=requestAnimationFrame(async()=>{
    frame=null;busy=true;
    const snapshot=JSON.stringify(camera),target=sourcePlot===plots[0]?plots[1]:plots[0];
    updating.add(target);
    try { cameraUpdate=Plotly.relayout(target,{'scene.camera':JSON.parse(snapshot)}); await cameraUpdate; }
    finally {updating.delete(target);busy=false;if(JSON.stringify(camera)!==snapshot)scheduleCamera();}
  });
}
function acceptCamera(source,event) {
  if(updating.has(source)||!event['scene.camera'])return;
  const next=clone(event['scene.camera']);
  if(JSON.stringify(next)===JSON.stringify(camera))return;
  if(state.preset==='top')plots.forEach(p=>Plotly.relayout(p,{'scene.zaxis.visible':true}).catch(showError));
  camera=next;sourcePlot=source;state.preset='custom';updatePresetButtons();scheduleCamera();
}
// This pinned 3D renderer does not reliably emit camera events during wheel
// zoom. Read its live camera for a short settling window after native wheel
// events; no timer runs while the view is idle and no data/fit is recomputed.
let wheelSource=null,wheelUntil=0,wheelFrame=null;
function watchWheel(source) {
  wheelSource=source;wheelUntil=performance.now()+1000;
  if(wheelFrame!==null)return;
  function sample() {
    wheelFrame=null;
    const scene=wheelSource?._fullLayout?.scene?._scene;
    if(scene&&!updating.has(wheelSource))acceptCamera(wheelSource,{'scene.camera':scene.getCamera()});
    if(performance.now()<wheelUntil)wheelFrame=requestAnimationFrame(sample);
  }
  wheelFrame=requestAnimationFrame(sample);
}
async function renderBatch(n,first=false) {
  state.ready=false;
  const batch = project.batches[n], s=batch.summary;
  await Promise.all(plots.map((plot,i)=>Plotly[first?'newPlot':'react'](plot,[...(viewSpace==='metric'?[]:surfaceTraces()),...traces(i?'reference':'custom',n)],layout(),config)));
  if(first)plots.forEach(plot=>{
    plot.on('plotly_relayout',event=>acceptCamera(plot,event));
    plot.on('plotly_relayouting',event=>acceptCamera(plot,event));
    plot.addEventListener('wheel',()=>watchWheel(plot),{passive:true});
  });
  document.querySelectorAll('[data-batch]').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.batch)===n)));
  document.querySelectorAll('#comparison-table tbody tr').forEach(row=>row.dataset.active=String(Number(row.dataset.n)===n));
  document.getElementById('custom-detail').textContent=`${s.custom_clusters} clusters · ${percent(s.custom_noise_fraction)} noise`;
  document.getElementById('reference-detail').textContent=`${s.reference_clusters} clusters · ${percent(s.reference_noise_fraction)} noise`;
  const status = s.exact_partition_and_noise?'Exact partition and noise agreement':`${s.noise_membership_disagreements} noise-membership differences`;
  document.getElementById('current-summary').textContent=`${number(n)} identical input events · ARI ${s.ari.toFixed(4)} · ${status}`;
  state.batch=n;state.ready=true;state.renderedBatches.push(n);
}
function showError(error) {
  state.error=String(error);const box=document.getElementById('error');box.style.display='block';
  box.textContent='The 3D view could not render. A current browser with WebGL enabled is required. '+error;
  console.error(error);
}

const date = iso => new Intl.DateTimeFormat('en-US',{year:'numeric',month:'short',day:'numeric',timeZone:'Asia/Manila'}).format(new Date(iso));
document.getElementById('overview').innerHTML=`<strong>${number(project.total_events)} collected events</strong> · nested batches of 100, 200, 500 &amp; 1,000<br>`+
  `Custom HDBSCAN* vs. <strong>hdbscan ${project.baseline_version} · ${project.baseline_algorithm}</strong> · ${date(project.period[0])}–${date(project.period[1])}`;
document.getElementById('reference-title').textContent=`Reference · generic ${project.baseline_version}`;
document.getElementById('mcs').textContent=project.settings.min_cluster_size;
document.getElementById('ms').textContent=project.settings.min_samples;
const body=document.querySelector('#comparison-table tbody');
for(const b of Object.values(project.batches)) {
  const s=b.summary,row=document.createElement('tr');row.dataset.n=s.n;
  row.innerHTML=`<td>${number(s.n)}</td><td>${s.custom_clusters}</td><td>${s.reference_clusters}</td>`+
    `<td>${percent(s.custom_noise_fraction)}</td><td>${percent(s.reference_noise_fraction)}</td><td>${s.ari.toFixed(4)}</td>`+
    `<td><span class="status ${s.exact_partition_and_noise?'exact':''}">${s.exact_partition_and_noise?'Exact partition':'Different partition'}</span></td>`;
  body.append(row);
}
const storage=document.querySelector('#storage-table tbody');
for(const g of project.growth) {
  const row=document.createElement('tr');row.dataset.n=g.n;
  row.innerHTML=`<td>${number(g.n)}</td><td>${(g.matrix_bytes/1e6).toFixed(2)}</td><td>${(g.two_matrix_buffers_bytes/1e6).toFixed(2)}</td>`;
  storage.append(row);
}

function drawGrowth() {
  const svg=document.getElementById('growth-chart'),w=svg.clientWidth,h=255;
  if(!w)return;
  const m={left:58,right:28,top:30,bottom:46},maxY=Math.max(...project.growth.map(g=>g.quadratic_growth_vs_100));
  const ns=project.growth.map(g=>g.n),minN=Math.min(...ns),maxN=Math.max(...ns);
  const sx=n=>m.left+(n-minN)/(maxN-minN)*(w-m.left-m.right);
  const sy=v=>h-m.bottom-v/maxY*(h-m.top-m.bottom);
  const line=(x1,y1,x2,y2,stroke)=>`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}"/>`;
  const text=(x,y,t,anchor='middle',extra='')=>`<text x="${x}" y="${y}" text-anchor="${anchor}" ${extra}>${t}</text>`;
  let content='<title>Theoretical quadratic growth; not measured runtime</title><desc>Relative n squared work is 1, 4, 25, and 100 times the 100-event baseline.</desc>';
  for(const fraction of [0,.25,.5,.75,1]) {
    const v=maxY*fraction,y=sy(v);content+=line(m.left,y,w-m.right,y,'#e2e8f0')+text(m.left-9,y+4,number(v),'end');
  }
  content+=line(m.left,m.top,m.left,h-m.bottom,'#b5c2d1')+line(m.left,h-m.bottom,w-m.right,h-m.bottom,'#b5c2d1');
  let path='';
  for(let i=0;i<=90;i++) {const n=minN+(maxN-minN)*i/90;path+=(i?'L':'M')+sx(n)+','+sy((n/minN)**2);}
  content+=`<path d="${path}" fill="none" stroke="#2864c8" stroke-width="2.5"/>`;
  for(const g of project.growth) {
    const x=sx(g.n),y=sy(g.quadratic_growth_vs_100),anchor=g.n===maxN?'end':g.n===minN?'start':'middle';
    content+=`<circle data-n="${g.n}" cx="${x}" cy="${y}" r="4" fill="#2864c8"><title>${g.n} events: ${g.quadratic_growth_vs_100}× theoretical work</title></circle>`;
    content+=text(x,y-11,g.quadratic_growth_vs_100+'×',anchor);
    // Keep all four marks; omit the crowded 200-event tick on narrow screens.
    if(w>=420 || g.n!==200)content+=text(x,h-m.bottom+21,number(g.n),anchor);
  }
  content+=text(m.left,m.top-14,'Relative n² work (100 events = 1×)','start');
  content+=text((m.left+w-m.right)/2,h-4,'Cleaned events, n');
  svg.setAttribute('viewBox',`0 0 ${w} ${h}`);svg.innerHTML=content;
  svg.querySelectorAll('text').forEach(t=>{t.setAttribute('fill','#53677b');t.setAttribute('font-size','12');t.setAttribute('font-family','system-ui, sans-serif');});
}
new ResizeObserver(drawGrowth).observe(document.getElementById('growth-chart'));
drawGrowth();

const diagnostics=project.diagnostics,intervals=diagnostics.reduce((sum,d)=>sum+d.lifetime_audit.positive_intervals_checked,0);
const maxError=Math.max(...diagnostics.map(d=>d.lifetime_audit.max_stability_integral_error));
const shared=diagnostics.every(d=>d.reference_hierarchy_our_stages_ari===1&&d.custom_hierarchy_reference_stages_ari===1&&d.reference_hierarchy_noise_equal&&d.custom_hierarchy_noise_equal);
const minMST=diagnostics.filter(d=>d.mst_audit.spanning_components===1&&d.mst_audit.absolute_weight_difference===0).length;
const checks=[`<strong>${minMST}/${diagnostics.length} MSTs:</strong> span all events; minimum total weight equals independent SciPy Kruskal.`,
  `<strong>${number(intervals)} positive intervals:</strong> checked against actual graph components. Stability integral error ≤ ${maxError.toExponential(2)}.`,
  `<strong>Shared binary hierarchy:</strong> ${shared?'ARI = 1 and identical noise masks for every batch.':'see diagnostic differences.'}`,
  `<strong>${project.tests_reported} correctness tests</strong> recorded passing in the existing report. Coverage includes ties, zero distances, noise, and EOM selection.`];
document.getElementById('checks').innerHTML=checks.map(t=>'<li>'+t+'</li>').join('');
const sources=document.getElementById('sources');
for(const [path,hash] of Object.entries(project.sources)) {const li=document.createElement('li');li.textContent=`${path} · SHA-256 ${hash.slice(0,16)}…`;sources.append(li);}

document.querySelectorAll('[data-batch]').forEach(button=>button.addEventListener('click',()=>{
  queue=queue.then(()=>renderBatch(Number(button.dataset.batch))).catch(showError);
}));
async function applyDisplayMode(mode) {
  state.ready=false;
  if(wheelFrame!==null){cancelAnimationFrame(wheelFrame);wheelFrame=null;}
  wheelSource=null;wheelUntil=0;
  if(frame!==null){cancelAnimationFrame(frame);frame=null;}
  await cameraUpdate;
  const container=document.getElementById('result-plots');
  container.dataset.mode=mode;
  document.getElementById('custom-panel').hidden=mode==='reference';
  document.getElementById('reference-panel').hidden=mode==='custom';
  const visible=plots.filter(p=>!p.closest('.plot-panel').hidden);
  // Reveal before resizing: Plotly cannot measure a display:none container.
  await new Promise(resolve=>requestAnimationFrame(resolve));
  visible.forEach(p=>updating.add(p));
  try {
    await Promise.all(visible.map(p=>Plotly.Plots.resize(p)));
    await Promise.all(visible.map(p=>Plotly.relayout(p,{'scene.camera':clone(camera),'scene.dragmode':dragMode})));
  } finally {visible.forEach(p=>updating.delete(p));}
  sourcePlot=visible[0];
  document.querySelectorAll('[data-display-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.displayMode===mode)));
  document.getElementById('mode-description').textContent={custom:'Custom implementation · full-width view',
    reference:'Pinned generic reference · full-width view',comparison:'Side-by-side comparison · linked cameras'}[mode];
  state.mode=mode;state.ready=true;
}
document.querySelectorAll('[data-display-mode]').forEach(button=>button.addEventListener('click',()=>{
  queue=queue.then(()=>applyDisplayMode(button.dataset.displayMode)).catch(showError);
}));
function updateCoordinateNote() {
  const metric=viewSpace==='metric';
  document.getElementById('coordinate-note').innerHTML=metric
    ? '<strong>Original clustering view:</strong> the exact centered spherical Cartesian Xc, Yc, Zc coordinates used for clustering, all in kilometers with equal physical axis scale. <strong>Zc is not earthquake depth.</strong> Catalog depth and geographic position remain available on hover. No vertical exaggeration is applied here.'
    : geographicNote;
  document.querySelector('.map-credit').hidden=metric;
}
const geographicNote=document.getElementById('coordinate-note').innerHTML;
function updatePresetButtons() {
  for(const name of ['top','depth','clustering'])document.getElementById(name+'-view').setAttribute('aria-pressed',String(name==='clustering'?viewSpace==='metric':state.preset===name));
}
async function applyPreset(name,reset=false) {
  if(wheelFrame!==null){cancelAnimationFrame(wheelFrame);wheelFrame=null;}
  wheelSource=null;wheelUntil=0;
  if(frame!==null){cancelAnimationFrame(frame);frame=null;}
  await cameraUpdate;
  camera=clone(cameraPresets[name]);
  const nextSpace=name==='clustering'?'metric':'geographic',changed=nextSpace!==viewSpace;
  viewSpace=nextSpace;state.viewSpace=viewSpace;state.preset=name;
  if(reset)dragMode='orbit';
  plots.forEach(p=>updating.add(p));
  try {
    if(changed)await renderBatch(state.batch);
    await Promise.all(plots.map(p=>Plotly.relayout(p,{'scene.camera':clone(camera),'scene.dragmode':dragMode,'scene.zaxis.visible':name!=='top'})));
  }
  finally {plots.forEach(p=>updating.delete(p));}
  state.preset=name;state.dragMode=dragMode;document.getElementById('drag-mode').value=dragMode;updatePresetButtons();updateCoordinateNote();
}
for(const name of ['top','depth','clustering'])document.getElementById(name+'-view').addEventListener('click',()=>{
  queue=queue.then(()=>applyPreset(name)).catch(showError);
});
document.getElementById('reset').addEventListener('click',()=>{
  queue=queue.then(()=>applyPreset(viewSpace==='metric'?'clustering':'depth',true)).catch(showError);
});
document.getElementById('drag-mode').addEventListener('change',event=>{
  const mode=event.target.value;
  queue=queue.then(async()=>{
    dragMode=mode;
    await Promise.all(plots.map(p=>Plotly.relayout(p,{'scene.dragmode':mode})));
    state.dragMode=mode;
  }).catch(showError);
});
queue=renderBatch(1000,true).then(()=>applyDisplayMode('custom')).catch(showError);
