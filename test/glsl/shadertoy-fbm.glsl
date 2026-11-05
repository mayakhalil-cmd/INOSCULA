// Domain warped fbm with a value noise hash
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

float noise(in vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

const mat2 m = mat2(0.80, 0.60, -0.60, 0.80);

float fbm(vec2 p) {
    float f = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 5; i++) {
        f += amp * noise(p);
        p = m * p * 2.02;
        amp *= 0.5;
    }
    return f / 0.96875;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.y * 3.0;
    vec2 q = vec2(fbm(uv + vec2(0.0, 0.0)), fbm(uv + vec2(5.2, 1.3)));
    vec2 r = vec2(fbm(uv + 4.0 * q + vec2(1.7, 9.2) + 0.15 * iTime), fbm(uv + 4.0 * q + vec2(8.3, 2.8) + 0.126 * iTime));
    float f = fbm(uv + 4.0 * r);
    vec3 col = mix(vec3(0.1, 0.6, 0.67), vec3(0.67, 0.67, 0.5), clamp(f * f * 4.0, 0.0, 1.0));
    col = mix(col, vec3(0.0, 0.0, 0.16), clamp(length(q), 0.0, 1.0));
    col = mix(col, vec3(0.67, 1.0, 1.0), clamp(length(r.x), 0.0, 1.0));
    fragColor = vec4((f * f * f + 0.6 * f * f + 0.5 * f) * col, 1.0);
}
