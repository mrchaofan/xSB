// Local readiness only describes whether the installed executable runs.
export const CLI_DETAILS = {
  codex: { name: "Codex", vendor: "OpenAI", guide: "https://github.com/openai/codex#installation" },
  claude: { name: "Claude Code", vendor: "Anthropic", guide: "https://code.claude.com/docs/en/setup" },
};

export function backendPresentation(backend, result, error, pending) {
  const state = pending ? pending : error ? "failed" : !backend.installed ? "missing" : result?.state ?? "found";
  const next = !backend.installed ? (backend.cli ? "install" : backend.missing ? "locate" : null)
    : backend.cli ? "check" : null;
  const primary = pending ? null : error ? error.action : next;
  const tone = pending ? "progress" : error || state === "broken" ? "error" : state === "ready" ? "success" : ["missing"].includes(state) ? "attention" : "neutral";
  const label = pending ? pending : error ? `retry.${primary}` : primary === "check" && result ? "recheck" : primary;
  return { state, tone, primary, label, emphasized: !pending && state !== "ready" && !!primary };
}
