export const CODEX_CLIENT_VERSION = "0.153.0";
export const CODEX_ORIGINATOR = "codex_cli_rs";
export const CODEX_USER_AGENT = `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION}`;
export const CODEX_ASTRA_MODEL_ID = "gpt-6-astra";

export function isCodexAstraModel(modelId) {
  if (typeof modelId !== "string") return false;
  return modelId === CODEX_ASTRA_MODEL_ID
    || modelId.startsWith(`${CODEX_ASTRA_MODEL_ID}-`)
    || modelId.startsWith(`${CODEX_ASTRA_MODEL_ID}(`);
}
