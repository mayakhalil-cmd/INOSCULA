// TouchDesigner GLSL TOP style
uniform float uTime;
out vec4 fragColor;

void main() {
    vec2 uv = vUV.st;
    vec2 p = uv * 2.0 - 1.0;
    float r = length(p);
    float a = atan(p.y, p.x);
    float f = 0.5 + 0.5 * sin(a * 6.0 + r * 12.0 - uTime * 3.0);
    vec4 color = vec4(vec3(f) * vec3(0.2, 0.7, 1.0) + vec3(0.05), 1.0);
    fragColor = TDOutputSwizzle(color);
}
