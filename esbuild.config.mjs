import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const config = {
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
  packages: "external",
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  const ctx = await context(config);
  await ctx.watch();
  console.log("watching for changes...");
} else {
  await build(config);
}
