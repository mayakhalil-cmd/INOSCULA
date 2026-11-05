#version 300 es
precision highp float;
// Branches that differ per pixel, a cut out hole and a tone curve
in vec2 vUv;
uniform float u_time;
uniform float u_threshold; // @range 0 1 @label Threshold
out vec4 fragColor;

vec3 tonemap(vec3 c) {
    c = max(c, 0.0);
    return c / (1.0 + c);
}

void main() {
    vec2 p = vUv - 0.5;
    float r = length(p);
    if (r < 0.08) discard;
    vec3 col;
    if (p.x > 0.0 && p.y > 0.0) {
        col = vec3(2.0, 0.6, 0.3);
    } else if (p.x < 0.0) {
        col = vec3(0.3, 1.5, 2.5) * (1.0 + 0.5 * sin(u_time * 2.0 + r * 20.0));
    } else {
        float t = fract(r * 6.0 - u_time * 0.5);
        if (t > u_threshold) {
            col = vec3(t * 3.0);
            fragColor = vec4(tonemap(col), 1.0);
            return;
        }
        col = vec3(0.1, 0.1, 0.12);
    }
    fragColor = vec4(tonemap(col), 1.0);
}
