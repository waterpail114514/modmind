import type { ProjectInfo } from '../../../../src/shared/types'

export function shaderTemplateFiles(project: ProjectInfo): Record<string, string> {
  const vertex = `#version 120
varying vec2 texcoord;
varying vec2 lightcoord;
varying vec4 vertexColor;
void main() {
    gl_Position = ftransform();
    texcoord = gl_MultiTexCoord0.xy;
    lightcoord = (gl_TextureMatrix[1] * gl_MultiTexCoord1).xy;
    vertexColor = gl_Color;
}
`
  const fragment = `#version 120
uniform sampler2D texture;
uniform sampler2D lightmap;
varying vec2 texcoord;
varying vec2 lightcoord;
varying vec4 vertexColor;
void main() {
    vec4 surface = texture2D(texture, texcoord) * vertexColor;
    if (surface.a < 0.1) discard;
    vec3 lighting = texture2D(lightmap, lightcoord).rgb;
    /* DRAWBUFFERS:0 */
    gl_FragData[0] = vec4(surface.rgb * lighting, surface.a);
}
`
  const tone = project.studioValues?.quality === 'vivid' ? '1.2' : '1.0'
  return {
    'shaders/gbuffers_terrain.vsh': vertex, 'shaders/gbuffers_terrain.fsh': fragment,
    'shaders/gbuffers_textured.vsh': vertex, 'shaders/gbuffers_textured.fsh': fragment,
    'shaders/final.vsh': `#version 120
varying vec2 texcoord;
void main() {
    gl_Position = ftransform();
    texcoord = gl_MultiTexCoord0.xy;
}
`,
    'shaders/lib/options.glsl': `#define EXPOSURE 1.0 // [0.5 0.75 1.0 1.25 1.5 2.0]
#define SATURATION ${tone} // [0.0 0.8 1.0 1.2 1.5]
#define CONTRAST 1.0 // [0.8 1.0 1.2 1.4]
`,
    'shaders/final.fsh': `#version 120
#include "/lib/options.glsl"
uniform sampler2D colortex0;
varying vec2 texcoord;
void main() {
    vec3 color = texture2D(colortex0, texcoord).rgb * EXPOSURE;
    float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luminance), color, SATURATION);
    color = (color - 0.5) * CONTRAST + 0.5;
    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`,
    'shaders/shaders.properties': `oldLighting=true
clouds=fancy
screen=EXPOSURE SATURATION CONTRAST
sliders=EXPOSURE SATURATION CONTRAST
profile.BALANCED=EXPOSURE:1.0 SATURATION:1.0 CONTRAST:1.0
profile.VIVID=EXPOSURE:1.0 SATURATION:1.2 CONTRAST:1.2
`,
    'shaders/lang/en_us.lang': 'option.EXPOSURE=Exposure\noption.SATURATION=Saturation\noption.CONTRAST=Contrast\n',
    'shaders/lang/zh_cn.lang': 'option.EXPOSURE=曝光\noption.SATURATION=饱和度\noption.CONTRAST=对比度\n',
    'README.md': `# ${project.name}\n\nIris shader pack targeting Minecraft ${project.minecraftVersion}.\n\nEditable baseline: terrain texturing, lightmap, alpha testing and final color grading.\nStatic syntax checks and final-pass preview are not complete in-game validation.\n`,
    'LICENSE.txt': 'The generated shader template is provided under the MIT license.\nCopyright (c) 2026 ModMind contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies, subject to including this notice.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY ARISING FROM THE SOFTWARE.\n'
  }
}
