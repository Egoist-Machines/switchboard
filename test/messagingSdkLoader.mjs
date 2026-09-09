// Release smoke resolves only the two public optional SDK entry points to an
// explicitly supplied checkout. Production resolution never uses this loader.
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  const entry = {
    "@egoistmachines/passport-messaging": "src/index.js",
    "@egoistmachines/passport-messaging/cli": "src/cli.js",
  }[specifier];
  if (entry && process.env.PASSPORT_MESSAGING_SDK_SOURCE) {
    return nextResolve(pathToFileURL(resolvePath(process.env.PASSPORT_MESSAGING_SDK_SOURCE, entry)).href, context);
  }
  return nextResolve(specifier, context);
}
