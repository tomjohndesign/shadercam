/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@mediapipe/tasks-vision'],
  },
}

export default nextConfig
