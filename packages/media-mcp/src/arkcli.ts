/**
 * Volcengine Ark, reached the one way this system reaches it: through the
 * official CLI, `arkcli` (@volcengine/ark-cli).
 *
 * arkcli is the user's, like the agents' own programs: they install it, sign
 * in (`arkcli auth login`) and choose the profile it works with (`arkcli
 * profile use`). Nothing of that is known, set or passed from here: no key,
 * no profile, no endpoint address, no model. A command is run as it is, and when the
 * account cannot serve it, arkcli's own words are the error.
 *
 * Only generation is used. arkcli can also rewrite the configuration of the
 * agents on a machine; that is never run from here. `ALLOWED` is the whole
 * list of what is.
 *
 *   ARKCLI   the program, when it is not `arkcli` on PATH
 */
import { spawn } from "node:child_process";

const ALLOWED = ["+gen", "gen get", "gen delete"];

/** Run one arkcli command and answer what it printed, parsed. A failure is thrown in the CLI's own words. */
export async function arkcli(args: string[], options: { signal?: AbortSignal } = {}): Promise<any> {
  if (!ALLOWED.some((allowed) => args.join(" ").startsWith(`${allowed} `))) throw new Error(`arkcli ${args[0]} is not a generation command; only these are run: ${ALLOWED.join(", ")}`);
  const command = process.env.ARKCLI || "arkcli";
  const proc = spawn(command, [...args, "--format", "json"], { signal: options.signal, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  proc.stdout.on("data", (chunk) => (out += chunk));
  proc.stderr.on("data", (chunk) => (err += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    proc.on("close", resolve);
    proc.on("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "ENOENT" ? new Error(`"${command}" is not installed or not on PATH. Generating needs Volcengine's CLI: install it yourself and sign in with \`arkcli auth login\`.`) : e),
    );
  });
  const what = `arkcli ${args.slice(0, 2).join(" ")}`;
  let answer: any;
  try {
    // Some commands say what they are doing before they answer.
    // On failure the answer is on stderr.
    const said = out.trim() ? out : err;
    answer = JSON.parse(said.slice(said.search(/^[{[]/m)));
  } catch {
    throw new Error(`${what} ${code === 0 ? "printed no JSON" : `failed (exit ${code})`}: ${(err || out).trim().slice(-600)}`);
  }
  // The CLI reports a failure in its answer, and not always in its exit code.
  if (answer?.ok === false || code !== 0) {
    const { message, hint } = answer?.error ?? {};
    throw new Error(`${what}: ${message ?? (err.trim().slice(-600) || `exit ${code}`)}${hint ? ` (${hint})` : ""}`);
  }
  return answer;
}
