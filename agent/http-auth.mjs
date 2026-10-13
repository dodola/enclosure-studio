import { timingSafeEqual } from 'node:crypto';

export function protectInternal(handler, token) {
  if (!token) return handler;
  const expected = Buffer.from(token);
  return (req, res) => {
    const value = req.headers['x-enclosure-internal'];
    const supplied = Buffer.from(typeof value === 'string' ? value : '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ detail: '仅接受内部服务请求。' })); return;
    }
    return handler(req, res);
  };
}
