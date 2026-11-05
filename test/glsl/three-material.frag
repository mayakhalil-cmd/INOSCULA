// three.js ShaderMaterial style
uniform float uTime;
uniform vec3 uColor;
uniform float uStripes;
varying vec2 vUv;

void main() {
    float s = sin((vUv.x + vUv.y) * uStripes + uTime * 2.0);
    float band = smoothstep(-0.2, 0.2, s);
    vec3 col = mix(uColor, vec3(1.0) - uColor, band);
    float vig = 1.0 - length(vUv - 0.5) * 1.2;
    gl_FragColor = vec4(col * vig, 1.0);
}
