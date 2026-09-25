import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "ShaderCam",
  description: "Real-time camera shaders with hand tracking controls",
  metadataBase: new URL("https://shadercam.app"),
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans antialiased">{children}</body>
    </html>
  )
}
