// Moving cells
vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy * 5.0;
    vec2 ip = floor(uv);
    vec2 fp = fract(uv);
    float md = 8.0;
    vec2 mc = vec2(0.0);
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 o = hash2(ip + g);
        o = 0.5 + 0.5 * sin(iTime + 6.2831 * o);
        vec2 r = g + o - fp;
        float d = dot(r, r);
        if (d < md) { md = d; mc = o; }
    }
    vec3 col = 0.5 + 0.5 * cos(mc.x * 6.0 + vec3(0.0, 1.0, 2.0));
    col *= 1.0 - 0.6 * sqrt(md);
    fragColor = vec4(col, 1.0);
}
