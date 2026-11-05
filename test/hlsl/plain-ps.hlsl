// Plasma, as a plain HLSL pixel shader
cbuffer Params : register(b0)
{
    float Time;
    float Speed; // @range 0 4 @default 1
    float3 Tint;
};

static const float TWO_PI = 6.28318530718;

struct PSInput
{
    float4 position : SV_POSITION;
    float2 uv : TEXCOORD0;
};

float3 palette(float t)
{
    return 0.5 + 0.5 * cos(TWO_PI * (t + float3(0.0, 0.33, 0.67)));
}

float4 PSMain(PSInput input) : SV_TARGET
{
    float2 p = input.uv * 2.0 - 1.0;
    float t = Time * Speed;
    float v = sin(p.x * 4.0 + t) + sin(p.y * 3.0 - t * 0.7);
    v += sin(length(p) * 6.0 - t * 1.3);
    float2x2 rot = float2x2(cos(t * 0.2), -sin(t * 0.2), sin(t * 0.2), cos(t * 0.2));
    float2 q = mul(rot, p);
    v += 0.5 * sin(q.x * 5.0);
    float3 col = palette(frac(v * 0.15 + 0.5));
    col = lerp(col, col * Tint, 0.5);
    return float4(saturate(col), 1.0);
}
