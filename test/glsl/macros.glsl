// Macros, #if and helpers written as macros
#define QUALITY 2
#define R iResolution
#define rot2(a) mat2(cos(a), -sin(a), sin(a), cos(a))
#define SAT(x) clamp(x, 0.0, 1.0)
#define REPEAT(p, s) (mod(p + 0.5 * s, s) - 0.5 * s)
#if QUALITY > 1
  #define SAMPLES 3
#else
  #define SAMPLES 1
#endif
#ifndef HW_PERFORMANCE
  #define HW_PERFORMANCE 1
#endif

float star(vec2 p, float n) {
    float a = atan(p.y, p.x);
    float r = length(p);
    return SAT(1.0 - r * (2.0 + 0.6 * cos(a * n)));
}

void mainImage(out vec4 O, vec2 U) {
    vec3 acc = vec3(0);
    for (int s = 0; s < SAMPLES; s++) {
        vec2 off = vec2(float(s) / float(SAMPLES), 0.0);
        vec2 p = (U + off - 0.5 * R.xy) / R.y;
        p *= rot2(iTime * 0.2);
        p = REPEAT(p, 0.5);
        float v = star(p * 3.0, 5.0);
        acc += vec3(v, v * v, 0.3 + 0.7 * v);
    }
    O = vec4(acc / float(SAMPLES), 1);
}
