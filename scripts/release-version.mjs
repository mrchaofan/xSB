import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Keep the root, workspaces, internal dependency pins and npm lockfile at one release version. */
export function incrementVersion(root, bump = "patch") {
  if (!["patch", "minor", "major"].includes(bump)) throw new Error(`Invalid version increment: ${bump}`);
  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  const manifest = read("package.json");
  const current = manifest.version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(current)) throw new Error(`Expected a stable version: ${current}`);
  const parts = current.split(".").map(Number);
  const index = { major: 0, minor: 1, patch: 2 }[bump];
  parts[index] += 1;
  for (let i = index + 1; i < parts.length; i++) parts[i] = 0;
  const version = parts.join(".");
  const packages = new Map([["", manifest]]);
  for (const entry of fs.readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(root, "packages", entry.name, "package.json"))) {
      const location = `packages/${entry.name}`;
      packages.set(location, read(`${location}/package.json`));
    }
  }
  const names = new Set([...packages.values()].map((pkg) => pkg.name));
  const lock = read("package-lock.json");
  if (lock.lockfileVersion !== 3 || lock.version !== current) throw new Error("Unexpected npm lockfile version");
  // Validate the whole update before writing any file.
  for (const [location, pkg] of packages) {
    const locked = lock.packages[location];
    if (pkg.version !== current || locked?.version !== current) throw new Error(`Version mismatch: ${location || "root"}`);
    pkg.version = version;
    locked.version = version;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (!names.has(name)) continue;
        if (spec !== current || locked[field]?.[name] !== spec) throw new Error(`Internal dependency mismatch: ${pkg.name} -> ${name}`);
        pkg[field][name] = version;
        locked[field][name] = version;
      }
    }
  }
  lock.version = version;
  for (const [location, pkg] of packages) {
    fs.writeFileSync(path.join(root, location, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(root, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(incrementVersion(process.cwd(), process.argv[2]));
}
