// The few parts of the Universal Render Pipeline's Core.hlsl that the test shaders use, so the DirectX
// compiler can build them as Unity would. Only for drawing the reference picture in test/glsl_compare.mjs.
#define half float
#define half2 float2
#define half3 float3
#define half4 float4
#define CBUFFER_START(name) cbuffer name {
#define CBUFFER_END };
float4 _Time;
float4 TransformObjectToHClip(float3 p) { return float4(p, 1.0); }
