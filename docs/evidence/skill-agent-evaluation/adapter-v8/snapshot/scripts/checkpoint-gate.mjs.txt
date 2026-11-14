// Serialized into each document BEFORE application code. Not a security sandbox:
// supported adapters use JSON fetch, no workers, service workers or mutating GETs.
export function installCheckpointGate({ key }) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const NativeRequest = globalThis.Request;
  const generation = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  let approval = null, reservedPermit = null, admitted = 0;
  const blocked = [];
  const deny = reason => { blocked.push(reason); throw new Error(`Checkpoint WRITE_GATE: ${reason}`); };
  const canonical = value => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  };
  const get = (value, path) => path.reduce((v, k) => v != null && Object.hasOwn(v, k) ? v[k] : undefined, value);
  const project = (body, mapping) => Object.fromEntries(Object.entries(mapping).map(([k, path]) => [k, get(body, path)]));
  const readonly = method => ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
  globalThis.fetch = async (input, init) => {
    const request = new NativeRequest(input, init);
    if (readonly(request.method)) return nativeFetch(input, init);
    const permit = approval; approval = null; // Reserve synchronously, before parsing the body.
    if (!permit) return deny('Write outside commit or more than one request');
    reservedPermit = permit;
    const { write, destination, fields } = permit;
    if (request.url !== write.url || request.method !== write.method) return deny('Write endpoint or method differs');
    let body; try { body = await request.clone().json(); } catch { return deny('Only JSON fetch submissions are supported'); }
    const actual = { siteOrigin: new URL(request.url).origin, accountKey: get(body, write.accountKey), scope: project(body, write.scope) };
    if (canonical(actual) !== canonical(destination)) return deny('Account or scope differs');
    if (canonical(project(body, write.fields)) !== canonical(fields)) return deny('Outbound fields differ');
    if (permit.cancelled) return deny('Commit window ended before request validation');
    reservedPermit = null; admitted++;
    // A disconnect cannot replay this single native fetch; redirects never forward its body.
    return nativeFetch(new NativeRequest(request, { redirect: 'error' }));
  };
  const methods = new WeakMap();
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, ...args) { methods.set(this, String(method)); return open.call(this, method, ...args); };
  XMLHttpRequest.prototype.send = function(...args) { if (!readonly(methods.get(this) || 'GET')) return deny('XHR writes unsupported'); return send.apply(this, args); };
  const submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function() { if (!readonly(this.method)) return deny('Native form writes unsupported'); return submit.call(this); };
  addEventListener('submit', event => { if (!readonly(event.target.method)) { event.preventDefault(); deny('Native form writes unsupported'); } }, true);
  if (navigator.sendBeacon) navigator.sendBeacon = () => deny('Beacon writes unsupported');
  for (const name of ['WebSocket', 'WebTransport', 'Worker', 'SharedWorker']) if (globalThis[name]) globalThis[name] = class { constructor() { deny(`${name} unsupported`); } };
  if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error('Checkpoint WRITE_GATE: Service workers unsupported'));
  Object.defineProperty(globalThis, key, { value: message => {
    if (message.command === 'arm') {
      if (message.generation !== generation || approval) return deny('Document or approval changed');
      approval = structuredClone(message.approval);
    } else if (message.command === 'disarm') {
      if (reservedPermit) reservedPermit.cancelled = true;
      approval = null;
    }
    else if (message.command !== 'snapshot') return deny('Unknown gate command');
    return { generation, admitted, blocked: [...blocked] };
  } });
}
export function checkpointGateCommand({ key, ...message }) {
  if (typeof globalThis[key] !== 'function') throw Error('Checkpoint UNSUPPORTED: missing document gate');
  return globalThis[key](message);
}
