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
 * Only generation is used, and the price list it is billed by (read only, to
 * estimate what a generation cost). arkcli can also rewrite the configuration
 * of the agents on a machine; that is never run from here. `ALLOWED` is the
 * whole list of what is.
 *
 *   ARKCLI   the program, when it is not `arkcli` on PATH
 */
import { spawn } from "node:child_process";

const ALLOWED = ["+gen", "gen get", "gen delete", "api arkruntime.get_content_generation_task"];

/**
 * Said after every failure arkcli reports. Its messages advise whoever owns the account (sign in, choose a model,
 * deploy an endpoint, which is billed): that is the user, and an agent that read them alone might do it for them.
 */
const THEIRS = "\nWhatever arkcli advises above is for the user to do: the account, its profile and its models are theirs. Report this to the user, and do not run arkcli yourself.";

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
      reject(e.code === "ENOENT" ? new Error(`"${command}" is not installed or not on PATH. Generating needs Volcengine's CLI, which is the user's to set up: do not install it or sign in yourself. Tell the user to install @volcengine/ark-cli and run \`arkcli auth login\`, and generate nothing until they have.`) : e),
    );
  });
  // The command without what it was given to generate from: a prompt in front of every error would bury the reason.
  const what = `arkcli ${args[0] === "+gen" ? "+gen" : args.slice(0, 3).join(" ")}`;
  let answer: any;
  try {
    // The answer is one JSON object: all of stdout, or on failure the end of stderr, after what arkcli said it was
    // doing. It starts at the last line that opens an object at the margin (what is inside one is indented).
    const said = out.trim() ? out : err;
    const start = [...said.matchAll(/^\{/gm)].at(-1)?.index;
    if (start === undefined) throw new Error("no JSON object");
    answer = JSON.parse(said.slice(start));
  } catch {
    throw new Error(`${what} ${code === 0 ? "printed no JSON" : `failed (exit ${code})`}: ${(err || out).trim().slice(-600)}${code === 0 ? "" : THEIRS}`);
  }
  // The CLI reports a failure in its answer, and not always in its exit code.
  if (answer?.ok === false || code !== 0) {
    const { message, hint } = answer?.error ?? {};
    throw new Error(`${what}: ${message ?? (err.trim().slice(-600) || `exit ${code}`)}${hint ? ` (${hint})` : ""}${THEIRS}`);
  }
  return answer;
}
