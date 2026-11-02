import { build } from "esbuild";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
await mkdir("dist/web", { recursive: true });
if (existsSync("apps/web/main.tsx"))
  await build({
    entryPoints: ["apps/web/main.tsx"],
    outfile: "dist/web/app.js",
    bundle: true,
    minify: true,
    sourcemap: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
for (const file of ["index.html", "style.css"])
  if (existsSync(`apps/web/${file}`))
    await copyFile(`apps/web/${file}`, `dist/web/${file}`);
// Third-party DSH browser plugins use a lazy CJS factory, not an ESM script.
if (existsSync("packages/dsh-cloud-plugin/client.tsx")) {
  await mkdir("dist/plugin", { recursive: true });
  const result = await build({
    entryPoints: ["packages/dsh-cloud-plugin/client.tsx"],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "browser",
    external: ["react", "react/jsx-runtime"],
    target: "es2022",
    minify: true,
  });
  await writeFile(
    "dist/plugin/client.js",
    `window.__ModuleLoader__.load({id:"dsh-cloud-plugin",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});\n`,
  );
  await build({
    entryPoints: ["packages/dsh-cloud-plugin/index.ts"],
    outfile: "dist/plugin/host.js",
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["@deepseek-ai/*", "zod"],
    target: "node24",
  });
  for (const file of ["package.json", "cordis.patch.yml"])
    await copyFile(`packages/dsh-cloud-plugin/${file}`, `dist/plugin/${file}`);
}
