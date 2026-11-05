#version 300 es
precision highp float;
// Structs, arrays, out parameters, while, switch, integers and early returns
in vec2 vUv;
uniform float uTime;
out vec4 outColor;

struct Light { vec3 color; float power; };

const vec3 PALETTE[4] = vec3[4](vec3(0.9, 0.2, 0.2), vec3(0.2, 0.8, 0.3), vec3(0.2, 0.4, 0.9), vec3(0.95, 0.85, 0.2));

void split(in float x, out float whole, out float part) {
    whole = floor(x);
    part = x - whole;
}

float shade(vec2 p, inout int hits) {
    if (p.x < 0.0) return 0.25;
    hits += 1;
    float s = 0.0;
    int i = 0;
    while (i < 6) {
        s += sin(p.x * float(i + 1) * 3.0) / float(i + 1);
        i++;
        if (i == 4 && p.y > 0.7) break;
    }
    return 0.5 + 0.3 * s;
}

void main() {
    float whole, part;
    split(vUv.x * 4.0, whole, part);
    int idx = int(whole) % 4;
    vec3 base;
    switch (idx) {
        case 0: base = PALETTE[0]; break;
        case 1: base = PALETTE[1]; break;
        case 2:
        case 3: base = PALETTE[idx]; break;
        default: base = vec3(1.0);
    }
    int hits = 0;
    Light l = Light(vec3(1.0, 0.95, 0.9), 1.2);
    float s = shade(vUv * 2.0 - vec2(0.5, 0.0), hits);
    vec3 col = base * s * l.color * l.power;
    col = hits > 0 ? col : col * 0.5;
    col += 0.08 * smoothstep(0.45, 0.5, abs(part - 0.5));
    float k = 0.0;
    for (int j = 0; j < 8; j++) {
        if (j % 2 == 1) continue;
        k += 0.02 * float(j) * (0.5 + 0.5 * sin(uTime + float(j)));
    }
    outColor = vec4(col + k, 1.0);
}
