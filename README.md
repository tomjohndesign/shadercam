# ShaderCam

Real-time camera shaders with hand-tracking controls, live at **[shadercam.app](https://shadercam.app)**. The first shader is electrostatic stippling; more shaders will be added over time.

## Deployment

Production deploys to the `shadercam` Vercel project in the `tomjohn` team, served at [https://shadercam.app](https://shadercam.app).

## How It Works

1. Create and modify your project using [v0.app](https://v0.app)
2. Deploy your chats from the v0 interface
3. Changes are automatically pushed to this repository
4. Vercel deploys the latest version from this repository

## Dot density

Use the **Density (×)** control to adjust the number of dots from 0.25× to 16×. The default is 1× (16,384 dots); 4× gives 65,536 dots and 16× gives 262,144 dots. Higher density uses more GPU resources. Changing density restarts the particle simulation.

You can also set the initial density through the component prop:

```tsx
<StipplingCanvas density={4} />
```

Changes to the prop update the density, and **Reset to Defaults** restores that prop value. Counts are rounded to a square grid. Copied settings include both the density multiplier and the actual dot count.

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
