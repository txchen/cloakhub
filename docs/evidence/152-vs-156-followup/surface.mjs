// Runs in a page, a cross-origin frame, or a dedicated worker. No external dependencies.
export async function surface() {
  const inWindow = typeof document !== 'undefined';
  const makeCanvas = () => inWindow ? Object.assign(document.createElement('canvas'), {width:240,height:80}) : new OffscreenCanvas(240,80);
  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d', {willReadFrequently:true});
  ctx.fillStyle='#f5e1c8';ctx.fillRect(0,0,240,80);
  const gradient=ctx.createLinearGradient(0,0,240,80);gradient.addColorStop(0,'#1789ef');gradient.addColorStop(1,'#f43767');
  ctx.fillStyle=gradient;ctx.fillRect(5,7,223,61);
  ctx.font='16px Arial';ctx.fillStyle='rgba(10,20,30,.85)';ctx.fillText('Canvas probe Aa09 Ω',12,32);
  ctx.beginPath();ctx.arc(161,43,19,0,2*Math.PI);ctx.strokeStyle='rgba(50,100,220,.7)';ctx.lineWidth=2.5;ctx.stroke();
  const pixel1=Array.from(ctx.getImageData(0,0,240,80).data);
  const pixel2=Array.from(ctx.getImageData(0,0,240,80).data);
  const blob = inWindow ? await new Promise(resolve=>canvas.toBlob(resolve,'image/png')) : await canvas.convertToBlob({type:'image/png'});
  const png=Array.from(new Uint8Array(await blob.arrayBuffer()));
  const gl={};for(const type of ['webgl','webgl2']){const g=makeCanvas().getContext(type);const ext=g?.getExtension('WEBGL_debug_renderer_info');gl[type]=g?{vendor:ext?g.getParameter(ext.UNMASKED_VENDOR_WEBGL):null,renderer:ext?g.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,maxTexture:g.getParameter(g.MAX_TEXTURE_SIZE),error:g.getError()}:null;}
  let hints=null;try{hints=await navigator.userAgentData?.getHighEntropyValues(['architecture','bitness','platformVersion','fullVersionList','wow64']);}catch{}
  const out={identity:{ua:navigator.userAgent,platform:navigator.platform,languages:navigator.languages,cpu:navigator.hardwareConcurrency,memory:navigator.deviceMemory,maxTouchPoints:navigator.maxTouchPoints,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,hints},gl,canvas:{pixel1,pixel2,png,textWidth:ctx.measureText('Canvas probe Aa09 Ω').width}};
  if(inWindow){const s=screen;out.geometry={screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight,dpr:devicePixelRatio,screenWidth:s.width,screenHeight:s.height,availLeft:s.availLeft,availTop:s.availTop,availWidth:s.availWidth,availHeight:s.availHeight,colorDepth:s.colorDepth,pixelDepth:s.pixelDepth};}
  return out;
}
