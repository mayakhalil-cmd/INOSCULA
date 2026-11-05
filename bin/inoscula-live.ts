#!/usr/bin/env node
// Inoscula Live: one parameter change, everywhere at once. Run this on your computer, then:
//   - Inoscula Studio connects to it (the connection button at the top right), and so does any browser page using Inoscula
//   - Blender: install importers/inoscula_live_blender.py as an add-on
//   - Godot: add importers/inoscula_live.gd to your scene
//   - Unreal: turn on the Remote Control API plugin; Inoscula Live sets Material Instance parameters through it
//   - RICO Engine (or anything that speaks OSC): receives /inoscula/<material>/<parameter> values
// A change made in any of them is sent to all the others.
//
//   node bin/inoscula-live.ts [--unreal http://localhost:30010] [--unreal-instance /Game/Inoscula/MI_Knit] [--osc 9000]
//
// Other computers: by default only this computer can connect. To let a second machine on the same network join
// (another Studio, a laptop running the projection), start it with a pass word everyone types in:
//   node bin/inoscula-live.ts --share --key tulip
// It prints the address to type into the other Studio (the connection button at the top right), for example ws://192.168.1.20:9420.
// Studios that are connected can send each other a whole shader, not only parameter changes.
//
// Message format, the same everywhere (JSON): {"material": "Knit", "param": "rows", "value": 36}
// value is a number, or [r, g, b] (linear) for colors and vectors.
// Between Studios only: {"type": "hello", "session": "Stage left"} names this Studio, the bridge answers everyone
// with {"type": "sessions", "list": [...]}; {"type": "shader", "session": ..., "to": ..., "name": ..., "code": ...}
// hands a shader to one Studio (or all of them when "to" is left out).
import http from 'node:http'
import dgram from 'node:dgram'
import crypto from 'node:crypto'
import os from 'node:os'

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d }
const WS_PORT = +arg('--port', '9420')
const IN_PORT = +arg('--in', '9419') // DCCs send their changes here (UDP)
const BLENDER_PORT = +arg('--blender', '9421')
const GODOT_PORT = +arg('--godot', '9422')
const OSC_PORT = +arg('--osc', '9000')
const UNREAL = arg('--unreal', '')
const UNREAL_INSTANCES = process.argv.flatMap((a, i) => (a === '--unreal-instance' ? [process.argv[i + 1]] : []))
const SHARE = process.argv.includes('--share')
const KEY = arg('--key', '')
if (SHARE && !KEY) console.log('Sharing without --key: anyone on this network can connect. Add --key <word> to ask for a pass word.')

type Msg = { material: string; param: string; value: number | number[]; from?: string }
const udp = dgram.createSocket('udp4')
const last = new Map<string, Msg>() // latest value of everything, for late joiners

// ---------------------------------------------------------------- minimal WebSocket server (RFC 6455)
const clients = new Set<import('node:net').Socket>()
function frame(text: string) {
  const data = Buffer.from(text)
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : data.length < 65536 ? Buffer.from([0x81, 126, data.length >> 8, data.length & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(data.length), 2); return b })()
  return Buffer.concat([head, data])
}
function readFrames(buf: Buffer, onText: (t: string) => void, onClose: () => void): Buffer {
  while (buf.length >= 2) {
    const op = buf[0] & 15, masked = buf[1] & 128
    let len = buf[1] & 127, off = 2
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4 }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10 }
    const mask = masked ? buf.subarray(off, off + 4) : null
    if (masked) off += 4
    if (buf.length < off + len) break
    const payload = Buffer.from(buf.subarray(off, off + len))
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
    buf = buf.subarray(off + len)
    if (op === 1) onText(payload.toString())
    else if (op === 8) { onClose(); return Buffer.alloc(0) }
  }
  return buf
}
const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Inoscula Live is running. Connect with a WebSocket.\n') })
const names = new Map<import('node:net').Socket, string>()
const sessions = () => JSON.stringify({ type: 'sessions', list: [...names.values()] })
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) return socket.destroy()
  if (KEY && new URL(req.url ?? '/', 'http://x').searchParams.get('key') !== KEY) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy() }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  clients.add(socket)
  for (const m of last.values()) socket.write(frame(JSON.stringify(m)))
  let buf = Buffer.alloc(0)
  const gone = () => { clients.delete(socket); if (names.delete(socket)) for (const c of clients) c.write(frame(sessions())) }
  const close = () => { gone(); socket.destroy() }
  socket.on('data', (d) => { buf = readFrames(Buffer.concat([buf, d]), (t) => studio(t, socket) || receive(t, 'browser', socket), close) })
  socket.on('close', gone)
  socket.on('error', gone)
})

// ---------------------------------------------------------------- OSC out (RICO and friends)
function oscString(s: string) { const b = Buffer.from(s + '\0'); return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]) }
function osc(address: string, values: number[]) {
  const tags = oscString(',' + 'f'.repeat(values.length))
  const args = Buffer.alloc(values.length * 4)
  values.forEach((v, i) => args.writeFloatBE(v, i * 4))
  return Buffer.concat([oscString(address), tags, args])
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

// ---------------------------------------------------------------- Unreal Remote Control
async function toUnreal(m: Msg) {
  if (!UNREAL) return
  const lib = '/Script/MaterialEditor.Default__MaterialEditingLibrary'
  for (const inst of UNREAL_INSTANCES) {
    const vec = Array.isArray(m.value)
    const body = vec
      ? { objectPath: lib, functionName: 'SetMaterialInstanceVectorParameterValue', parameters: { Instance: inst, ParameterName: m.param, Value: { R: (m.value as number[])[0], G: (m.value as number[])[1], B: (m.value as number[])[2], A: 1 } }, generateTransaction: false }
      : { objectPath: lib, functionName: 'SetMaterialInstanceScalarParameterValue', parameters: { Instance: inst, ParameterName: m.param, Value: m.value }, generateTransaction: false }
    try {
      await fetch(`${UNREAL}/remote/object/call`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      await fetch(`${UNREAL}/remote/object/call`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectPath: lib, functionName: 'UpdateMaterialInstance', parameters: { Instance: inst } }) })
    } catch (e) { console.log(`Unreal did not answer at ${UNREAL} (is the Remote Control API plugin on?)`) }
  }
}

// ---------------------------------------------------------------- Studio to Studio
// a Studio names itself, and can hand a whole shader to another one. Nothing here reaches Blender, Godot or Unreal.
function studio(text: string, socket: import('node:net').Socket): boolean {
  if (!text.startsWith('{"type"')) return false
  let m: { type?: string; session?: string; to?: string; name?: string; code?: string }
  try { m = JSON.parse(text) } catch { return true }
  if (m.type === 'hello' && typeof m.session === 'string') {
    names.set(socket, m.session.slice(0, 40))
    for (const c of clients) c.write(frame(sessions()))
    console.log(`studio   ${m.session} joined`)
  } else if (m.type === 'shader' && typeof m.code === 'string' && m.code.length < 1_000_000) {
    const from = names.get(socket) ?? 'A Studio'
    const out = frame(JSON.stringify({ type: 'shader', session: from, name: String(m.name ?? 'Shader').slice(0, 80), code: m.code }))
    for (const [c, n] of names) if (c !== socket && (!m.to || m.to === n)) c.write(out)
    console.log(`studio   ${from} sent "${m.name}"${m.to ? ' to ' + m.to : ''}`)
  }
  return true
}

// ---------------------------------------------------------------- routing
function receive(text: string, from: string, except?: unknown) {
  let m: Msg
  try { m = JSON.parse(text) } catch { return }
  if (typeof m.material !== 'string' || typeof m.param !== 'string' || !(typeof m.value === 'number' || (Array.isArray(m.value) && m.value.length === 3))) return
  m.from = m.from ?? from
  last.set(m.material + '/' + m.param, m)
  const json = JSON.stringify(m)
  for (const c of clients) if (c !== except) c.write(frame(json))
  if (m.from !== 'blender') udp.send(json, BLENDER_PORT, '127.0.0.1')
  if (m.from !== 'godot') udp.send(json, GODOT_PORT, '127.0.0.1')
  udp.send(osc(`/inoscula/${slug(m.material)}/${slug(m.param)}`, Array.isArray(m.value) ? m.value : [m.value]), OSC_PORT, '127.0.0.1')
  if (m.from !== 'unreal') toUnreal(m)
  console.log(`${m.from.padEnd(8)} ${m.material} / ${m.param} = ${JSON.stringify(m.value)}`)
}
const inbox = dgram.createSocket('udp4')
inbox.on('message', (b, r) => receive(b.toString(), 'udp:' + r.port))
inbox.bind(IN_PORT, '127.0.0.1')
server.listen(WS_PORT, SHARE ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`Inoscula Live on ws://localhost:${WS_PORT}  (changes in: udp ${IN_PORT}; Blender udp ${BLENDER_PORT}, Godot udp ${GODOT_PORT}, OSC ${OSC_PORT}${UNREAL ? `, Unreal ${UNREAL}` : ''})`)
  if (SHARE) for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`Other computers: ws://${a.address}:${WS_PORT}${KEY ? `  (pass word: ${KEY})` : ''}`)
})
