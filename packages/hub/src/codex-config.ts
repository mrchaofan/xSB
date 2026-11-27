/** Per-process configuration for codex-acp. Credentials stay in the provider's environment. */
export function codexQuestionConfig(raw: string | undefined, provider?: {
  model: string; model_provider: string; model_providers: Record<string, unknown>;
}): string {
  let config;
  try { config = JSON.parse(raw || "{}"); }
  catch { throw new Error("CODEX_CONFIG must contain a JSON object"); }
  const object = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!object(config)) throw new Error("CODEX_CONFIG must contain a JSON object");
  if (config.features !== undefined && !object(config.features)) throw new Error("CODEX_CONFIG.features must be an object");
  if (provider && config.model_providers !== undefined && !object(config.model_providers)) throw new Error("CODEX_CONFIG.model_providers must be an object");
  // codex-acp expands dotted feature overrides after nested values. Do not send
  // contradictory settings, including stale endpoint overrides for a selected Ark plan.
  delete config["features.default_mode_request_user_input"];
  if (provider) {
    const selected = `model_providers.${provider.model_provider}`;
    for (const key of Object.keys(config)) if (key === selected || key.startsWith(selected + ".")) delete config[key];
  }
  return JSON.stringify({
    ...config,
    ...(provider && { ...provider, model_providers: { ...config.model_providers, ...provider.model_providers } }),
    features: { ...config.features, default_mode_request_user_input: true },
  });
}
