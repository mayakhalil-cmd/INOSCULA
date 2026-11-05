#ifdef GL_ES
precision highp float;
#endif
uniform float time;
uniform vec2 mouse;
uniform vec2 resolution;

void main(void) {
    vec2 p = (gl_FragCoord.xy * 2.0 - resolution) / min(resolution.x, resolution.y);
    float v = 0.0;
    v += sin(p.x * 10.0 + time);
    v += sin((p.y * 10.0 + time) / 2.0);
    v += sin((p.x * 10.0 + p.y * 10.0 + time) / 2.0);
    vec2 c = p + vec2(sin(time / 3.0), cos(time / 2.0)) * 0.5;
    v += sin(sqrt(c.x * c.x + c.y * c.y + 1.0) * 10.0 + time);
    v = v / 2.0;
    vec3 col = vec3(sin(v * 3.14159), sin(v * 3.14159 + 2.094), sin(v * 3.14159 + 4.188)) * 0.5 + 0.5;
    gl_FragColor = vec4(col, 1.0);
}
