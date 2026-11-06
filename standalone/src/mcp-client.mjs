/**
 * mcp-client.mjs —— 极小 MCP stdio 客户端（一行一个 JSON-RPC）
 *
 * 借鉴 [kdcadmin/dsh_douyin_tools](https://github.com/kdcadmin/dsh_douyin_tools) 的 lib/mcp.mjs 协议层：
 * initialize → notifications/initialized → tools/call。
 * 这里只做我们需要的三件事，不引入任何 MCP SDK。
 *
 * 关键约定（和上游 Python 侧一致）：
 *  - stdout 只出协议帧；非 JSON 行（库自己打的日志）直接忽略。
 *  - 工具返回值是 `ensure_ascii=False` 的 JSON 字符串，调用方必须带 PYTHONUTF8=1。
 *  - stderr 只留最后 4KB 用于报错定位。
 */
import { spawn } from 'node:child_process';
import { log } from './util.mjs';

let _client = null;

export class McpClient {
  constructor({ command, args = [], cwd, env = {}, timeoutMs = 180000 }) {
    this.cfg = { command, args, cwd, env, timeoutMs };
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.ready = false;
    this.starting = null;
    this.generation = 0;
  }

  get running() { return Boolean(this.proc) || Boolean(this.starting); }

  async start() {
    if (this.starting) return this.starting;
    if (this.ready && this.proc) return;
    const generation = ++this.generation;
    this.starting = (async () => {
      const { command, args, cwd, env } = this.cfg;
      this.proc = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const proc = this.proc;
      const fail = (error) => {
        if (generation !== this.generation) return;
        this.ready = false;
        for (const [, p] of this.pending) p.reject(error);
        this.pending.clear();
        this.proc = null;
      };
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => { if (generation === this.generation) this.#onData(chunk); });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (c) => { if (generation === this.generation) this.stderr = (this.stderr + c).slice(-4000); });
      proc.stdin.on('error', fail);
      proc.on('error', (e) => { log('error', `MCP 子进程启动失败：${e.message}`); fail(e); });
      proc.on('exit', (code) => {
        log('warn', `MCP 子进程退出（code=${code}）`);
        fail(new Error(`MCP 子进程退出（code=${code}）${this.stderr ? `：${this.stderr.slice(-300)}` : ''}`));
      });
      await this.#request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dsh-douyin-takeover', version: '0.1.0' },
      });
      if (generation !== this.generation) throw new Error('MCP 初始化期间已停止');
      this.#notify('notifications/initialized', {});
      this.ready = true;
      log('info', 'MCP 能力层已就绪');
    })();
    try {
      await this.starting;
    } catch (e) {
      if (generation === this.generation) this.stop();
      throw e;
    } finally {
      if (generation === this.generation) this.starting = null;
    }
  }

  stop() {
    this.generation++;
    this.ready = false;
    this.starting = null;
    for (const [, p] of this.pending) p.reject(new Error('MCP 已停止'));
    this.pending.clear();
    try { this.proc?.kill(); } catch { /* 已经没了 */ }
    this.proc = null;
    this.buf = '';
    this.stderr = '';
  }

  async listTools() {
    await this.start();
    const r = await this.#request('tools/list', {});
    return r?.tools ?? [];
  }

  /** 调一个工具：能解析成 JSON 就返回对象，否则返回字符串 */
  async call(name, args = {}, timeoutMs = this.cfg.timeoutMs) {
    await this.start();
    const result = await this.#request('tools/call', { name, arguments: args }, timeoutMs);
    const text = (result?.content ?? []).map((c) => c?.text ?? '').join('\n').trim();
    if (result?.isError) throw new Error(text || `MCP 工具 ${name} 报错`);
    try { return text ? JSON.parse(text) : {}; } catch { return text; }
  }

  #onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // 库往 stdout 打的日志行
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error?.message ? String(msg.error.message) : JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }

  #send(obj) {
    if (!this.proc?.stdin?.writable) throw new Error('MCP 子进程不在运行');
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  #notify(method, params) { this.#send({ jsonrpc: '2.0', method, params }); }

  #request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} 超时（${timeoutMs}ms）${this.stderr ? `：${this.stderr.slice(-200)}` : ''}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.#send({ jsonrpc: '2.0', id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
}

/**
 * 进程内单例。allowWrites 决定要不要给 Python 侧第二道闸（DOUYIN_ALLOW_WRITES=1）。
 * 只有 reply.enabled 且 dryRun=false 时才允许写真值 —— 与 policy.mjs 的判定互相兜底。
 */
export function getMcp(cfg) {
  if (_client) return _client;
  const m = cfg.mcp || {};
  const command = m.command || process.env.DOUYIN_MCP_PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3');
  _client = new McpClient({
    command,
    args: m.args?.length ? m.args : [],
    cwd: m.cwd,
    env: {
      PYTHONUTF8: '1',
      DOUYIN_ALLOW_WRITES: (cfg.reply.enabled && !cfg.reply.dryRun && cfg.mcp?.allowWrites !== false) ? '1' : '0',
      DOUYIN_HEADLESS: m.headless === false ? '0' : '1',
      ...(m.env || {}),
    },
    timeoutMs: Number(m.timeoutMs) || 240000,
  });
  _client.scriptPath = m.script || null;
  if (!_client.scriptPath) {
    _client.scriptPath = (m.args && m.args[0]) || null;
  }
  return _client;
}

export function stopMcp() {
  if (_client) { _client.stop(); _client = null; }
}

/** 测试/登录流程可以显式替换单例（例如用假 MCP server 验链路） */
export function setMcp(client) { _client = client; }
