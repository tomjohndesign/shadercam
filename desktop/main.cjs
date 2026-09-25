const { app, BrowserWindow, session, systemPreferences, dialog, ipcMain, shell } = require('electron')
const { createServer } = require('node:http')
const { readFile } = require('node:fs/promises')
const path = require('node:path')

let server
let origin
let camera
let cameraError
let lastFrameTime = 0
const root = path.join(__dirname, 'web')
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain' }
const trusted = (url) => {
  try { return new URL(url).origin === origin } catch { return false }
}
const webPreferences = { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, preload: path.join(__dirname, 'preload.cjs') }

function createWindow() {
  const window = new BrowserWindow({ title: 'ShaderCam', width: 1280, height: 800, backgroundColor: '#000000', webPreferences })
  window.loadURL(origin)
}

app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault() })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})

if (!app.requestSingleInstanceLock()) app.quit()
else app.whenReady().then(async () => {
  try { camera = require(path.join(process.resourcesPath, 'shadercam-camera.node')) }
  catch (error) { cameraError = `The camera component could not load: ${error.message}` }
  const status = () => camera ? camera.status() : { state: 'error', message: cameraError, connected: false, framesSent: 0 }
  const authorized = event => trusted(event.senderFrame?.url) && event.senderFrame === event.sender.mainFrame
  const handle = (channel, action) => ipcMain.handle(channel, (event, ...args) => {
    if (!authorized(event)) throw new Error('Untrusted camera request')
    return action(...args)
  })
  handle('camera:status', status)
  handle('camera:activate', () => camera ? camera.activate() : status())
  handle('camera:stop', () => { camera?.stop(); lastFrameTime = 0 })
  handle('camera:frame', pixels => {
    if (!(pixels instanceof Uint8Array) || pixels.byteLength !== 1280 * 720 * 4) throw new Error('Invalid camera frame')
    const now = performance.now()
    if (now - lastFrameTime < 30) return false
    lastFrameTime = now
    return camera?.writeFrame(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength)) || false
  })
  handle('camera:settings', () => shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension'))
  app.on('second-instance', () => { const win = BrowserWindow.getAllWindows()[0]; if (win) { win.restore(); win.focus() } })
  // Serve only bundled static files, on loopback and an OS-assigned port.
  server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return }
      const pathname = decodeURIComponent(new URL(req.url, origin).pathname)
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
      const file = path.resolve(root, relative)
      if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return }
      const data = await readFile(file)
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' })
      res.end(data)
    } catch { res.writeHead(404).end('Not found') }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    permission === 'media' && trusted(requestingOrigin) && trusted(contents?.getURL()))
  session.defaultSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (permission !== 'media' || !trusted(contents.getURL()) || !trusted(details.requestingUrl)) { callback(false); return }
    const types = details.mediaTypes || []
    const granted = await Promise.all(types.map(type => {
      if (type !== 'video' && type !== 'audio') return false
      return process.platform === 'darwin' ? systemPreferences.askForMediaAccess(type === 'video' ? 'camera' : 'microphone') : true
    }))
    callback(types.length > 0 && granted.every(Boolean))
  })
  createWindow()
  camera?.activate()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch(error => { dialog.showErrorBox('ShaderCam could not start', error.message); app.quit() })

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { camera?.stop(); server?.close() })
app.on('web-contents-created', (_, contents) => {
  contents.on('render-process-gone', () => camera?.stop())
  contents.on('destroyed', () => camera?.stop())
})
