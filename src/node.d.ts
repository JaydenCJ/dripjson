/**
 * Minimal ambient declarations for the handful of Node.js built-ins the CLI
 * uses. Declaring them in-repo keeps `typescript` the only devDependency
 * (no `@types/node`); the surface below is restricted to exactly what
 * src/cli.ts calls, so a typo against a real Node API still fails to compile.
 * The library itself (everything except cli.ts) uses no Node APIs at all.
 */

declare module "node:fs" {
  /** Overloads limited to how the CLI reads input (path, or stdin as fd 0). */
  export function readFileSync(path: string | number, encoding: "utf8"): string;
}

declare var process: {
  argv: string[];
  exit(code?: number): never;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
};
