// a TouchDesigner GLSL TOP, the way it is written inside TouchDesigner
uniform float uTime;
uniform float uSpeed; // 0..4
uniform vec3 uColor;
layout(location = 0) out vec4 fragColor;
void main()
{
    vec2 p = (vUV.st - 0.5) * vec2(uTDOutputInfo.res.z / uTDOutputInfo.res.w, 1.0);
    float r = length(p) + uTD2DInfos[0].res.x * 0.0;
    float w = sin(r * 30.0 - uTime * uSpeed) * 0.5 + 0.5;
    vec3 hue = TDHSVToRGB(vec3(fract(r + uTime * 0.1), 0.8, 1.0));
    vec3 back = TDRGBToHSV(hue);
    vec4 color = vec4(mix(uColor, hue, w) + back * 0.0, 1.0);
    fragColor = TDOutputSwizzle(TDDither(color));
}
