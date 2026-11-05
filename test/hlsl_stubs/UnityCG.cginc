// The few parts of Unity's UnityCG.cginc that the test shaders use, so the DirectX compiler can build them
// as Unity would. Only for drawing the reference picture in test/glsl_compare.mjs.
#define fixed float
#define fixed2 float2
#define fixed3 float3
#define fixed4 float4
#define half float
#define half2 float2
#define half3 float3
#define half4 float4
float4 _Time;
float4 _SinTime;
float4 _CosTime;
#define UNITY_FOG_COORDS(x)
#define UNITY_TRANSFER_FOG(a, b)
#define UNITY_APPLY_FOG(a, b)
#define TRANSFORM_TEX(uv, name) (uv)
#define UNITY_PI 3.14159265359
float4 UnityObjectToClipPos(float4 v) { return v; }
float4 UnityObjectToClipPos(float3 v) { return float4(v, 1.0); }
