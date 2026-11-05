// Glowing rings, for an Unreal Custom node with the inputs UV, Time and Scale
float2 p = (UV - 0.5) * Scale;
float d = length(p);
float rings = sin(d * 20.0 - Time * 3.0) * 0.5 + 0.5;
float3 col = lerp(float3(0.05, 0.1, 0.3), float3(1.0, 0.8, 0.3), rings);
col *= saturate(1.2 - d);
return col;
