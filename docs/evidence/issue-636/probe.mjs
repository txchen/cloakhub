import { launch } from 'cloakbrowser';
import { readFile } from 'node:fs/promises';
process.env.CLOAKBROWSER_LICENSE_KEY=(await readFile('/run/license.key','utf8')).trim();
const browser=await launch({headless:process.env.TEST_HEADED!=='1',args:['--enable-logging=stderr','--v=1']});
try {
 const page=await browser.newPage();
 await page.goto('data:text/html,<title>WebGL probe</title>');
 const result=await page.evaluate(()=>Object.fromEntries(['webgl','webgl2'].map(type=>{
  const c=document.createElement('canvas');c.width=8;c.height=8;const gl=c.getContext(type);if(!gl)return [type,null];
  gl.clearColor(.25,.5,.75,1);gl.clear(gl.COLOR_BUFFER_BIT);const p=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return [type,{pixel:[...p],error:gl.getError()}];
 })));
 console.log(JSON.stringify({version:browser.version(),headed:process.env.TEST_HEADED==='1',result}));
} finally {await browser.close();}
