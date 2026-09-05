import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getVpsCommands,
  inspectDependencies,
  inspectProductionBuild,
  parseVpsArgs,
} from "../../scripts/run-vps.mjs";

const fixtures = [];

function createFixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "9router-vps-runner-"));
  fixtures.push(projectRoot);
  mkdirSync(join(projectRoot, ".next", "standalone"), { recursive: true });
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, ".next", "BUILD_ID"), "build-id");
  writeFileSync(join(projectRoot, ".next", "standalone", "server.js"), "server");
  writeFileSync(join(projectRoot, ".next", "standalone", "custom-server.js"), "wrapper");
  writeFileSync(join(projectRoot, "src", "app.js"), "source");
  return projectRoot;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe("VPS runner arguments", () => {
  it("uses the standard VPS port and accepts an explicit override", () => {
    expect(parseVpsArgs([], {})).toMatchObject({ port: 20128, rebuild: false });
    expect(parseVpsArgs(["--port", "32000"], { PORT: "20129" })).toMatchObject({ port: 32000 });
    expect(parseVpsArgs(["--port=32001", "--rebuild"], {})).toEqual({
      port: 32001,
      rebuild: true,
      help: false,
    });
  });

  it("rejects missing, malformed, and out-of-range ports", () => {
    expect(() => parseVpsArgs(["--port"], {})).toThrow("requires a value");
    expect(() => parseVpsArgs(["--port", "abc"], {})).toThrow("Invalid port");
    expect(() => parseVpsArgs(["--port", "65536"], {})).toThrow("Invalid port");
  });
});

describe("VPS production build selection", () => {
  it("builds when production output is missing", () => {
    const projectRoot = createFixture();
    rmSync(join(projectRoot, ".next", "BUILD_ID"));

    expect(inspectProductionBuild({ projectRoot, buildInputs: ["src"] })).toMatchObject({
      needsBuild: true,
      reason: ".next/BUILD_ID is missing",
    });
  });

  it("builds when the hardened standalone wrapper is missing", () => {
    const projectRoot = createFixture();
    rmSync(join(projectRoot, ".next", "standalone", "custom-server.js"));

    expect(inspectProductionBuild({ projectRoot, buildInputs: ["src"] })).toMatchObject({
      needsBuild: true,
      reason: ".next/standalone/custom-server.js is missing",
    });
  });

  it("reuses output newer than its source inputs", () => {
    const projectRoot = createFixture();
    const sourceTime = new Date("2026-01-01T00:00:00Z");
    const buildTime = new Date("2026-01-01T00:01:00Z");
    utimesSync(join(projectRoot, "src", "app.js"), sourceTime, sourceTime);
    utimesSync(join(projectRoot, "src"), sourceTime, sourceTime);
    utimesSync(join(projectRoot, ".next", "BUILD_ID"), buildTime, buildTime);

    expect(inspectProductionBuild({ projectRoot, buildInputs: ["src"] })).toMatchObject({
      needsBuild: false,
    });
  });

  it("rebuilds when an input is newer or rebuilding is forced", () => {
    const projectRoot = createFixture();
    const buildTime = new Date("2026-01-01T00:00:00Z");
    const sourceTime = new Date("2026-01-01T00:01:00Z");
    utimesSync(join(projectRoot, ".next", "BUILD_ID"), buildTime, buildTime);
    utimesSync(join(projectRoot, "src", "app.js"), sourceTime, sourceTime);
    utimesSync(join(projectRoot, "src"), buildTime, buildTime);

    expect(inspectProductionBuild({ projectRoot, buildInputs: ["src"] })).toMatchObject({
      needsBuild: true,
      reason: "src/app.js changed after the last build",
    });
    expect(inspectProductionBuild({ projectRoot, buildInputs: ["src"], rebuild: true })).toMatchObject({
      needsBuild: true,
      reason: "--rebuild requested",
    });
  });
});

describe("VPS dependency selection", () => {
  it("installs missing dependencies", () => {
    const projectRoot = createFixture();

    expect(inspectDependencies({ projectRoot })).toMatchObject({
      needsInstall: true,
      reason: "node_modules is missing or incomplete",
    });
  });

  it("installs only when the project lockfile is newer", () => {
    const projectRoot = createFixture();
    mkdirSync(join(projectRoot, "node_modules", "next"), { recursive: true });
    writeFileSync(join(projectRoot, "node_modules", "next", "package.json"), "{}");
    writeFileSync(join(projectRoot, "node_modules", ".package-lock.json"), "{}");
    writeFileSync(join(projectRoot, "package-lock.json"), "{}");
    const older = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-01-01T00:01:00Z");
    utimesSync(join(projectRoot, "node_modules", ".package-lock.json"), older, older);
    utimesSync(join(projectRoot, "package-lock.json"), newer, newer);

    expect(inspectDependencies({ projectRoot })).toMatchObject({ needsInstall: true });

    utimesSync(join(projectRoot, "node_modules", ".package-lock.json"), newer, newer);
    expect(inspectDependencies({ projectRoot })).toMatchObject({ needsInstall: false });
  });
});

describe("VPS server command", () => {
  it("starts the hardened standalone custom server", () => {
    const commands = getVpsCommands({ projectRoot: "/srv/9router" });

    expect(commands.install.args).toEqual(["ci"]);
    expect(commands.build.args).toEqual(["run", "build"]);
    expect(commands.server.command).toBe(process.execPath);
    expect(commands.server.args).toEqual(["/srv/9router/.next/standalone/custom-server.js"]);
  });
});
