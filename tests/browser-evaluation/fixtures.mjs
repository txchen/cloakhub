import { createServer } from 'node:http';
import { surface } from './surface.mjs';

export async function startFixtures() {
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Accept-CH', 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Platform-Version');
    if (url.pathname === '/worker.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`(${surface.toString()})().then(x=>postMessage(x)).catch(e=>postMessage({error:String(e)}));`);
    } else if (url.pathname === '/echo') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(Object.fromEntries(Object.entries(req.headers).filter(([k]) => k === 'user-agent' || k.startsWith('sec-ch-ua')))));
    } else if (url.pathname === '/api/data') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, id: url.searchParams.get('id') }));
    } else {
      res.setHeader('Content-Type', 'text/html');
      if (url.pathname === '/popup') res.end('<!doctype html><body><script>setTimeout(()=>{const w=window.open("/popup-target");window.popupProbe={opened:!!w};if(w)w.close()},700)</script>popup');
      else if (url.pathname === '/animation') res.end('<!doctype html><canvas width=800 height=600></canvas><script>window.framesDrawn=0;const c=document.querySelector("canvas").getContext("2d");function f(t){c.fillStyle="rgb("+(Math.floor(t/10)%255)+",70,100)";c.fillRect(0,0,800,600);for(let i=0;i<50;i++){c.fillStyle="rgba(120,200,50,.3)";c.fillRect((t/5+i*17)%800,i*11,70,30)}window.framesDrawn++;requestAnimationFrame(f)}requestAnimationFrame(f)</script>');
      else res.end('<!doctype html><html><body>controlled browser evaluation fixture</body></html>');
    }
  };
  const servers = [];
  try {
    for (let i = 0; i < 2; i++) {
      const server = createServer(handler);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      servers.push(server);
    }
  } catch (error) { for (const server of servers) server.close(); throw error; }
  return {
    origin: `http://127.0.0.1:${servers[0].address().port}`,
    frameOrigin: `http://127.0.0.1:${servers[1].address().port}`,
    async close() { await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }))); },
  };
}
