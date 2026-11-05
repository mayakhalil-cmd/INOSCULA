// Escape time with a very large bailout, so values get close to the float limit
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 p = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
    vec2 c = vec2(-0.745, 0.186) + p * 0.6;
    vec2 z = vec2(0.0);
    float n = 0.0;
    for (int i = 0; i < 40; i++) {
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
        if (dot(z, z) > 1e12) break;
        n += 1.0;
    }
    fragColor = vec4(log(dot(z, z)) / 60.0, n / 40.0, 0.5 + 0.5 * sin(iTime), 1.0);
}
