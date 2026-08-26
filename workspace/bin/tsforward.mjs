#!/usr/bin/env node
// tsforward -- make a tailnet service look like localhost.
//
// Listens on 127.0.0.1:<localPort> and forwards every connection through
// tailscaled's SOCKS5 server to <host>:<port> on the tailnet.
//
// Why this instead of an HTTP proxy: Node only honours HTTP_PROXY when started
// with --use-env-proxy or NODE_USE_ENV_PROXY, both of which are recent. A real
// deployment turned out to run an older Node that has neither ("node: bad
// option: --use-env-proxy"), which took every command down. Forwarding at the
// TCP layer needs nothing from Node at all -- no flags, no version floor, and
// it works identically for fetch, WebSocket, and curl.
//
// Usage: tsforward.mjs <localPort> <tailnetHost> <tailnetPort> [socksPort]

import { createServer, connect } from 'node:net';

const [localPort, host, port, socksPort = '1056'] = process.argv.slice(2);
if (!localPort || !host || !port) {
  console.error('usage: tsforward.mjs <localPort> <tailnetHost> <tailnetPort> [socksPort]');
  process.exit(2);
}

// Minimal SOCKS5 CONNECT. No auth, domain-name addressing so the name is
// resolved on the tailnet side -- which is what makes MagicDNS work.
function socksConnect(targetHost, targetPort, cb) {
  const sock = connect(Number(socksPort), '127.0.0.1');
  let stage = 'greeting';

  sock.on('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));

  sock.on('data', function onData(chunk) {
    if (stage === 'greeting') {
      if (chunk[0] !== 0x05 || chunk[1] !== 0x00) {
        sock.destroy();
        return cb(new Error('SOCKS5 handshake refused'));
      }
      stage = 'connecting';
      const name = Buffer.from(targetHost, 'utf8');
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
        name,
        Buffer.from([(Number(targetPort) >> 8) & 0xff, Number(targetPort) & 0xff]),
      ]);
      sock.write(req);
      return;
    }

    if (stage === 'connecting') {
      if (chunk[0] !== 0x05 || chunk[1] !== 0x00) {
        // 0x03 network unreachable, 0x04 host unreachable, 0x05 refused...
        sock.destroy();
        return cb(new Error(`SOCKS5 CONNECT failed (code ${chunk[1]})`));
      }
      stage = 'open';
      sock.removeListener('data', onData);
      // Anything the peer sent alongside the reply belongs to the stream.
      const replyLen = 4 + (chunk[3] === 0x01 ? 4 : chunk[3] === 0x04 ? 16 : 1 + chunk[4]) + 2;
      const extra = chunk.length > replyLen ? chunk.subarray(replyLen) : null;
      return cb(null, sock, extra);
    }
  });

  sock.on('error', (err) => { if (stage !== 'open') cb(err); });
}

const server = createServer((client) => {
  client.pause();
  socksConnect(host, port, (err, upstream, extra) => {
    if (err) {
      console.error(`[tsforward] ${host}:${port} -> ${err.message}`);
      client.destroy();
      return;
    }
    if (extra?.length) client.write(extra);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
    const bin = () => { client.destroy(); upstream.destroy(); };
    client.on('error', bin);
    upstream.on('error', bin);
  });
});

server.listen(Number(localPort), '127.0.0.1', () => {
  console.log(`[tsforward] 127.0.0.1:${localPort} -> ${host}:${port} via SOCKS5 :${socksPort}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
