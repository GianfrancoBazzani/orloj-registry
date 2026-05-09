// Resolver-hook implementation: retry failed relative specifiers with
// `.js` and `/index.js`. Workaround for SDKs that ship extensionless ESM
// imports (e.g. @1claw/sdk).
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (
      err?.code !== "ERR_MODULE_NOT_FOUND" ||
      !/^\.\.?\//.test(specifier) ||
      /\.[a-zA-Z0-9]+$/.test(specifier)
    ) {
      throw err;
    }
    try {
      return await nextResolve(`${specifier}.js`, context);
    } catch {}
    try {
      return await nextResolve(`${specifier}/index.js`, context);
    } catch {}
    throw err;
  }
}
