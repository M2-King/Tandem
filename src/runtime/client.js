// Connection to the local runtime: authenticated HTTP requests plus one
// WebSocket for live events. The socket reconnects on its own; listeners can
// follow its state ('connecting' | 'connected' | 'disconnected').

export class RuntimeClient {
  constructor({ token }) {
    this.token = token;
    this.listeners = new Set();
    this.stateListeners = new Set();
    this.state = 'connecting';
    this.socket = null;
    this.retry = 0;
    this.connect();
  }

  async api(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetch(path, {
        method,
        headers: { 'x-tandem-token': this.token, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch {
      throw new Error('The Tandem runtime is not reachable. Is `tandem open` still running?');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `The runtime refused the request (${response.status}).`);
    return data;
  }

  connect() {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws?token=${encodeURIComponent(this.token)}`);
    this.socket = socket;
    this.setState(this.retry ? 'disconnected' : 'connecting');
    socket.onopen = () => {
      this.retry = 0;
      this.setState('connected');
    };
    socket.onmessage = (e) => {
      let event;
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      this.listeners.forEach((fn) => fn(event));
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.setState('disconnected');
      this.retry += 1;
      setTimeout(() => this.connect(), Math.min(5000, 600 * this.retry));
    };
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.stateListeners.forEach((fn) => fn(state));
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onState(fn) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
}
