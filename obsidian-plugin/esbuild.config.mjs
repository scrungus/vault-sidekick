import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const config = {
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  platform: "node",
  target: "es2022",
  format: "cjs",
  external: ["obsidian", "electron", "child_process", "fs", "path", "os"],
  sourcemap: "inline",
  logLevel: "info",
};

if (watch) {
  const ctx = await context(config);
  await ctx.watch();
  console.log("watching for changes...");
} else {
  await build(config);
}
