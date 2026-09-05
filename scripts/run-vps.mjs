import { existsSync, lstatSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 20128;
const DEFAULT_HOST = "0.0.0.0";
const BUILD_INPUTS = [
  "src",
  "open-sse",
  "public",
  "package.json",
  "package-lock.json",
  "next.config.mjs",
  "jsconfig.json",
  "postcss.config.mjs",
  "custom-server.js",
  "scripts/copy-standalone-assets.mjs",
];

function parsePort(value) {
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`Invalid port "${value}". Use an integer from 1 to 65535.`);
  }

  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid port "${value}". Use an integer from 1 to 65535.`);
  }
  return port;
}

export function parseVpsArgs(args, env = process.env) {
  let portValue = env.PORT || DEFAULT_PORT;
  let rebuild = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--rebuild") {
      rebuild = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--port" || arg === "-p") {
      if (index + 1 >= args.length) throw new Error(`${arg} requires a value.`);
      portValue = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--port=")) {
      portValue = arg.slice("--port=".length);
    } else {
      throw new Error(`Unknown option "${arg}". Run with --help for usage.`);
    }
  }

  return { port: parsePort(portValue), rebuild, help };
}

function newestMtime(path) {
  if (!existsSync(path)) return null;

  const stat = lstatSync(path);
  if (!stat.isDirectory()) return { path, mtimeMs: stat.mtimeMs };

  let newest = { path, mtimeMs: stat.mtimeMs };
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const candidate = newestMtime(resolve(path, entry.name));
    if (candidate && candidate.mtimeMs > newest.mtimeMs) newest = candidate;
  }
  return newest;
}

function envBuildInputs(projectRoot) {
  return [".env", ".env.local", ".env.production", ".env.production.local"]
    .filter((name) => existsSync(resolve(projectRoot, name)));
}

export function inspectProductionBuild({
  projectRoot,
  distDir = process.env.NEXT_DIST_DIR || ".next",
  rebuild = false,
  buildInputs = BUILD_INPUTS,
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required.");
  if (rebuild) return { needsBuild: true, reason: "--rebuild requested" };

  const requiredOutputs = [
    `${distDir}/BUILD_ID`,
    `${distDir}/standalone/server.js`,
    `${distDir}/standalone/custom-server.js`,
  ];
  for (const output of requiredOutputs) {
    if (!existsSync(resolve(projectRoot, output))) {
      return { needsBuild: true, reason: `${output} is missing` };
    }
  }

  const buildIdPath = resolve(projectRoot, distDir, "BUILD_ID");
  const buildMtimeMs = lstatSync(buildIdPath).mtimeMs;
  let newestInput = null;
  for (const input of [...buildInputs, ...envBuildInputs(projectRoot)]) {
    const candidate = newestMtime(resolve(projectRoot, input));
    if (candidate && (!newestInput || candidate.mtimeMs > newestInput.mtimeMs)) {
      newestInput = candidate;
    }
  }

  if (newestInput && newestInput.mtimeMs > buildMtimeMs) {
    return {
      needsBuild: true,
      reason: `${relative(projectRoot, newestInput.path)} changed after the last build`,
    };
  }

  return { needsBuild: false, reason: `${distDir}/BUILD_ID is current` };
}

export function inspectDependencies({ projectRoot }) {
  if (!projectRoot) throw new Error("projectRoot is required.");

  const lockfilePath = resolve(projectRoot, "package-lock.json");
  const installedLockfilePath = resolve(projectRoot, "node_modules", ".package-lock.json");
  const nextPackagePath = resolve(projectRoot, "node_modules", "next", "package.json");
  if (!existsSync(nextPackagePath) || !existsSync(installedLockfilePath)) {
    return { needsInstall: true, reason: "node_modules is missing or incomplete" };
  }
  if (existsSync(lockfilePath) && lstatSync(lockfilePath).mtimeMs > lstatSync(installedLockfilePath).mtimeMs) {
    return { needsInstall: true, reason: "package-lock.json changed after the last install" };
  }
  return { needsInstall: false, reason: "node_modules matches package-lock.json" };
}

export function getVpsCommands({ projectRoot, distDir = ".next" }) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  return {
    install: { command: npmCommand, args: ["ci"] },
    build: { command: npmCommand, args: ["run", "build"] },
    server: {
      command: process.execPath,
      args: [resolve(projectRoot, distDir, "standalone", "custom-server.js")],
    },
  };
}

function run(command, args, { forwardSignals = false, ...options } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    const signalHandlers = new Map();

    if (forwardSignals) {
      for (const signal of ["SIGINT", "SIGTERM"]) {
        const handler = () => {
          if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        };
        signalHandlers.set(signal, handler);
        process.once(signal, handler);
      }
    }

    const cleanup = () => {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolvePromise({ code, signal });
    });
  });
}

function exitCodeFor(result) {
  if (result.code !== null) return result.code;
  if (result.signal === "SIGINT") return 130;
  if (result.signal === "SIGTERM") return 143;
  return 1;
}

async function loadProjectEnv(projectRoot, env) {
  if (env !== process.env) return env;

  const requireFromNext = createRequire(resolve(projectRoot, "node_modules", "next", "package.json"));
  const { loadEnvConfig } = requireFromNext("@next/env");
  if (typeof loadEnvConfig !== "function") throw new Error("Unable to load the project environment.");
  return loadEnvConfig(projectRoot, false).combinedEnv;
}

function printHelp() {
  console.log(`Usage: npm run vps -- [options]

Options:
  -p, --port <port>  Public listen port (default: PORT or ${DEFAULT_PORT})
      --rebuild      Force a production rebuild before starting
  -h, --help         Show this help

Example:
  npm run vps -- --port 20128`);
}

export async function runVps({
  args = process.argv.slice(2),
  env = process.env,
  projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
} = {}) {
  const options = parseVpsArgs(args, env);
  if (options.help) {
    printHelp();
    return 0;
  }

  let commands = getVpsCommands({ projectRoot });
  const dependencies = inspectDependencies({ projectRoot });
  if (dependencies.needsInstall) {
    console.log(`[vps] Installing dependencies because ${dependencies.reason}.`);
    const result = await run(commands.install.command, commands.install.args, { cwd: projectRoot, env });
    const code = exitCodeFor(result);
    if (code !== 0) return code;
  } else {
    console.log(`[vps] Reusing installed dependencies (${dependencies.reason}).`);
  }

  const runtimeEnv = await loadProjectEnv(projectRoot, env);
  const runtimeOptions = parseVpsArgs(args, runtimeEnv);
  const distDir = runtimeEnv.NEXT_DIST_DIR || ".next";
  const productionEnv = { ...runtimeEnv, NODE_ENV: "production" };
  commands = getVpsCommands({ projectRoot, distDir });
  const build = inspectProductionBuild({
    projectRoot,
    distDir,
    rebuild: runtimeOptions.rebuild,
  });

  if (build.needsBuild) {
    console.log(`[vps] Building 9Router because ${build.reason}.`);
    const result = await run(commands.build.command, commands.build.args, { cwd: projectRoot, env: productionEnv });
    const code = exitCodeFor(result);
    if (code !== 0) return code;

    const completedBuild = inspectProductionBuild({
      projectRoot,
      distDir,
    });
    if (completedBuild.needsBuild) {
      throw new Error(`Build completed without a reusable production output: ${completedBuild.reason}.`);
    }
  } else {
    console.log(`[vps] Reusing the current production build (${build.reason}).`);
  }

  const serverEnv = {
    ...productionEnv,
    HOSTNAME: DEFAULT_HOST,
    PORT: String(runtimeOptions.port),
  };
  console.log(`[vps] Starting 9Router on http://${DEFAULT_HOST}:${runtimeOptions.port}`);
  const result = await run(commands.server.command, commands.server.args, {
    cwd: projectRoot,
    env: serverEnv,
    forwardSignals: true,
  });
  return exitCodeFor(result);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runVps()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[vps] ${error.message}`);
      process.exitCode = 1;
    });
}
