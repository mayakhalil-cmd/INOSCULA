// Rings
#define PI 3.14159265
#define S(a, b, t) smoothstep(a, b, t)

float sdCircle(vec2 p, float r) { return length(p) - r; }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    float d = sdCircle(uv, 0.3);
    vec3 col = (d > 0.0) ? vec3(0.9, 0.6, 0.3) : vec3(0.65, 0.85, 1.0);
    col *= 1.0 - exp(-6.0 * abs(d));
    col *= 0.8 + 0.2 * cos(150.0 * d - iTime * 4.0);
    col = mix(col, vec3(1.0), 1.0 - S(0.0, 0.01, abs(d)));
    float a = atan(uv.y, uv.x) / (2.0 * PI) + 0.5;
    col += 0.1 * step(0.5, fract(a * 8.0 + iTime * 0.1));
    fragColor = vec4(col, 1.0);
}
