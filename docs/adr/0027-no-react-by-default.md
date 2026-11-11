# No React by default

> Since [ADR 0036](0036-go-hub-runtime.md) the TypeScript UI is bundled by esbuild and served by the Go Hub; it still uses no framework.

CloakHub will start with Bun-served TypeScript/JSX and small client-side modules rather than React. React may be introduced later if necessary UI complexity justifies it, but v1 should keep the frontend stack simple because the interface is compact and operational.
