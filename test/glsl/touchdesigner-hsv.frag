// TouchDesigner GLSL TOP: a hue wheel that turns over time, shifted back and forth through HSV
uniform float uTime;
uniform float uShift; // 0..1
out vec4 fragColor;
void main()
{
    vec2 p = vUV.st * 2.0 - 1.0;
    float a = atan(p.y, p.x) / 6.2831853 + 0.5;
    vec3 c = TDHSVToRGB(vec3(fract(a + uTime * 0.05), clamp(length(p), 0.0, 1.0), 1.0));
    vec3 h = TDRGBToHSV(c);
    h.x = fract(h.x + uShift);
    vec2 px = vUV.st * uTDOutputInfo.res.zw;
    float grid = step(0.5, fract(px.x / 32.0)) * 0.1;
    fragColor = TDOutputSwizzle(TDDither(vec4(TDHSVToRGB(h) - grid, 1.0)));
}
