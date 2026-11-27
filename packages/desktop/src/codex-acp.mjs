import { codexQuestionConfig } from "@xsb/hub/codex-config";

// The desktop launcher obtains Ark's key just before starting this process. Merge the
// provider here so user-supplied CODEX_CONFIG values never get written into a launcher.
const provider = process.env.XSB_ARK_CODEX_CONFIG;
if (provider) {
  process.env.CODEX_CONFIG = codexQuestionConfig(process.env.CODEX_CONFIG, JSON.parse(provider));
  delete process.env.XSB_ARK_CODEX_CONFIG;
}
await import("@agentclientprotocol/codex-acp");
