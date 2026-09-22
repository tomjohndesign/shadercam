import { build } from "esbuild"
import { mkdir, readFile, writeFile } from "node:fs/promises"

await mkdir("public/stipple", { recursive: true })
await build({
  entryPoints: ["lib/stipple/index.ts"], outfile: "public/stipple/stipple.js",
  bundle: true, format: "esm", platform: "browser", target: "es2020", minify: true,
  legalComments: "eof",
})
// Include the shader source for developers integrating with an existing GPU pipeline.
const source = await readFile("lib/stipple/shaders.ts", "utf8")
for (const match of source.matchAll(/export const (\w+) = `([\s\S]*?)`/g)) {
  await writeFile(`public/stipple/${match[1]}.glsl`, match[2].trim() + "\n")
}
const notices = await Promise.all(["three", "three-stdlib"].map(async name =>
  `${name}\n${await readFile(`node_modules/${name}/LICENSE`, "utf8")}`
))
const bundle = await readFile("public/stipple/stipple.js", "utf8")
await writeFile("public/stipple/stipple.js", bundle + "\n/*\n" + notices.join("\n\n") + "\n*/\n")
console.log("Built standalone stipple module and GLSL sources")
