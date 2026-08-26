import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Crash-safe write for the client's 0600 state files (the credentials file
 * and the policy snapshot). One implementation on purpose: a durability or
 * safety fix that landed in only one of the two would leave the other
 * torn-write- or leak-prone.
 *
 * Same-directory temp file plus rename: a crash mid-write must never leave a
 * half-written file, and a cross-device temp dir would make rename fail. The
 * mkdtemp stage is unique per write, so concurrent writers (the gateway plus
 * any CLI invocation share the default state paths) can never interleave on
 * one temp and rename a spliced body into place. Mode 600 is set BEFORE the
 * temp holds content, chmod is the umask belt, and the stage dir is removed
 * on every path so failures cannot accumulate debris. The directory itself
 * is created on demand: an owner-configured path must not need a manual
 * mkdir before the plugin can honor it.
 */
export async function writeFileAtomically(filePath, content) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const stage = await mkdtemp(path.join(directory, ".ai-passport-"));
  const temp = path.join(stage, path.basename(filePath));
  try {
    await writeFile(temp, content, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, filePath);
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}
