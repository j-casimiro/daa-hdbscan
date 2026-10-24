/* Offline regression: surface overlays must not block earthquake picking. */
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
(async()=>{
 const browser=await chromium.launch({headless:true,
  ...(process.env.RESULTS_CHROME_PATH?{executablePath:process.env.RESULTS_CHROME_PATH}:{}),
  args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1100},offline:true});
  await page.goto(pathToFileURL(path.resolve(__dirname,'../results.html')).href);
  await page.waitForFunction(()=>window.resultsView?.ready&&window.resultsView.mode==='custom');
  const record=await page.evaluate(async()=>{
   const p=JSON.parse(document.getElementById('project-data').textContent);
   const i=p.geographic_coordinates.reduce((best,q,j)=>q[2]>p.geographic_coordinates[best][2]?j:best,0);
   const [lon,lat,depth]=p.geographic_coordinates[i];
   const g=document.getElementById('custom-plot');
   const earthquake=g.data.find(t=>t.meta?.role==='earthquake'&&t.customdata.some(r=>r[0]===p.events[i][0]));
   const row=earthquake.customdata.find(r=>r[0]===p.events[i][0]);
   const overlays=g.data.filter(t=>t.meta?.role!=='earthquake');
   if(overlays.some(t=>t.type==='mesh3d'||t.type==='surface'))throw Error('Filled surface blocks event picking');
   const [west,east]=p.bounds.longitude,[south,north]=p.bounds.latitude;
   const oldMesh={type:'mesh3d',x:[west,east,east,west],y:[south,south,north,north],z:[0,0,0,0],
    i:[0,0],j:[1,2],k:[2,3],opacity:.07,hoverinfo:'skip'};
   const point={...earthquake,x:[lon],y:[lat],z:[depth],customdata:[row],marker:{...earthquake.marker,size:9}};
   // Controlled camera/ranges put a REAL deep event directly beneath the cursor.
   window.hoverCase={overlays,oldMesh,point};
   await Plotly.newPlot(g,[...overlays,point],{margin:{l:0,r:0,t:0,b:0},scene:{
    xaxis:{range:[lon-.5,lon+.5]},yaxis:{range:[lat-.5,lat+.5]},zaxis:{range:[depth+20,-5]},
    aspectmode:'cube',camera:{eye:{x:0,y:0,z:2.5},up:{x:0,y:1,z:0},center:{x:0,y:0,z:0},projection:{type:'orthographic'}}
   }},{displayModeBar:false,scrollZoom:true});
   return {id:p.events[i][0],depth};
  });
  const box=await page.locator('#custom-plot').boundingBox();
  async function pick(){
   await page.mouse.move(box.x+10,box.y+10);
   for(const [dx,dy] of [[0,0],[-3,0],[3,0],[0,-3],[0,3]]) {
    await page.mouse.move(box.x+box.width/2+dx,box.y+box.height/2+dy);
    await page.waitForTimeout(100);
    const text=(await page.locator('#custom-plot .hovertext').allTextContents()).join(' ');
    if(text.includes(record.id))return text;
   }
   return '';
  }
  let text=await pick();
  assert.ok(text.includes(record.id),'Production surface/coastline overlays must not block deep-event hover');
  // Native wheel zoom in AND out must retain picking with the same overlays.
  for(const delta of [-180,260]) {
   await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
   await page.mouse.wheel(0,delta);await page.waitForTimeout(1200);
   text=await pick();assert.ok(text.includes(record.id),'Tooltip lost after wheel zoom '+delta);
  }
  // Negative control reproduces the old bug with the same REAL earthquake.
  await page.evaluate(()=>Plotly.addTraces('custom-plot',window.hoverCase.oldMesh,0));
  const withOldMesh=await pick();
  assert.equal(withOldMesh,'','Negative control should expose filled-mesh interception');
  await page.evaluate(()=>Plotly.deleteTraces('custom-plot',[0]));
  const restored=await pick();
  assert.ok(restored.includes(record.id),'Tooltip must recover when blocking mesh is removed');
  console.log(JSON.stringify({record,productionHover:text,withOldMesh,restored}));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
