/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(process.env.STIPPLE_DESKTOP === '1' ? { output: 'export' } : {}),
  serverExternalPackages: ['@mediapipe/tasks-vision'],
}

export default nextConfig
