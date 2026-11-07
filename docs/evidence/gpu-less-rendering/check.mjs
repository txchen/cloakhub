import {chromium,expect} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const label=process.argv[2],root='.cloakhub/gpu-less-evaluation';
const c=JSON.parse(await readFile(`${root}/${label}/config.json`,'utf8'));const results={label,headed:[],headless:[],vnc:{}};let b,ui,id;
async function api(path='',method='GET',body){const r=await fetch(c.hub+'/api/profiles'+path,{method,headers:{authorization:'Bearer '+c.token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error(`API ${r.status} ${path}`);return r.status===204?null:r.json();}
async function graphics(page){return page.evaluate(()=>{
 const contexts={};for(const kind of ['webgl','webgl2']){
 const canvas=document.createElement('canvas');canvas.width=canvas.height=16;const gl=canvas.getContext(kind);if(!gl){contexts[kind]={available:false};continue;}
 // Draw a real triangle with shaders, not only getParameter or a clear operation.
 const v=gl.createShader(gl.VERTEX_SHADER);gl.shaderSource(v,'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}');gl.compileShader(v);
 const f=gl.createShader(gl.FRAGMENT_SHADER);gl.shaderSource(f,'precision mediump float;void main(){gl_FragColor=vec4(0.,1.,0.,1.);}');gl.compileShader(f);
 const prog=gl.createProgram();gl.attachShader(prog,v);gl.attachShader(prog,f);gl.linkProgram(prog);gl.useProgram(prog);
 const buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);const p=gl.getAttribLocation(prog,'p');gl.enableVertexAttribArray(p);gl.vertexAttribPointer(p,2,gl.FLOAT,false,0,0);gl.viewport(0,0,16,16);gl.drawArrays(gl.TRIANGLES,0,3);
 const pixel=new Uint8Array(4);gl.readPixels(8,8,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);contexts[kind]={available:true,linked:gl.getProgramParameter(prog,gl.LINK_STATUS),pixel:[...pixel],error:gl.getError()};
 }return {contexts,platform:navigator.platform,dpr:devicePixelRatio};
 });}
function assertGraphics(g){for(const v of Object.values(g.contexts)){assert.equal(v.available,true);assert.equal(v.linked,true);assert.deepEqual(v.pixel,[0,255,0,255]);assert.equal(v.error,0);}}
try{
 for(const headless of [false,true]){
 id=`gpu_${label}_${headless?'hl':'hd'}`;const profile=await api('','POST',{profile_id:id,headless,fingerprint_seed:'20260909',idle_timeout_minutes:10});
 for(let cycle=0;cycle<2;cycle++){
 b=await chromium.connectOverCDP(profile.connection.cdp_url);results.version=b.version();if(cycle===0){const session=await b.newBrowserCDPSession();const info=await session.send('SystemInfo.getInfo');results[headless?'headlessBackend':'headedBackend']={devices:info.gpu.devices,auxAttributes:info.gpu.auxAttributes,featureStatus:info.gpu.featureStatus};await session.detach();}const page=await b.contexts()[0].newPage();await page.goto('http://127.0.0.1:9634/');await page.bringToFront();
 const g=await graphics(page);results[headless?'headless':'headed'].push(g);assertGraphics(g);
 if(cycle===0){await page.evaluate(()=>localStorage.setItem('gpu-test','saved'));}else{assert.equal(await page.evaluate(()=>localStorage.getItem('gpu-test')),'saved');}
 if(!headless && cycle===0){
 ui=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});const viewer=await ui.newPage({viewport:{width:1600,height:1200}});await viewer.goto(c.hub);await viewer.locator('[name=token]').fill(c.token);await viewer.getByRole('button',{name:'Open workspace →'}).click();await viewer.locator('#profile-rows tr').filter({hasText:id}).locator('[data-action=open]').click();await expect(viewer.locator('#viewer-state')).toHaveText('Connected',{timeout:30000});const canvas=viewer.frameLocator('#viewer-frame').locator('canvas');await expect(canvas).toBeVisible();await page.bringToFront();await viewer.waitForTimeout(1500);
 const geo=await page.evaluate(()=>({x:screenX,y:screenY,toolbar:outerHeight-innerHeight,width:screen.width,height:screen.height}));
 async function screenPoint(selector){const rect=await page.locator(selector).boundingBox();assert.ok(rect);return{x:geo.x+rect.x+rect.width/2,y:geo.y+geo.toolbar+rect.y+rect.height/2};}
 for(const [selector,expected] of [['#green',[0,200,0]],['#gpu',[255,0,0]]]){
 const point=await screenPoint(selector);await expect.poll(()=>canvas.evaluate((el,p)=>{const ctx=el.getContext('2d');return [...ctx.getImageData(Math.round(p.x*el.width/p.width),Math.round(p.y*el.height/p.height),1,1).data].slice(0,3);},{...point,width:geo.width,height:geo.height}),{timeout:10000}).toEqual(expected);
 }
 results.vnc.pixels=true;
 await page.locator('#input').fill('VNC verified');const point=await screenPoint('#submit');const box=await canvas.boundingBox();assert.ok(box);await viewer.mouse.click(box.x+point.x*box.width/geo.width,box.y+point.y*box.height/geo.height);await expect(page.locator('#result')).toHaveText('VNC verified');results.vnc.mouse=true;
 await page.locator('#input').fill('');await page.locator('#input').focus();await viewer.evaluate(id=>document.querySelector('#viewer-frame').contentWindow.postMessage({type:'cloakhub-viewer-paste',profile_id:id,text:'无GPU输入 verified'},location.origin),id);await expect(page.locator('#input')).toHaveValue('无GPU输入 verified');results.vnc.clipboard=true;
 await viewer.screenshot({path:`${root}/${label}/viewer.png`});await ui.close();ui=null;
 }
 await b.close();b=null;await api('/'+id+'/stop','POST');
 }
 await api('/'+id,'DELETE');id=null;
 }
 results.persisted=true;results.pass=true;
}catch(e){results.error=String(e).replaceAll(c.token,'[redacted]');process.exitCode=1;}
finally{await ui?.close();await b?.close();if(id){await api('/'+id+'/stop','POST').catch(()=>{});await api('/'+id,'DELETE').catch(()=>{});}await writeFile(`${root}/${label}/results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));}
