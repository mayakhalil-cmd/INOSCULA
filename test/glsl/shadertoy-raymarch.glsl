// Simple raymarched scene, written the way most tutorials write it
#define MAX_STEPS 64
#define MAX_DIST 20.0
#define SURF_DIST 0.001

mat2 rot(float a) {
    float s = sin(a), c = cos(a);
    return mat2(c, -s, s, c);
}

float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float map(vec3 p) {
    float plane = p.y + 1.0;
    vec3 bp = p - vec3(0.0, 0.0, 0.0);
    bp.xz *= rot(iTime * 0.5);
    float box = sdBox(bp, vec3(0.5));
    float sphere = length(p - vec3(sin(iTime) * 1.5, 0.2, 0.0)) - 0.6;
    float k = 0.4;
    float h = clamp(0.5 + 0.5 * (sphere - box) / k, 0.0, 1.0);
    float blob = mix(sphere, box, h) - k * h * (1.0 - h);
    return min(plane, blob);
}

vec3 calcNormal(vec3 p) {
    vec2 e = vec2(0.001, 0.0);
    return normalize(vec3(
        map(p + e.xyy) - map(p - e.xyy),
        map(p + e.yxy) - map(p - e.yxy),
        map(p + e.yyx) - map(p - e.yyx)));
}

float rayMarch(vec3 ro, vec3 rd) {
    float d = 0.0;
    for (int i = 0; i < MAX_STEPS; i++) {
        vec3 p = ro + rd * d;
        float ds = map(p);
        d += ds;
        if (d > MAX_DIST || ds < SURF_DIST) break;
    }
    return d;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    vec3 ro = vec3(0.0, 1.0, -4.0);
    vec3 rd = normalize(vec3(uv.x, uv.y - 0.2, 1.0));
    float d = rayMarch(ro, rd);
    vec3 col = vec3(0.6, 0.75, 0.95) - rd.y * 0.4;
    if (d < MAX_DIST) {
        vec3 p = ro + rd * d;
        vec3 n = calcNormal(p);
        vec3 lightPos = vec3(2.0, 4.0, -3.0);
        vec3 l = normalize(lightPos - p);
        float dif = clamp(dot(n, l), 0.0, 1.0);
        vec3 r = reflect(-l, n);
        float spec = pow(max(dot(r, -rd), 0.0), 32.0);
        vec3 base = p.y < -0.99 ? vec3(0.4) + 0.3 * mod(floor(p.x) + floor(p.z), 2.0) : vec3(1.0, 0.45, 0.2);
        col = base * (0.15 + dif) + spec * 0.5;
        col = mix(col, vec3(0.6, 0.75, 0.95), 1.0 - exp(-0.02 * d * d));
    }
    col = pow(col, vec3(0.4545));
    fragColor = vec4(col, 1.0);
}
