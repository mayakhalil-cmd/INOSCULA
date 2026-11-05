Shader "Custom/URP Wave"
{
    Properties
    {
        _BaseColor ("Base Color", Color) = (0.2, 0.5, 1, 1)
        _Frequency ("Frequency", Range(1, 40)) = 12
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }
        Pass
        {
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; };
            struct Varyings { float4 positionHCS : SV_POSITION; float2 uv : TEXCOORD0; };

            CBUFFER_START(UnityPerMaterial)
                half4 _BaseColor;
                float _Frequency;
            CBUFFER_END

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                OUT.positionHCS = TransformObjectToHClip(IN.positionOS.xyz);
                OUT.uv = IN.uv;
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                half w = 0.5 + 0.5 * sin(IN.uv.x * _Frequency + _Time.y * 2.0);
                return half4(_BaseColor.rgb * w, 1);
            }
            ENDHLSL
        }
    }
}
