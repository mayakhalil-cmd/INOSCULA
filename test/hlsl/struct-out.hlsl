// Pulse rings with a struct output
float Time;
float2 Resolution;
float Speed = 2.0;

struct PSIn { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
struct PSOut { float4 color : SV_Target0; };

PSOut PSMain(PSIn i)
{
    PSOut o = (PSOut)0;
    float2 p = i.uv * 2.0 - 1.0;
    p.x *= Resolution.x / Resolution.y;
    float d = length(p);
    float r = 0.5 + 0.5 * cos(d * 18.0 - Time * Speed);
    float3 c = lerp(float3(0.1, 0.0, 0.3), float3(1.0, 0.6, 0.2), r * smoothstep(1.2, 0.0, d));
    o.color = float4(c, 1.0);
    return o;
}
