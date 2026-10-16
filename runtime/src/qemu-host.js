// Page API for the i386 PC browser engine. GPL-2.0-or-later.
import {buildArguments} from './qemu-config.js';
export const Commands = Object.freeze({PAUSE:1, RESUME:2, RESET:3, POWER_OFF:4, KEY:5});
const STATS = {presented: 0, consumed: 1, maxInflight: 2, vblanks: 3, width: 4, height: 5, paused: 6, running: 7, guestFlips: 8};

export class QemuHost extends EventTarget {
  constructor({canvas = null, workerUrl = new URL('./qemu-core-worker.js', import.meta.url),
               coreUrl = new URL('../cores/qemu/qemu-core.js', import.meta.url)} = {}) {
    super();
    this.canvas = canvas;
    this.workerUrl = String(workerUrl);
    this.coreUrl = String(coreUrl);
    this.worker = null;
    this.memory = null;
    this.ptr = null;
    this.layout = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ports = [];
    this.frameSize = {width: 0, height: 0};
    this._ctx = null;
    this._ready = null;
  }

  /**
   * Starts the core. Resolves once the machine and shared memory are ready.
   * x87: 'fast' (default) or diagnostic 'reference' (QEMU helpers, no x87
   * inlining). x87Cache enables experimental write-through JIT locals;
   * x87Profile enables per-operation attempt/accept counters.
   * memoryOrder defaults to strict guest ordering on every host; 'auto'
   * drops the fences on hosts that report x86 (see hostIsX86).
   */
  boot({files = {}, settings = {}, args = [], wasmBinary, echoLog = false, jit = true,
        memoryOrder = 'strict', x87 = 'fast', x87Cache = false, x87Profile = false} = {}) {
    if (!['fast', 'reference'].includes(x87)) throw new Error('Invalid x87 mode');
    if (this.worker) throw new Error('Already booted');
    buildArguments(settings, {...files, disc: files.disc ? '/media/disc.iso' : ''});
    if (!['strict', 'relaxed', 'auto'].includes(memoryOrder)) throw new Error('Invalid memory order');
    this._started = false;
    this._readyMessage = null;
    this.worker = new Worker(this.workerUrl, {type: 'module', name: 'qemu-core'});
    this.worker.onmessage = e => this._onWorkerMessage(e.data);
    this.worker.onerror = e => {
      const error = new Error(e.message || 'Core worker failed to load');
      this._readyReject?.(error);
      this._emit('error', {message: error.message});
    };
    const transfer = [];
    for (const value of Object.values(files)) {
      if (value instanceof ArrayBuffer) transfer.push(value);
    }
    this._ready = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    this.worker.postMessage({type: 'boot', coreUrl: this.coreUrl, files, settings, args, wasmBinary, echoLog, jit, memoryOrder, x87, x87Cache, x87Profile}, transfer);
    return this._ready;
  }

  terminate() {
    const error = new Error('Core terminated');
    this._readyReject?.(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.ports) p.close();
    this.ports = [];
    this.memory = this.ptr = this.layout = this.stats = this.u32 = this.i32 = null;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, {detail}));
  }

  _onWorkerMessage(data) {
    if (!data) return;
    const msg = data.qemu || data;
    if (msg.type === 'error' && msg.id) {
      const pending = this.pending.get(msg.id);
      if (pending) { this.pending.delete(msg.id); pending.reject(new Error(msg.message)); }
    }
    if (msg.type === 'host-port') {
      this.ports.push(msg.port);
      msg.port.onmessage = e => this._onCoreMessage(e.data);
      return;
    }
    if (msg.type === 'ready') {
      this.memory = msg.memory;
      this.ptr = msg.ptr;
      this.layout = msg.layout;
      this.u32 = new Uint32Array(this.memory.buffer);
      this.i32 = new Int32Array(this.memory.buffer);
      this.stats = new Uint32Array(this.memory.buffer, this.ptr.stats, 9);
      this._readyMessage = msg;
      if (this._started) this._readyResolve?.(msg);
    }
    this._onCoreMessage(msg);
  }

  _onCoreMessage(msg) {
    if (msg.type === 'started') {
      this._started = true;
      if (this._readyMessage) this._readyResolve?.(this._readyMessage);
    } else if (!this._started && ['error', 'abort', 'exited'].includes(msg.type)) {
      this._readyReject?.(new Error(msg.message || 'Core exited during startup'));
    }
    switch (msg.type) {
      case 'frame':
        this._drawBitmap(msg.bitmap, msg.width, msg.height);
        return;
      case 'pixels':
        this._drawPixels(msg.buffer, msg.width, msg.height);
        return;
      case 'command-result': {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.ok ? p.resolve(msg) : p.reject(Object.assign(new Error(msg.error || 'Command failed'), {result: msg}));
        }
        break;
      }
      case 'mounted': {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p.resolve(msg.path); }
        break;
      }
      default:
        break;
    }
    this._emit(msg.type, msg);
  }

  _acknowledgeFrame(width, height) {
    if (this.stats) Atomics.add(this.stats, STATS.consumed, 1);
    if (width !== this.frameSize.width || height !== this.frameSize.height) {
      this.frameSize = {width, height};
      this._emit('resize', {width, height});
    }
    this._emit('present', {width, height});
  }

  _drawBitmap(bitmap, width, height) {
    if (this.canvas) {
      if (!this._ctx) this._ctx = this.canvas.getContext('bitmaprenderer');
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      this._ctx.transferFromImageBitmap(bitmap);
    } else {
      bitmap.close();
    }
    this._acknowledgeFrame(width, height);
  }

  async _drawPixels(buffer, width, height) {
    if (this.canvas) {
      if (!this._ctx) this._ctx = this.canvas.getContext('2d');
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      this._ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0);
    }
    this._acknowledgeFrame(width, height);
  }

  /** Captures the latest frame as a PNG Blob (for save-state thumbnails). */
  async snapshotCanvas(maxWidth = 320) {
    if (!this.canvas || !this.canvas.width) return null;
    const scale = Math.min(1, maxWidth / this.canvas.width);
    const out = new OffscreenCanvas(Math.round(this.canvas.width * scale), Math.round(this.canvas.height * scale));
    out.getContext('2d').drawImage(this.canvas, 0, 0, out.width, out.height);
    return out.convertToBlob({type: 'image/png'});
  }

  command(cmd, arg = '') {
    if (!this.worker) return Promise.reject(new Error('Core is not booted'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.worker.postMessage({type: 'command', id, cmd, arg: String(arg)});
    });
  }

  pause() { return this.command(Commands.PAUSE); }
  resume() { return this.command(Commands.RESUME); }
  reset() { return this.command(Commands.RESET); }
  powerOff() { return this.command(Commands.POWER_OFF); }
  key(qcode, down) {
    if (typeof qcode !== 'string' || !/^[a-z0-9_-]+$/.test(qcode)) return Promise.reject(new Error('Invalid key code'));
    return this.command(Commands.KEY, `${down ? '+' : '-'}${qcode}`); }

  getX87Stats() {
    if (!this.memory || !this.ptr?.x87) return null;
    const counters = new Uint32Array(this.memory.buffer, this.ptr.x87, 16);
    return Object.fromEntries(['load', 'store', 'add', 'sub', 'mul', 'div', 'sqrt']
      .map((name, i) => [name, {attempts: Atomics.load(counters, i * 2),
        accepted: Atomics.load(counters, i * 2 + 1)}]));
  }

  getX87JitStats() {
    if (!this.memory || !this.ptr?.x87Jit) return null;
    const counters = new Uint32Array(this.memory.buffer, this.ptr.x87Jit, 4);
    return Object.fromEntries(['compiled', 'rejected', 'codeBytes', 'compileMicros']
      .map((name, i) => [name, Atomics.load(counters, i)]));
  }

  getStats() {
    if (!this.stats) return null;
    return {
      framesPresented: Atomics.load(this.stats, STATS.presented),
      framesConsumed: Atomics.load(this.stats, STATS.consumed),
      vblanks: Atomics.load(this.stats, STATS.vblanks),
      width: Atomics.load(this.stats, STATS.width),
      height: Atomics.load(this.stats, STATS.height),
      running: Atomics.load(this.stats, STATS.running) === 1,
      guestFlips: Atomics.load(this.stats, STATS.guestFlips),
    };
  }

  /** Frames the core may have in flight before it skips presenting (default 2). */
  setMaxFramesInFlight(n) {
    if (this.stats) Atomics.store(this.stats, STATS.maxInflight, Math.max(1, n | 0));
  }

}
