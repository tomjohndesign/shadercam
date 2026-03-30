import type { Config } from "tailwindcss"

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["system-ui", "-apple-system", "SF Pro Display", "sans-serif"],
        mono: ["ui-monospace", "SF Mono", "Courier New", "monospace"],
      },
    },
  },
  plugins: [],
}
export default config
