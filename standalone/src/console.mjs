/**
 * console.mjs —— 本地只读控制台（默认关）。
 *
 * 只读，没有任何写接口：不能改配置、不能批准、不能发送。
 * 默认只绑 127.0.0.1；token 从 console.token / DOUYIN_CONSOLE_TOKEN 读。
 * 打开方式：http://127.0.0.1:3210/?token=<CONSOLE_TOKEN>
 */
import http from 'node:http';
import { log, redact } from './util.mjs';

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

export function startConsole(cfg, deps) {
  if (!cfg.console.enabled) return null;
  const { audit, approvals, seen, cache } = deps;
  const token = cfg.console.token || '';
  const host = cfg.console.host || '127.0.0.1';
  const port = Number(cfg.console.port) || 3210;

  const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url, `http://${host}:${port}`); } catch { return send(res, 400, { error: 'bad url' }); }
    const given = u.searchParams.get('token') || req.headers['x-console-token'] || '';
    if (!token || given !== token) return send(res, 401, { error: 'unauthorized' });

    const limit = Math.min(200, Math.max(1, Number(u.searchParams.get('limit')) || 30));
    switch (u.pathname) {
      case '/':
      case '/health':
        return send(res, 200, {
          ok: true, ts: new Date().toISOString(), demo: !!cfg.demo,
          dryRun: !!cfg.reply.dryRun, replyEnabled: !!cfg.reply.enabled,
          counts: audit.countByKind(),
          pending: approvals.pending().length,
          seen: seen.count(), videoCache: cache.count(),
        });
      case '/audit':
        return send(res, 200, { rows: audit.tail(limit) });
      case '/pending':
        return send(res, 200, { rows: approvals.pending().map((r) => ({ ...r, texts: r.texts?.map(redact) })) });
      case '/state':
        return send(res, 200, { note: '只读快照', counts: audit.countByKind(), pending: approvals.list().length });
      default:
        return send(res, 404, { error: 'not found', hint: '/health /audit /pending /state' });
    }
  });

  server.on('error', (e) => log('error', '控制台启动失败', { error: e.message }));
  server.listen(port, host, () => {
    log('info', `只读控制台已启动 http://${host}:${port}/?token=<CONSOLE_TOKEN>（只读，不暴露写接口）`);
  });
  return server;
}

export function stopConsole(server) {
  if (server) { try { server.close(); } catch { /* ignore */ } }
}
