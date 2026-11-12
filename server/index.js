/**
 * Sannolikt Retro Board server: static client + WebSocket rooms, no authentication.
 *
 *   GET  /                      -> lobby
 *   GET  /r/<room>              -> whiteboard
 *   WS   /ws?room=<room>        -> y-websocket wire protocol
 */
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, dirname } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { Rooms, validRoom } from './room.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = resolve(HERE, '..', 'public')
const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** Serve from PUBLIC_DIR only, blocking path traversal. */
const serveStatic = async (res, urlPath) => {
  let rel = decodeURIComponent(new URL(urlPath, 'http://x').pathname)
  if (rel === '/') rel = '/index.html'
  const target = resolve(PUBLIC_DIR, '.' + normalize(rel))
  if (!target.startsWith(PUBLIC_DIR)) return send(res, 400, 'bad path')
  try {
    const info = await stat(target)
    if (info.isDirectory()) return serveStatic(res, `${rel}/index.html`)
    const body = await readFile(target)
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.byteLength,
    })
    res.end(body)
  } catch {
    send(res, 404, `not found: ${rel}`)
  }
}

const rooms = new Rooms()

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  if (url.pathname.startsWith('/ws')) return // upgrade handler owns this path
  if (url.pathname === '/health') {
    return send(res, 200, JSON.stringify({ rooms: [...rooms.map.keys()] }), 'application/json')
  }
  if (/^\/r\/[^/]+\/?$/.test(url.pathname)) {
    const name = decodeURIComponent(url.pathname.slice(3).replace(/\/$/, ''))
    if (!validRoom(name)) return send(res, 400, 'Room name may use letters, digits, - or _ (1-64 chars).')
    return serveStatic(res, '/board.html')
  }
  if (url.pathname === '/favicon.ico') return send(res, 204, '')
  return serveStatic(res, url.pathname)
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  if (!url.pathname.startsWith('/ws')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    return socket.destroy()
  }
  // The provider puts the room in the path (`/ws/<room>`); a query param is honoured too.
  const fromPath = url.pathname.slice('/ws'.length).replace(/^\/+/, '').split('/')[0]
  const name = decodeURIComponent((url.searchParams.get('room') || fromPath || '').trim())
  const room = validRoom(name) ? await rooms.get(name) : null
  if (!room) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    return socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const conn = room.addConn(ws)
    ws.on('message', (data) => room.handleMessage(conn, data))
    ws.on('close', async () => {
      room.removeConn(conn)
      await rooms.release(room.name, room)
    })
    ws.on('error', () => ws.close())
    console.log(`[room ${room.name}] join (${room.conns.size} connected)`)
  })
})

let closing = false
function shutdown () {
  if (closing) return
  closing = true
  console.log('flushing rooms…')
  wss.close()
  rooms
    .flush()
    .catch((err) => console.error('flush failed:', err))
    .finally(() => {
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 1500).unref()
    })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

server.listen(PORT, HOST, () => {
  console.log(`Sannolikt Retro Board on http://localhost:${PORT} (data: ${resolve(HERE, '..', 'data')})`)
})

export { server, rooms }
