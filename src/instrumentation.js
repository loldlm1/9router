export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Load through Next's module graph so aliases resolve in standalone builds.
    try {
      const { startBackgroundTokenRefresh, stopBackgroundTokenRefresh } = await import("@/sse/services/backgroundTokenRefresh.js");
      if (startBackgroundTokenRefresh()) {
        process.once("SIGINT", stopBackgroundTokenRefresh);
        process.once("SIGTERM", stopBackgroundTokenRefresh);
      }
    } catch (error) {
      console.error("[BackgroundTokenRefresh] scheduler start failed:", error?.message ?? String(error));
    }
  }
}
