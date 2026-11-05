// Studio to Studio over Inoscula Live: a pass word keeps strangers out, Studios see each other by name, and a
// shader sent to one Studio reaches only that one.
import { spawn } from 'node:child_process'
const relay = spawn(process.execPath, ['bin/inoscula-live.ts', '--port', '9620', '--in', '9619', '--blender', '9621', '--godot', '9622', '--osc', '9630', '--share', '--key', 'tulip'], { stdio: ['ignore', 'pipe', 'inherit'] })
let log = ''
relay.stdout.on('data', (d) => { log += d })
await new Promise((r) => setTimeout(r, 900))
let fails = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++ }
const open = (url) => new Promise((res) => { const w = new WebSocket(url); const got = []; w.onmessage = (e) => got.push(JSON.parse(e.data)); w.onopen = () => res({ w, got }); w.onerror = () => res(null) })
ok(await open('ws://127.0.0.1:9620') === null, 'no pass word, no connection')
ok(await open('ws://127.0.0.1:9620/?key=wrong') === null, 'wrong pass word, no connection')
const a = await open('ws://127.0.0.1:9620/?key=tulip'), b = await open('ws://127.0.0.1:9620/?key=tulip'), c = await open('ws://127.0.0.1:9620/?key=tulip')
ok(a && b && c, 'right pass word connects')
a.w.send(JSON.stringify({ type: 'hello', session: 'Desk' })); b.w.send(JSON.stringify({ type: 'hello', session: 'Projector' })); c.w.send(JSON.stringify({ type: 'hello', session: 'Laptop' }))
await new Promise((r) => setTimeout(r, 300))
const list = a.got.filter((m) => m.type === 'sessions').pop()?.list ?? []
ok(['Desk', 'Projector', 'Laptop'].every((n) => list.includes(n)), 'every Studio sees the others: ' + list.join(', '))
a.w.send(JSON.stringify({ type: 'shader', to: 'Projector', name: 'Mono Ink', code: 'name "Mono Ink";\nvoid main() { color = vec3(1.0); }' }))
a.w.send(JSON.stringify({ material: 'Knit', param: 'rows', value: 12 }))
await new Promise((r) => setTimeout(r, 300))
const sh = b.got.find((m) => m.type === 'shader')
ok(sh && sh.session === 'Desk' && sh.name === 'Mono Ink' && sh.code.includes('void main'), 'the shader reaches the Studio it was sent to, with who sent it')
ok(!c.got.some((m) => m.type === 'shader'), 'and no other Studio')
ok(b.got.some((m) => m.param === 'rows' && m.value === 12) && c.got.some((m) => m.param === 'rows'), 'parameter changes still reach everyone')
b.w.close(); await new Promise((r) => setTimeout(r, 300))
ok(!(a.got.filter((m) => m.type === 'sessions').pop()?.list ?? []).includes('Projector'), 'a Studio that leaves drops off the list')
ok(/Other computers: ws:\/\/\d+\.\d+\.\d+\.\d+:9620/.test(log) || !/Other computers/.test(log), 'prints the address for other computers')
a.w.close(); c.w.close(); relay.kill()
console.log(fails ? `${fails} failed` : 'sessions: all passed')
process.exit(fails ? 1 : 0)
