// Inoscula Live end to end: relay + a browser-style WebSocket client + Blender (real bpy) + an OSC listener.
import { spawn } from 'node:child_process'
import dgram from 'node:dgram'
const [blenderScript] = process.argv.slice(2)
const relay = spawn('node', ['bin/inoscula-live.ts', '--port', '9520', '--in', '9519', '--blender', '9521', '--godot', '9522', '--osc', '9530'], { stdio: ['ignore', 'pipe', 'inherit'] })
relay.stdout.on('data', (d) => process.stdout.write('[relay] ' + d))
const oscIn = dgram.createSocket('udp4'); const osc = []
oscIn.on('message', (b) => osc.push(b.toString('latin1').split('\0')[0])); oscIn.bind(9530)
await new Promise((r) => setTimeout(r, 800))
const py = `
import sys, time, json, runpy, bpy
exec(compile(open(${JSON.stringify(blenderScript)}).read(), 'k', 'exec'), {'__name__': 'x'})
mod = runpy.run_path('importers/inoscula_live_blender.py', run_name='inoscula_live')
mod['LISTEN'] = 9521
import importlib
g = mod
g['SEND'] = 9519
# patch ports: the module reads globals at call time
g['register'].__globals__['LISTEN'] = 9521; g['register'].__globals__['SEND'] = 9519
g['register']()
node = next(n for n in bpy.data.materials['Claymation'].node_tree.nodes if n.bl_idname == 'ShaderNodeGroup')
t0 = time.time(); changed = False
while time.time() - t0 < 4.0:
    g['poll']()
    if time.time() - t0 > 2.0 and not changed:
        node.inputs['Marbling'].default_value = 0.9; changed = True
    time.sleep(0.05)
print('BLENDER prints =', round(node.inputs['Fingerprints'].default_value, 3), 'clay =', tuple(round(x, 3) for x in node.inputs['Clay'].default_value[:3]))
`
const blender = spawn('python3', ['-c', py], { stdio: ['ignore', 'pipe', 'pipe'] })
let blenderOut = ''
blender.stdout.on('data', (d) => { const s = d.toString(); blenderOut += s; if (s.includes('BLENDER')) process.stdout.write(s) })
blender.stderr.on('data', (d) => process.stderr.write(d))
await new Promise((r) => setTimeout(r, 1500))
const ws = new WebSocket('ws://127.0.0.1:9520'); const got = []
ws.onmessage = (e) => got.push(JSON.parse(e.data))
await new Promise((r) => (ws.onopen = r))
ws.send(JSON.stringify({ material: 'Claymation', param: 'prints', value: 0.8 }))
ws.send(JSON.stringify({ material: 'Claymation', param: 'clay', value: [0.1, 0.5, 0.9] }))
await new Promise((r) => blender.on('exit', r))
console.log('browser received from Blender:', JSON.stringify(got.filter((m) => m.from === 'blender')))
console.log('OSC addresses seen:', [...new Set(osc)].join(', '))
relay.kill(); oscIn.close(); ws.close()
const ok = blenderOut.includes('prints = 0.8') && blenderOut.includes('clay = (0.1, 0.5, 0.9)') && got.some((m) => m.from === 'blender') && osc.length > 0
console.log(ok ? 'live: all passed' : 'live: FAILED')
process.exit(ok ? 0 : 1)
