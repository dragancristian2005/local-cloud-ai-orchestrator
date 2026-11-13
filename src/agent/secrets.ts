// One definition of "this path is a secret", shared by the file tools (which refuse to read it)
// and the command rules (which refuse a command that names it).

const SECRET_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg"]);
const SECRET_NAMES = [
  /^\.env(\..*)?$/, /\.pem(\.|$)/, /\.key(\.|$)/, /^id_rsa/, /^id_ed25519/,
  /^\.npmrc$/, /^\.netrc$/, /^\.pypirc$/, /^credentials(\.|$)/, /^secrets?\./,
];

/**
 * True when a path, relative to the project, is a secrets file or lies in a folder that holds
 * credentials or git internals. Case is ignored: on macOS ".ENV" opens ".env".
 */
export function isSecretPath(relativePath: string): boolean {
  const parts = relativePath.toLowerCase().split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => SECRET_DIRS.has(part))) return true;
  const base = parts.at(-1) ?? "";
  return SECRET_NAMES.some((pattern) => pattern.test(base));
}
