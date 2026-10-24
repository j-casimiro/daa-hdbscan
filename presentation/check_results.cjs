/* Optional browser smoke check: NODE_PATH pointing to Playwright, node this file.
   Uses an isolated browser context and never opens the user's browser profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');
const root = path.resolve(__dirname,'..');
const expected = JSON.parse(fs.readFileSync(path.join(root,'results/comparison.json')));
(async()=>{
 const browser = await chromium.launch({headless:true,
   ...(process.env.RESULTS_CHROME_PATH?{executablePath:process.env.RESULTS_CHROME_PATH}:{}),
   args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try {
  const context=await browser.newContext({viewport:{width:1440,height:1100},offline:true});
  const page=await context.newPage();
  const errors=[],external=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('request',r=>{if(/^https?:/.test(r.url()))external.push(r.url());});
  await page.goto(pathToFileURL(path.join(root,'results.html')).href);
  await page.waitForFunction(()=>window.resultsView?.ready||window.resultsView?.error,null,{timeout:30000});
  assert.equal(await page.evaluate(()=>window.resultsView.error),undefined);
  assert.equal(await page.evaluate(()=>Plotly.version),'2.35.2');
  await page.evaluate(()=>{
   // Read the renderer's live camera. Plotly's layout snapshot can be stale
   // after a UI drag following react(), even though the actual view moves.
   window.readCamera=id=>document.getElementById(id)._fullLayout.scene._scene.getCamera();
   window.sameCameras=()=>{
    const a=readCamera('custom-plot'),b=readCamera('reference-plot');
    return ['eye','up','center'].every(k=>['x','y','z'].every(axis=>Math.abs(a[k][axis]-b[k][axis])<1e-7));
   };
  });
  await page.waitForFunction(()=>window.resultsView.ready&&window.resultsView.mode==='custom');
  assert.equal(await page.locator('#reference-panel').isVisible(),false);
  assert.ok((await page.locator('#custom-plot').boundingBox()).width>900);
  await page.locator('[data-display-mode="comparison"]').click();
  await page.waitForFunction(()=>window.resultsView.ready&&window.resultsView.mode==='comparison');
  for(const summary of expected.batches) {
   await page.locator(`[data-batch="${summary.n}"]`).click();
   await page.waitForFunction(n=>window.resultsView.ready&&window.resultsView.batch===n,summary.n);
   const actual=await page.evaluate(()=>{
    const payload=JSON.parse(document.getElementById('project-data').textContent);
    const n=window.resultsView.batch,b=payload.batches[n];
    const plots=['custom','reference'].map(kind=>{
     const g=document.getElementById(kind+'-plot'),seen=[];
     for(const trace of g.data.filter(t=>t.meta?.role==='earthquake')) {
      if(trace.customdata[0][3]===-1)assertColor(trace.marker.color,'#9ba6b3');
      for(let j=0;j<trace.x.length;j++) {
       const [id,depth,mag,label,location,,latitude,longitude]=trace.customdata[j];
       const i=payload.events.findIndex(e=>e[0]===id);
       if(i<0||i>=n)throw Error('Unexpected hover event ID');
       if(latitude!==payload.geographic_coordinates[i][1]||longitude!==payload.geographic_coordinates[i][0])throw Error('Geographic hover mismatch');
       if(depth!==payload.events[i][1]||mag!==payload.events[i][2]||location!==payload.events[i][3]||label!==b[kind][i])throw Error('Hover mismatch');
       if(trace.x[j]!==payload.geographic_coordinates[i][0]||trace.y[j]!==payload.geographic_coordinates[i][1]||trace.z[j]!==payload.geographic_coordinates[i][2])throw Error('Coordinate mismatch');
       seen.push(i);
      }
     }
     if(new Set(seen).size!==n||seen.length!==n)throw Error('Lost or repeated points');
     const axes=g.layout.scene;
     if(axes.xaxis.title.text!=='Longitude (°E)'||axes.yaxis.title.text!=='Latitude (°N)'||axes.zaxis.title.text!=='Depth (km) ↓'||axes.aspectmode!=='manual')throw Error('Incorrect geographic units/scaling');
     if(axes.zaxis.range[0]<=axes.zaxis.range[1]||axes.zaxis.range[1]>=0)throw Error('Depth not downward below surface');
     for(const t of g.data.filter(t=>['coastline','surface','places','surface-label'].includes(t.meta?.role))) {
      if(t.z.some(z=>z!==null&&z!==0))throw Error('Surface overlay not at zero depth');
     }
     const coast=g.data.find(t=>t.meta?.role==='coastline');
     if(coast.x.filter(x=>x!==null).length<100)throw Error('Missing coastline');
     const places=g.data.find(t=>t.meta?.role==='places');
     if(places.text.join('|')!==payload.map.places.map(p=>p.name).join('|'))throw Error('Map labels mismatch');
     const expectedZ=(axes.zaxis.range[0]-axes.zaxis.range[1])*payload.display.vertical_exaggeration;
     const expectedY=(axes.yaxis.range[1]-axes.yaxis.range[0])*payload.display.sphere_radius_km*Math.PI/180;
     if(Math.abs(axes.aspectratio.z/axes.aspectratio.y-expectedZ/expectedY)>1e-12)throw Error('Vertical exaggeration mismatch');
     return g.data.filter(t=>t.meta?.role==='earthquake').map(t=>({label:t.customdata[0][3],color:t.marker.color}));
    });
    function assertColor(a,b){if(a!==b)throw Error('Incorrect noise color');}
    for(const m of b.colors.matches) {
     const a=plots[0].find(t=>t.label===m.custom),r=plots[1].find(t=>t.label===m.reference);
     if(a.color!==r.color)throw Error('Overlap color mismatch');
    }
    const row=document.querySelector(`#comparison-table tr[data-n="${n}"]`);
    const memory=document.querySelector(`#storage-table tr[data-n="${n}"]`);
    return {summary:b.summary,cells:[...row.cells].map(c=>c.textContent),active:row.dataset.active,
     storage:[...memory.cells].map(c=>c.textContent),points:plots.map((_,i)=>document.getElementById(i?'reference-plot':'custom-plot').data.filter(t=>t.meta?.role==='earthquake').reduce((v,t)=>v+t.x.length,0)),
     growthMarks:document.querySelectorAll('#growth-chart circle').length};
   });
   assert.deepEqual(actual.summary,summary);
   assert.deepEqual(actual.points,[summary.n,summary.n]);
   assert.equal(actual.active,'true');
   assert.deepEqual(actual.cells,[summary.n.toLocaleString('en-US'),String(summary.custom_clusters),String(summary.reference_clusters),
    (100*summary.custom_noise_fraction).toFixed(1)+'%',(100*summary.reference_noise_fraction).toFixed(1)+'%',
    summary.ari.toFixed(4),summary.exact_partition_and_noise?'Exact partition':'Different partition']);
   assert.deepEqual(actual.storage,[summary.n.toLocaleString('en-US'),(8*summary.n**2/1e6).toFixed(2),(16*summary.n**2/1e6).toFixed(2)]);
   assert.equal(actual.growthMarks,4);
   console.log(`Batch ${summary.n}: counts, table, storage, coordinates, hover metadata and colors verified.`);
  }
  // Presets must update both live rendered cameras, including projection type.
  await page.locator('#top-view').click();
  await page.waitForFunction(()=>window.resultsView.preset==='top'&&sameCameras());
  assert.equal(await page.evaluate(()=>readCamera('custom-plot').projection.type),'orthographic');
  assert.ok(Math.abs(await page.evaluate(()=>readCamera('custom-plot').up.y)-1)<1e-7);
  await page.screenshot({path:'/tmp/hdbscan-results-top.png',fullPage:true});
  await page.locator('#depth-view').click();
  await page.waitForFunction(()=>window.resultsView.preset==='depth'&&sameCameras());
  assert.equal(await page.evaluate(()=>readCamera('reference-plot').projection.type),'perspective');
  await page.locator('#drag-mode').selectOption('pan');
  await page.waitForFunction(()=>window.resultsView.dragMode==='pan');
  const panBox=await page.locator('#custom-plot').boundingBox();
  const oldCenter=await page.evaluate(()=>JSON.stringify(readCamera('custom-plot').center));
  await page.mouse.move(panBox.x+panBox.width*.4,panBox.y+panBox.height*.6);await page.mouse.down();
  for(let i=1;i<=8;i++) {
   await page.mouse.move(panBox.x+panBox.width*(.4+.12*i/8),panBox.y+panBox.height*(.6+.06*i/8));
   await page.waitForTimeout(90);
  }
  await page.mouse.up();
  await page.waitForFunction(c=>JSON.stringify(readCamera('custom-plot').center)!==c,oldCenter);
  await page.waitForFunction(()=>sameCameras());
  await page.locator('#reset').click();
  await page.waitForFunction(()=>window.resultsView.preset==='depth'&&window.resultsView.dragMode==='orbit'&&sameCameras());
  console.log('Top/depth presets and real pan drag verified; surface overlays at 0 km, depth reversed, 2× aspect ratio checked.');
  // Exercise a real WebGL point hover, not just the data/hover-template fields.
  await page.locator('#custom-plot').scrollIntoViewIfNeeded();
  const hoverBox=await page.locator('#custom-plot').boundingBox();
  let hoverText='';
  for(let y=.2;y<=.8&&!hoverText;y+=.04) {
   for(let x=.4;x<=.65&&!hoverText;x+=.025) {
    await page.mouse.move(hoverBox.x+hoverBox.width*x,hoverBox.y+hoverBox.height*y);
    await page.waitForTimeout(65);
    hoverText=await page.locator('#custom-plot .hovertext').allTextContents().then(a=>a.join(' '));
   }
  }
  assert.match(hoverText,/2026_/);assert.match(hoverText,/Catalog depth:/);
  assert.match(hoverText,/Location:/);assert.match(hoverText,/Latitude:/);assert.match(hoverText,/Longitude:/);assert.match(hoverText,/Magnitude:/);assert.match(hoverText,/Assigned cluster:/);
  console.log('Actual 3D hover tooltip verified:',hoverText);
  await page.screenshot({path:'/tmp/hdbscan-results-hover.png',fullPage:true});
  // Rotate from each side programmatically, then perform a real pointer drag.
  for(const source of ['custom-plot','reference-plot']) {
   await page.evaluate(async id=>{await Plotly.relayout(document.getElementById(id),{'scene.camera':{
    eye:{x:id==='custom-plot'?2:-1.5,y:1.1,z:.8},up:{x:0,y:0,z:1},center:{x:0,y:0,z:0}}});},source);
   await page.waitForFunction(()=>sameCameras());
  }
  const box=await page.locator('#custom-plot').boundingBox();
  const before=await page.evaluate(()=>JSON.stringify(readCamera('custom-plot')));
  await page.mouse.move(box.x+box.width*.45,box.y+box.height*.45);
  await page.waitForTimeout(200);
  await page.mouse.down();
  for(let i=1;i<=12;i++) {
   await page.mouse.move(box.x+box.width*(.45+.2*i/12),box.y+box.height*(.45+.15*i/12));
   await page.waitForTimeout(100);
  }
  await page.mouse.up();
  await page.waitForFunction(old=>JSON.stringify(readCamera('custom-plot'))!==old,before);
  await page.waitForFunction(()=>sameCameras());
  const beforeZoom=await page.evaluate(()=>JSON.stringify(readCamera('custom-plot').eye));
  await page.mouse.move(box.x+box.width*.5,box.y+box.height*.55);
  await page.mouse.wheel(0,-180);
  await page.waitForFunction(old=>JSON.stringify(readCamera('custom-plot').eye)!==old,beforeZoom);
  await page.waitForFunction(()=>sameCameras());
  console.log('Camera synchronization verified in both directions, after rotate/pan drag, and wheel zoom.');
  // User-reported workflow: zoom, choose 3D depth again, then hover real events.
  await page.locator('#depth-view').click();
  await page.waitForFunction(()=>window.resultsView.preset==='depth'&&sameCameras());
  const afterZoomBox=await page.locator('#custom-plot').boundingBox();
  let afterZoomHover='';
  for(let y=.2;y<=.8&&!afterZoomHover;y+=.04)for(let x=.35;x<=.7&&!afterZoomHover;x+=.025) {
   await page.mouse.move(afterZoomBox.x+afterZoomBox.width*x,afterZoomBox.y+afterZoomBox.height*y);
   await page.waitForTimeout(65);
   afterZoomHover=(await page.locator('#custom-plot .hovertext').allTextContents()).join(' ');
  }
  assert.match(afterZoomHover,/2026_/);assert.match(afterZoomHover,/Catalog depth:/);
  console.log('Hover after wheel zoom and 3D depth preset verified:',afterZoomHover);

  await page.locator('#reset').click();
  await page.waitForFunction(()=>Math.abs(readCamera('custom-plot').eye.x-1.5)<1e-7&&Math.abs(readCamera('reference-plot').eye.x-1.5)<1e-7);
  // Camera state survives a batch change; plotting does not silently reset orientation.
  await page.evaluate(()=>Plotly.relayout(document.getElementById('custom-plot'),{'scene.camera':{
   eye:{x:2.2,y:1.1,z:.8},up:{x:0,y:0,z:1},center:{x:0,y:0,z:0}}}));
  await page.waitForFunction(()=>Math.abs(readCamera('reference-plot').eye.x-2.2)<1e-7);
  await page.locator('[data-batch="200"]').click();
  await page.waitForFunction(()=>window.resultsView.ready&&window.resultsView.batch===200);
  assert.ok(Math.abs(await page.evaluate(()=>readCamera('custom-plot').eye.x)-2.2)<1e-7);
  await page.locator('[data-batch="1000"]').click();
  await page.waitForFunction(()=>window.resultsView.ready&&window.resultsView.batch===1000);
  await page.locator('#reset').click();
  await page.waitForFunction(()=>Math.abs(readCamera('custom-plot').eye.x-1.5)<1e-7);
  // Exercise result modes and the original metric-coordinate view independently.
  for(const mode of ['custom','reference','comparison']) {
   const beforeMode=await page.evaluate(()=>readCamera('custom-plot'));
   await page.locator(`[data-display-mode="${mode}"]`).click();
   await page.waitForFunction(m=>window.resultsView.ready&&window.resultsView.mode===m,mode);
   assert.equal(await page.locator('#custom-panel').isVisible(),mode!=='reference');
   assert.equal(await page.locator('#reference-panel').isVisible(),mode!=='custom');
   const visibleId=mode==='reference'?'reference-plot':'custom-plot';
   const width=(await page.locator('#'+visibleId).boundingBox()).width;
   assert.ok(mode==='comparison'?width<650:width>900);
   const afterMode=await page.evaluate(id=>readCamera(id),visibleId);
   for(const key of ['eye','up','center'])for(const axis of ['x','y','z'])assert.ok(Math.abs(afterMode[key][axis]-beforeMode[key][axis])<1e-7);
   await page.locator('#clustering-view').click();
   await page.waitForFunction(()=>window.resultsView.ready&&window.resultsView.viewSpace==='metric'&&window.resultsView.preset==='clustering');
   await page.evaluate(()=>{
    const p=JSON.parse(document.getElementById('project-data').textContent),n=window.resultsView.batch;
    for(const kind of ['custom','reference']) {
     const g=document.getElementById(kind+'-plot');
     if(g.data.some(t=>t.meta?.role!=='earthquake'))throw Error('Map overlay leaked into metric view');
     if(g.layout.scene.aspectmode!=='data'||g.layout.scene.zaxis.title.text!=='Zc (km)')throw Error('Incorrect metric axes');
     for(const t of g.data)for(let j=0;j<t.x.length;j++) {
      const i=p.events.findIndex(e=>e[0]===t.customdata[j][0]);
      if(t.x[j]!==p.coordinates[i][0]||t.y[j]!==p.coordinates[i][1]||t.z[j]!==p.coordinates[i][2])throw Error('Metric input coordinates changed');
      if(t.customdata[j][3]!==p.batches[n][kind][i])throw Error('Cluster labels changed');
     }
    }
    if(!document.querySelector('.map-credit').hidden)throw Error('Geographic credit shown as metric overlay');
    if(!document.getElementById('coordinate-note').textContent.includes('Zc is not earthquake depth'))throw Error('Missing metric interpretation');
   });
   await page.locator('[data-batch="200"]').click();
   await page.waitForFunction(()=>window.resultsView.ready&&window.resultsView.batch===200);
   assert.equal(await page.evaluate(()=>window.resultsView.viewSpace),'metric');
   assert.equal(await page.evaluate(()=>window.resultsView.mode),mode);
   await page.locator('[data-batch="1000"]').click();
   await page.waitForFunction(()=>window.resultsView.ready&&window.resultsView.batch===1000);
   await page.screenshot({path:`/tmp/hdbscan-${mode}-clustering.png`,fullPage:true});
   await page.locator('#depth-view').click();
   await page.waitForFunction(()=>window.resultsView.ready&&window.resultsView.viewSpace==='geographic'&&window.resultsView.preset==='depth');
   assert.equal(await page.evaluate(()=>document.getElementById('custom-plot').data.some(t=>t.meta?.role==='coastline')),true);
   assert.equal(await page.evaluate(()=>document.querySelector('.map-credit').hidden),false);
   console.log(`Mode ${mode}: visibility, full-width/comparison sizing, camera preservation, original metric view, batch switching and geographic restoration verified.`);
  }
  await page.screenshot({path:'/tmp/hdbscan-results-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>document.getElementById('growth-chart').viewBox.baseVal.width<400);
  // Plotly debounces its responsive canvas resize; wait for it as well as SVG.
  await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth,null,{timeout:10000}).catch(async e=>{
   console.log('Overflow diagnostics:',await page.evaluate(()=>({width:innerWidth,total:document.documentElement.scrollWidth,
    nodes:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(e=>[e.tagName,e.id,String(e.className),e.getBoundingClientRect().right])})));
   await page.screenshot({path:'/tmp/hdbscan-results-mobile-error.png',fullPage:true});throw e;
  });
  await page.screenshot({path:'/tmp/hdbscan-results-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Offline file:// rendering: no HTTP requests or browser errors. Responsive page has no horizontal overflow.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
