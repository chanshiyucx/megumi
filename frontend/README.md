# Megumi Frontend

Next.js App Router shell for the Eriri reader frontend. The runtime UI modules
from `/Users/xin/Developer/shiyu/eriri/src` are migrated directly into this
project:

- `components/layout` and `components/ui`
- `hooks`
- `store`
- `lib`
- `types`
- `styles`

The app currently keeps Eriri's original `/api/*` frontend boundary. Minimal
empty API routes exist so the copied stores can hydrate without a backend while
the manifest/R2 adapter is implemented separately.

## Development

```sh
pnpm install
pnpm dev
```

The reader UI starts from `app/page.tsx`, which renders the migrated
`components/app.tsx` client entry.
