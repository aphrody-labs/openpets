import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Bun implementation of the Node module-resolution hooks the desktop tests use to stub
 * `electron` and sibling modules. Bun has neither `module.register` nor `module.registerHooks`;
 * runtime plugins are its resolver hook, so the same resolve callbacks run through one.
 */

interface ResolveContext {
  readonly parentURL: string | undefined;
  readonly conditions: readonly string[];
  readonly importAttributes: Readonly<Record<string, string>>;
}

interface ResolveResult {
  readonly url: string;
  readonly shortCircuit?: boolean;
}

type NextResolve = (specifier: string, context?: ResolveContext) => ResolveResult;
type ResolveHook = (specifier: string, context: ResolveContext, nextResolve: NextResolve) => ResolveResult | Promise<ResolveResult>;

interface BunPluginBuilder {
  onResolve(options: { readonly filter: RegExp }, callback: (args: { readonly path: string; readonly importer: string }) => Promise<{ readonly path: string; readonly namespace?: string } | undefined>): void;
  onLoad(options: { readonly filter: RegExp; readonly namespace: string }, callback: (args: { readonly path: string }) => { readonly contents: string; readonly loader: "js" }): void;
}

interface BunRuntime {
  plugin(options: { readonly name: string; setup(build: BunPluginBuilder): void }): void;
}

const dataNamespace = "openpets-data-module";
const fallThrough: ResolveResult = { url: "openpets:fall-through" };

function bun(): BunRuntime {
  const runtime = (globalThis as { Bun?: BunRuntime }).Bun;
  if (!runtime) throw new Error("The desktop module hooks run under Bun only.");
  return runtime;
}

function toParentUrl(importer: string): string | undefined {
  if (!importer) return undefined;
  return /^[a-z][a-z0-9+.-]+:/i.test(importer) && !/^[a-z]:[\\/]/i.test(importer) ? importer : pathToFileURL(importer).href;
}

export interface HookRegistration {
  deregister(): void;
}

export function registerHooks(hooks: { readonly resolve: ResolveHook }): HookRegistration {
  let active = true;
  bun().plugin({
    name: "openpets-desktop-test-hooks",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async ({ path, importer }) => {
        if (!active) return undefined;
        const context: ResolveContext = { parentURL: toParentUrl(importer), conditions: ["node", "import"], importAttributes: {} };
        const result = await hooks.resolve(path, context, () => fallThrough);
        if (result === fallThrough) return undefined;
        if (result.url.startsWith("data:")) return { path: result.url, namespace: dataNamespace };
        if (result.url.startsWith("file:")) return { path: fileURLToPath(result.url) };
        return { path: result.url };
      });
      build.onLoad({ filter: /.*/, namespace: dataNamespace }, ({ path }) => ({
        contents: decodeURIComponent(path.slice(path.indexOf(",") + 1)),
        loader: "js",
      }));
    },
  });
  return { deregister: () => { active = false; } };
}

/** Node's asynchronous loader hook entry: `hookUrl` is a data: module exporting `resolve`. */
export async function register(hookUrl: string, _parentUrl?: string): Promise<void> {
  const hooks = (await import(hookUrl)) as { readonly resolve: ResolveHook };
  registerHooks({ resolve: hooks.resolve });
}
