// Neon tunnel, HLSL the way AI tools and ports from Shadertoy tend to write it
cbuffer Globals
{
    float iTime;
    float2 iResolution;
    float Glow; // @range 0 3 @default 1.2
};

static const float3 PALETTE[3] = { float3(1.0, 0.2, 0.6), float3(0.2, 0.8, 1.0), float3(1.0, 0.9, 0.3) };

float2x2 rotate(float a)
{
    float s, c;
    sincos(a, s, c);
    return float2x2(c, -s, s, c);
}

float band(float x, float w)
{
    return saturate(1.0 - abs(x) / w);
}

void main(float4 pos : SV_POSITION, float2 uv : TEXCOORD0, out float4 color : SV_Target0)
{
    float2 p = (pos.xy * 2.0 - iResolution) / iResolution.y;
    p = mul(rotate(iTime * 0.3), p);
    float r = length(p);
    float a = atan2(p.y, p.x);
    float depth = 0.4 / max(r, 0.05) + iTime;
    float3 col = 0;
    [unroll]
    for (int i = 0; i < 3; i++)
    {
        float k = (float)i;
        float stripe = fmod(depth * 2.0 + k * 0.7, 1.0);
        float spokes = abs(frac(a / 6.2831853 * 8.0 + k * 0.33) - 0.5);
        col += PALETTE[i] * band(stripe - 0.5, 0.12) * (0.4 + spokes);
    }
    col *= Glow * saturate(r * 1.5);
    clip(r - 0.03);
    color = float4(col, 1.0);
}
