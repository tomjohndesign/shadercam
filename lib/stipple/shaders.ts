// GPUComputationRenderer injects simulation texture uniforms and resolution.
export const velocityShader = `
uniform sampler2D videoTexture;
uniform float uThreshold;
uniform float uAttraction;
uniform float uRepulsion;
uniform float uReturnStrength;
uniform float uFriction;
uniform float uInverted;
uniform float uActive;
uniform float videoAspect;
uniform float screenAspect;
uniform float uMirror;

vec2 sourceUV(vec2 position) {
  vec2 uv = position * 0.5 + 0.5;
  vec2 scale = vec2(min(screenAspect / videoAspect, 1.0), min(videoAspect / screenAspect, 1.0));
  uv = (uv - 0.5) * scale + 0.5;
  if (uMirror > 0.5) uv.x = 1.0 - uv.x;
  return uv;
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec4 posData = texture2D(texturePosition, uv);
  vec4 velData = texture2D(textureVelocity, uv);

  vec2 pos = posData.xy;
  vec2 home = posData.zw;
  vec2 vel = velData.xy;

  if (uActive < 0.5) {
    // Simulation paused - strong return to home
    vec2 toHome = home - pos;
    vel += toHome * 0.5;
    vel *= 0.8;
  } else {
    // Sample video with aspect ratio correction (cover mode)
    vec2 videoUV = sourceUV(pos);

    vec4 videoColor = texture2D(videoTexture, videoUV);
    float brightness = dot(videoColor.rgb, vec3(0.299, 0.587, 0.114));

    // Invert if needed
    if (uInverted > 0.5) {
      brightness = 1.0 - brightness;
    }

    // Attraction to dark areas (below threshold)
    float attractionFactor = (1.0 - smoothstep(uThreshold - 0.3, uThreshold, brightness));

    // Sample neighbors for local density
    float repulsionForce = 0.0;
    vec2 repulsionDir = vec2(0.0);
    float sampleRadius = 2.0 / resolution.x;

    for (int i = 0; i < 8; i++) {
      float angle = float(i) * 0.785398;
      vec2 offset = vec2(cos(angle), sin(angle)) * sampleRadius;
      vec4 neighborPos = texture2D(texturePosition, uv + offset);
      vec2 diff = pos - neighborPos.xy;
      float dist = length(diff);
      if (dist > 0.001 && dist < 0.1) {
        repulsionDir += normalize(diff) / (dist + 0.01);
        repulsionForce += 1.0;
      }
    }

    if (repulsionForce > 0.0) {
      repulsionDir /= repulsionForce;
    }

    // Apply forces
    vel += repulsionDir * uRepulsion * 0.001;

    // Attraction pulls toward darker areas (move toward gradient)
    vec2 gradientDir = vec2(0.0);
    float eps = 0.01;
    float bRight = dot(texture2D(videoTexture, videoUV + vec2(eps, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
    float bLeft = dot(texture2D(videoTexture, videoUV - vec2(eps, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
    float bUp = dot(texture2D(videoTexture, videoUV + vec2(0.0, eps)).rgb, vec3(0.299, 0.587, 0.114));
    float bDown = dot(texture2D(videoTexture, videoUV - vec2(0.0, eps)).rgb, vec3(0.299, 0.587, 0.114));

    if (uInverted > 0.5) {
      bRight = 1.0 - bRight;
      bLeft = 1.0 - bLeft;
      bUp = 1.0 - bUp;
      bDown = 1.0 - bDown;
    }

    gradientDir.x = (bLeft - bRight) * (uMirror > 0.5 ? -1.0 : 1.0);
    gradientDir.y = bDown - bUp;

    vel += gradientDir * uAttraction * attractionFactor * 0.08;

    // Return to home
    vec2 toHome = home - pos;
    vel += toHome * uReturnStrength;

    // Friction
    vel *= (1.0 - uFriction);

    // Sleep threshold to reduce jitter
    if (length(vel) < 0.0001) {
      vel *= 0.5;
    }

    // Clamp velocity
    float maxSpeed = 0.02;
    if (length(vel) > maxSpeed) {
      vel = normalize(vel) * maxSpeed;
    }
  }

  gl_FragColor = vec4(vel, 0.0, 1.0);
}
`

export const positionShader = `
void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec4 posData = texture2D(texturePosition, uv);
  vec4 velData = texture2D(textureVelocity, uv);

  vec2 pos = posData.xy + velData.xy;

  // Clamp to bounds
  pos = clamp(pos, vec2(-1.0), vec2(1.0));

  gl_FragColor = vec4(pos, posData.zw);
}
`

export const particleVertexShader = `
uniform sampler2D texturePosition;
uniform sampler2D videoTexture;
uniform float uRadius;
uniform float videoAspect;
uniform float screenAspect;
uniform float uMirror;
varying float vBrightness;

vec2 sourceUV(vec2 position) {
  vec2 uv = position * 0.5 + 0.5;
  vec2 scale = vec2(min(screenAspect / videoAspect, 1.0), min(videoAspect / screenAspect, 1.0));
  uv = (uv - 0.5) * scale + 0.5;
  if (uMirror > 0.5) uv.x = 1.0 - uv.x;
  return uv;
}

void main() {
  vec4 posData = texture2D(texturePosition, uv);
  vec3 pos = vec3(posData.xy, 0.0);

  // Sample video for size variation
  vec2 videoUV = sourceUV(pos.xy);

  vec4 videoColor = texture2D(videoTexture, videoUV);
  vBrightness = dot(videoColor.rgb, vec3(0.299, 0.587, 0.114));

  // Particles in dark areas are larger
  float sizeMult = mix(2.0, 0.5, vBrightness);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = uRadius * sizeMult;
}
`

export const particleFragmentShader = `
void main() {
  // Square particles
  gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
}
`
