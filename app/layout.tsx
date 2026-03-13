import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Electrostatic Stippling",
  description: "Real-time video stippling with hand tracking controls",
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
