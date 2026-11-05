// Book of Shaders style
#ifdef GL_ES
precision mediump float;
#endif

uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_time;

float plot(vec2 st, float pct) {
    return smoothstep(pct - 0.02, pct, st.y) - smoothstep(pct, pct + 0.02, st.y);
}

void main() {
    vec2 st = gl_FragCoord.xy / u_resolution.xy;
    float y = pow(st.x, 5.0);
    vec3 color = vec3(y);
    float pct = plot(st, y);
    color = (1.0 - pct) * color + pct * vec3(0.0, 1.0, 0.0);
    vec2 bl = step(vec2(0.1), st);
    vec2 tr = step(vec2(0.1), 1.0 - st);
    color *= bl.x * bl.y * tr.x * tr.y;
    color += vec3(abs(sin(u_time)) * 0.2, 0.0, 0.1);
    gl_FragColor = vec4(color, 1.0);
}
