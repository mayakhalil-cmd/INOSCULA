// Mandelbrot with smooth coloring
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 p = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
    float zoom = 0.8 + 0.2 * sin(iTime * 0.3);
    vec2 c = vec2(-0.745, 0.186) + p * zoom * 0.6;
    vec2 z = vec2(0.0);
    float n = 0.0;
    for (int i = 0; i < 60; i++) {
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
        if (dot(z, z) > 256.0) break;
        n += 1.0;
    }
    float sn = n - log2(log2(dot(z, z))) + 4.0;
    vec3 col = n >= 59.5 ? vec3(0.0) : 0.5 + 0.5 * cos(3.0 + sn * 0.15 + vec3(0.0, 0.6, 1.0));
    fragColor = vec4(col, 1.0);
}
