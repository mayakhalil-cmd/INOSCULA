Shader "Custom/Stripes"
{
    Properties
    {
        _ColorA ("First Color", Color) = (1, 0.4, 0.1, 1)
        _ColorB ("Second Color", Color) = (0.1, 0.2, 0.8, 1)
        _Count ("Stripe Count", Range(1, 40)) = 12
        _Speed ("Speed", Float) = 0.5
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" }
        LOD 100

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog

            #include "UnityCG.cginc"

            struct appdata
            {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
            };

            struct v2f
            {
                float2 uv : TEXCOORD0;
                UNITY_FOG_COORDS(1)
                float4 vertex : SV_POSITION;
            };

            fixed4 _ColorA;
            fixed4 _ColorB;
            float _Count;
            float _Speed;

            v2f vert (appdata v)
            {
                v2f o;
                o.vertex = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                UNITY_TRANSFER_FOG(o,o.vertex);
                return o;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                float s = frac((i.uv.x + i.uv.y) * _Count * 0.5 + _Time.y * _Speed);
                float m = smoothstep(0.45, 0.55, s);
                fixed4 col = lerp(_ColorA, _ColorB, m);
                UNITY_APPLY_FOG(i.fogCoord, col);
                return col;
            }
            ENDCG
        }
    }
}
