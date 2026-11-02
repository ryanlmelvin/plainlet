import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const docsRoot = fileURLToPath(new URL('../docs/', import.meta.url));
const basePath = '/plainlet/';
const portFlag = process.argv.indexOf('--port');
const port = Number(portFlag < 0 ? (process.env.PORT || 4173) : process.argv[portFlag + 1]);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/' || pathname === basePath.slice(0, -1)) {
      response.writeHead(302, { Location: basePath }).end();
      return;
    }
    if (!pathname.startsWith(basePath)) {
      response.writeHead(404).end('Not found');
      return;
    }
    const relativePath = pathname.slice(basePath.length) || 'index.html';
    const filePath = path.resolve(docsRoot, relativePath);
    if (!filePath.startsWith(docsRoot) || filePath.includes('\0')) {
      response.writeHead(404).end('Not found');
      return;
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': types[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Local: http://127.0.0.1:${port}${basePath}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
