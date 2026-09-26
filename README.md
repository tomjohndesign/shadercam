# ShaderCam

Real-time camera shaders with hand-tracking controls, live at **[shadercam.app](https://shadercam.app)**. The first shader is electrostatic stippling; more shaders will be added over time.

## Stipple shader

A reusable GPU particle stippling effect for images, videos, webcams, and canvases. The webcam playground and standalone module use the same shaders and renderer.

### Use on any site

Open `/stipple/demo.html` on the deployed site to preview the effect, upload an image, adjust settings, download the module, and copy an embed snippet. The demo does not request camera or microphone access.

Download `stipple.js` and put it in your site's public folder. It is a browser ES module with Three.js and the GPU simulation bundled inside: no React, package installation, import map, or external runtime CDN is needed.

```html
<canvas id="stipple" style="width:100%;height:500px;display:block"></canvas>
<script type="module">
  import { createStippleEffect } from '/stipple.js';

  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = '/your-image.jpg';
  await image.decode();

  const effect = createStippleEffect({
    canvas: document.querySelector('#stipple'),
    source: image,
    density: 1,
    radius: 1,
  });

  // effect.update({ radius: 2, attraction: 1.2 });
  // effect.pause();
  // effect.resume();
  // effect.dispose(); // Call when removing the effect.
</script>
```

Serve the files over HTTP(S), rather than opening `file://` URLs. The canvas needs an explicit CSS height. It resizes automatically with its container and renders at one pixel per CSS pixel, matching the original effect's dot sizes.

The module processes media, not arbitrary HTML/DOM content. Remote media must allow CORS; set `crossOrigin = 'anonymous'` before its URL. WebGL 2 and `EXT_color_buffer_float` are required. Initialization throws an error if unsupported, which your app can catch to show the original media as a fallback.

### Video and webcam

Pass a loaded `HTMLVideoElement` as `source`. Playback, permissions, and media stream ownership stay with your app. For a camera, request access from a user action over HTTPS (or localhost):

```js
const video = document.createElement('video');
video.muted = true;
video.playsInline = true;
const stream = await navigator.mediaDevices.getUserMedia({ video: true });
video.srcObject = stream;
await video.play();
const effect = createStippleEffect({ canvas, source: video, mirror: true });

// When finished:
effect.dispose();
stream.getTracks().forEach(track => track.stop());
video.srcObject = null;
```

For a video file, set `video.src`, `video.loop`, and CORS as needed before playback. A canvas source is uploaded every render, so it can contain live graphics. Load images with `await image.decode()` before creating an effect. To change the source, dispose the effect and create another with the same canvas.

### Options

All options except `canvas` and `source` are optional. They can also be changed with `effect.update()`.

| Option | Default | Range / behavior |
| --- | --- | --- |
| `density` | `1` | `0.25–16`; 1× = 16,384 dots; changing this resets the grid |
| `threshold` | `0.64` | `0–1`; luminance threshold for attraction |
| `attraction` | `1.58` | `0–2`; attraction toward dark image regions |
| `repulsion` | `0.75` | `0–1`; separation between neighboring dots |
| `returnStrength` | `0.55` | `0–1`; pull toward original grid positions |
| `radius` | `1` | `1–10`; base square dot size in CSS pixels |
| `friction` | `0.89` | `0–1`; velocity damping |
| `inverted` | `false` | Attract toward light regions instead |
| `active` | `true` | `false` returns particles toward the grid; use `pause()` to freeze rendering |
| `mirror` | `false` | Horizontal reflection; the webcam playground sets this to `true` |

`createStippleEffect` also accepts two constructor-only options: `resolution: { width, height }` fixes the drawing-buffer size instead of following the canvas's CSS size, and `onFrame(canvas)` runs right after each render while the WebGL drawing buffer is still readable. The Mac camera uses both to publish 1280 × 720 frames.

Finite numeric values are clamped to the supported ranges; non-finite values throw. Higher density costs more GPU work. Rendering suspends while the page is hidden. The simulation runs at a fixed 60 Hz to keep motion consistent across refresh rates. For reduced-motion experiences, use a static source and call `pause()` after rendering a frame, or show the original media.

### React / other frameworks

Import `createStippleEffect` from `lib/stipple` inside this repository, or from the downloaded module in another application. Create the effect in a client-side mount hook after the media loads, and return `effect.dispose()` from its cleanup. Call `update()` for live settings instead of recreating the renderer. Do not create it during server rendering.

```tsx
useEffect(() => {
  if (!canvasRef.current || !loadedImage) return;
  const effect = createStippleEffect({
    canvas: canvasRef.current,
    source: loadedImage,
  });
  return () => effect.dispose();
}, [loadedImage]);
```

### Raw shaders

`lib/stipple/shaders.ts` exports `velocityShader`, `positionShader`, `particleVertexShader`, and `particleFragmentShader`. They are also exported by the standalone module and emitted as downloadable `.glsl` files in `/stipple/`.

This is a stateful particle effect, using ping-pong position/velocity textures and a points draw pass, rather than a single fullscreen fragment shader. The simulation shaders expect `GPUComputationRenderer` to inject `texturePosition`, `textureVelocity`, and the `resolution` definition. Position RG stores coordinates in `[-1, 1]`, BA stores home coordinates; velocity RG stores motion. See `lib/stipple/index.ts` for dependencies, uniforms, initialization, and cleanup.

### Development

```sh
pnpm install
pnpm dev
pnpm build
```

`pnpm build:stipple` bundles the reusable ES module and emits raw GLSL into `public/stipple/`. Both `dev` and `build` run this automatically. Generated files are gitignored. The downloadable HTML demo is a standalone integration example: save it beside `stipple.js` and serve the directory. The module includes its dependency license notices; retain them when redistributing.

The playground accepts `<StipplingCanvas density={4} />`. Its controls, hand tracking, and webcam selection remain available at `/`.

Deploy production changes to the `tomjohn/shadercam` Vercel project (https://shadercam.app) after a successful `pnpm build`.

## Standalone Mac camera

ShaderCam bundles the effect, an Electron host, and a native Core Media I/O camera extension. The extension presents **ShaderCam** in meeting apps at 1280 × 720, 30 fps. No OBS, screen capture, Node.js, or terminal is needed by the person installing it.

### Install and use

1. Open the signed, notarized DMG and drag **ShaderCam** into **Applications**.
2. Launch ShaderCam and allow camera access. When macOS asks, enable its camera extension in **System Settings → General → Login Items & Extensions → Camera Extensions**. Older macOS versions show extension approval under **Privacy & Security**.
3. Choose your physical camera and adjust the effect. Select **ShaderCam** in your call’s camera menu; restart the meeting app if its camera list hasn’t refreshed.
4. Keep ShaderCam open during the call. Use your normal microphone in the meeting app. **Stop camera** releases capture and the virtual camera switches to black; quitting also stops the video.

The app processes frames locally. Hand controls and their model are bundled for offline use. Microphone permission is requested only for optional snap/clap controls. The browser version is a preview and cannot install a system camera.

Requires macOS 13 or newer. Builds target the architecture of the build Mac (Apple silicon or Intel). To uninstall, quit ShaderCam and move it from Applications to Trash; macOS manages removal of the associated extension.

### Build a signed release

Maintainers need Node.js, pnpm, Apple Command Line Tools, a Developer ID Application certificate with its private key in Keychain, and a Developer ID provisioning profile for `com.tomjohn.stipplecam` with **System Extension** enabled. The extension bundle ID is `com.tomjohn.stipplecam.camera-extension`; both components are signed by the same team. These bundle IDs predate the ShaderCam name and are kept so existing installs update in place and the existing provisioning profile keeps working. The native bridge uses Node-API and needs no separate runtime installation.

```sh
pnpm install --frozen-lockfile
export CODE_SIGN_IDENTITY='Developer ID Application: Your Name (TEAMID)'
export APPLE_TEAM_ID='TEAMID'
export MAC_PROVISIONING_PROFILE='/absolute/path/ShaderCam_Developer_ID.provisionprofile'
export NOTARYTOOL_PROFILE='your-existing-keychain-profile'
pnpm mac:build
```

`mac:build` compiles and checks the native code, exports the web UI, packages the offline hand model, signs nested components and the host, notarizes and staples the app, then produces and notarizes `dist/ShaderCam-arm64.dmg` (or `-x64.dmg`). The initial build downloads Electron and the model. Set `MAC_BUILD_NUMBER` to override the default timestamp build number; increment it when updating an installed extension.

Without `NOTARYTOOL_PROFILE`, the script produces a signed app only and explicitly reports that it is not notarized. Normal installation testing should use a notarized release. Signing profiles, credentials, intermediates, and artifacts stay outside Git. Never place private keys or passwords in source files.

The Mac build leaves a static `.next` output; run `pnpm build` before starting or deploying the normal web app. Web deployment uses the `shadercam` Vercel project.

### Native architecture and checks

The sandboxed camera extension has a sink for one local frame writer and a source for meeting apps. As with a standard CMIO sink, any local client can request the writer slot; unavailable client signing metadata is not treated as authentication. A bounded queue carries BGRA frames; the source retains only the most recent image and falls back to black after 500 ms without new input. Stopping clears the retained image. Renderer IPC is restricted to the local app’s main frame and validates frame dimensions. Device enumeration excludes ShaderCam itself to prevent feedback.

The build’s native self-test checks source/sink configuration, stale-frame expiry, and clearing. Release verification additionally requires macOS extension approval, camera enumeration, and checking live frames in a capture client; successful compilation alone does not establish meeting compatibility.

Apple reference: [Creating a camera extension with Core Media I/O](https://developer.apple.com/documentation/coremediaio/creating-a-camera-extension-with-core-media-i-o).
