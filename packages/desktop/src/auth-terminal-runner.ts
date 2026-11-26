/** Runs only inside the interactive login terminal. stdio belongs to the user, not the Hub/model. */
import fs from "node:fs";
import spawn from "cross-spawn";
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const child = spawn(config.command, config.args, { cwd: config.cwd, env: config.env, stdio: "inherit" });
let settled = false;
let killTimer: NodeJS.Timeout | undefined;
const finish = (exitCode: number | null) => {
  if (settled) return; settled = true;
  clearInterval(poll); if (killTimer) clearTimeout(killTimer);
  try { fs.writeFileSync(config.result + ".tmp", JSON.stringify({ exitCode }), { mode: 0o600 }); fs.renameSync(config.result + ".tmp", config.result); } catch {}
  process.exitCode = exitCode ?? 1;
};
const poll = setInterval(() => {
  if (!killTimer && fs.existsSync(config.cancel)) { child.kill(); killTimer = setTimeout(() => child.kill("SIGKILL"), 3000); }
}, 150);
child.once("error", () => finish(null));
child.once("exit", code => finish(code));

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => { child.kill(); killTimer ??= setTimeout(() => { child.kill("SIGKILL"); finish(null); }, 3000); });
