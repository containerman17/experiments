To run typscript just type `node ./filaname.ts`. It is 2025

Always use top-level await in TypeScript files instead of wrapping code in async functions with .catch() at the end.

Always use `path.join(import.meta.dirname, ...)` to resolve local files in TypeScript experiments instead of `__dirname`.


## How to re-deploy Hayabusa

To redeploy the Hayabusa router contract (e.g., after adding a new callback function):

1. Remove the existing `ROUTER_CONTRACT` line from `.env`
2. Run `npm run deploy`
3. The new contract address will be automatically saved to `.env`

