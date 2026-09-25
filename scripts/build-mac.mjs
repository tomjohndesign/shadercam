import { spawnSync } from 'node:child_process'
import { cp, mkdir, rm, writeFile, access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { packager } from '@electron/packager'
import { sign } from '@electron/osx-sign'
const require = createRequire(import.meta.url)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
  return result.stdout
}
function xml(value) {
  const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>'
  if (Array.isArray(value)) return `<array>${value.map(xml).join('')}</array>`
  if (typeof value === 'object') return `<dict>${Object.entries(value).map(([key, item]) => `<key>${escape(key)}</key>${xml(item)}`).join('')}</dict>`
  return `<string>${escape(value)}</string>`
}
const plist = (file, data) => writeFile(file, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${xml(data)}</plist>`)

if (process.platform !== 'darwin') throw new Error('Build the Mac app on macOS.')
const identity = process.env.CODE_SIGN_IDENTITY
const team = process.env.APPLE_TEAM_ID
const profile = process.env.MAC_PROVISIONING_PROFILE
if (!identity || !team || !profile) throw new Error('Set CODE_SIGN_IDENTITY, APPLE_TEAM_ID, and MAC_PROVISIONING_PROFILE. See README.md.')
await access(profile)
const appID = 'com.tomjohn.stipplecam'
const extensionID = `${appID}.camera-extension`
const group = `${team}.${appID}`
const buildNumber = process.env.MAC_BUILD_NUMBER || String(Math.floor(Date.now() / 1000))
const version = require('../desktop/package.json').version
const stage = '.context/mac-package'
const native = '.context/native-build'
await mkdir(native, { recursive: true })
const compiler = ['clang++', '-std=c++17', '-fobjc-arc', '-O2', '-mmacosx-version-min=13.0', '-framework', 'Foundation', '-framework', 'CoreMediaIO', '-framework', 'CoreMedia', '-framework', 'CoreVideo']
run('xcrun', [...compiler, 'desktop/native/CameraExtension.mm', '-o', `${native}/StippleCameraExtension`])
run(`${native}/StippleCameraExtension`, ['--self-test'])
run('xcrun', [...compiler, '-DNAPI_VERSION=8', '-I', require('node-api-headers').include_dir, '-bundle', '-undefined', 'dynamic_lookup', '-framework', 'SystemExtensions', 'desktop/native/CameraBridge.mm', '-o', `${native}/stipple-camera.node`])
run(process.execPath, [require.resolve('next/dist/bin/next'), 'build'], { env: { ...process.env, STIPPLE_DESKTOP: '1' } })
await rm(stage, { recursive: true, force: true })
await mkdir(stage, { recursive: true })
for (const file of ['main.cjs', 'preload.cjs', 'package.json']) await cp(`desktop/${file}`, `${stage}/${file}`)
await cp('out', `${stage}/web`, { recursive: true })
await cp('node_modules/@mediapipe/tasks-vision/wasm', `${stage}/web/mediapipe/wasm`, { recursive: true })
const modelPath = '.context/hand_landmarker.task'
try { await access(modelPath) } catch {
  const response = await fetch('https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task')
  if (!response.ok) throw new Error(`Hand model download failed: ${response.status}`)
  await writeFile(modelPath, new Uint8Array(await response.arrayBuffer()))
}
await cp(modelPath, `${stage}/web/mediapipe/hand_landmarker.task`)
const result = await packager({
  dir: stage, out: 'dist', name: 'Stipple Cam', platform: 'darwin', arch: process.arch,
  electronVersion: require('electron/package.json').version,
  appBundleId: appID, appCategoryType: 'public.app-category.video', appVersion: version, buildVersion: buildNumber,
  overwrite: true, asar: true,
  extendInfo: {
    LSMinimumSystemVersion: '13.0',
    NSCameraUsageDescription: 'Stipple Cam uses your camera to create a live stippled video for calls.',
    NSMicrophoneUsageDescription: 'Optional hand controls use your microphone to detect snaps and claps.',
    NSSystemExtensionUsageDescription: 'Stipple Cam adds a camera you can select in calls and meetings.',
  },
})
const appPath = path.resolve(result[0], 'Stipple Cam.app')
const extension = `${appPath}/Contents/Library/SystemExtensions/${extensionID}.systemextension`
await mkdir(`${extension}/Contents/MacOS`, { recursive: true })
await cp(`${native}/StippleCameraExtension`, `${extension}/Contents/MacOS/StippleCameraExtension`)
await cp(`${native}/stipple-camera.node`, `${appPath}/Contents/Resources/stipple-camera.node`)
await cp(profile, `${appPath}/Contents/embedded.provisionprofile`)
await plist(`${extension}/Contents/Info.plist`, {
  CFBundleIdentifier: extensionID, CFBundleExecutable: 'StippleCameraExtension', CFBundleName: 'Stipple Cam Camera',
  CFBundlePackageType: 'SYSX', CFBundleInfoDictionaryVersion: '6.0', CFBundleShortVersionString: version, CFBundleVersion: buildNumber,
  LSMinimumSystemVersion: '13.0', NSSystemExtensionUsageDescription: 'Makes Stipple Cam available as a camera in calls and meetings.',
  CMIOExtension: { CMIOExtensionMachServiceName: `${group}.camera` },
})
await plist(`${native}/extension.entitlements`, {
  'com.apple.security.app-sandbox': true,
  'com.apple.security.application-groups': [group],
})
const electronEntitlements = {
  'com.apple.security.cs.allow-jit': true,
  'com.apple.security.device.camera': true,
  'com.apple.security.device.audio-input': true,
}
await plist(`${native}/helper.entitlements`, electronEntitlements)
await plist(`${native}/main.entitlements`, {
  ...electronEntitlements,
  'com.apple.developer.system-extension.install': true,
  'com.apple.application-identifier': `${team}.${appID}`,
  'com.apple.developer.team-identifier': team,
  'com.apple.security.application-groups': [group],
})
run('codesign', ['--force', '--timestamp', '--options', 'runtime', '--sign', identity, '--entitlements', `${native}/extension.entitlements`, extension])
await sign({
  app: appPath, identity, platform: 'darwin',
  preAutoEntitlements: false, preEmbedProvisioningProfile: false,
  ignore: file => file.includes('.systemextension'),
  optionsForFile: file => ({ entitlements: path.resolve(native, file === appPath ? 'main.entitlements' : 'helper.entitlements') }),
})
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
console.log(`Signed app built: ${appPath}`)
if (process.env.NOTARYTOOL_PROFILE) {
  const zip = path.resolve('dist/Stipple-Cam-notarization.zip')
  await rm(zip, { force: true })
  run('ditto', ['-c', '-k', '--keepParent', appPath, zip])
  run('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', process.env.NOTARYTOOL_PROFILE, '--wait'])
  run('xcrun', ['stapler', 'staple', appPath])
  run('xcrun', ['stapler', 'validate', appPath])
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath])
  const imageStage = '.context/dmg-stage'
  await rm(imageStage, { recursive: true, force: true })
  await mkdir(imageStage, { recursive: true })
  await cp(appPath, `${imageStage}/Stipple Cam.app`, { recursive: true, verbatimSymlinks: true })
  run('ln', ['-s', '/Applications', `${imageStage}/Applications`])
  const dmg = path.resolve(`dist/Stipple-Cam-${process.arch}.dmg`)
  run('hdiutil', ['create', '-volname', 'Stipple Cam', '-srcfolder', imageStage, '-ov', '-format', 'UDZO', dmg])
  run('codesign', ['--timestamp', '--sign', identity, dmg])
  run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', process.env.NOTARYTOOL_PROFILE, '--wait'])
  run('xcrun', ['stapler', 'staple', dmg])
  run('xcrun', ['stapler', 'validate', dmg])
  await rm(zip, { force: true })
  console.log(`Notarized installer: ${dmg}`)
} else console.log('Not notarized. Set NOTARYTOOL_PROFILE to produce an installable release DMG.')
