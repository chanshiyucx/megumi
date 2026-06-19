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

The app loads a single remote `manifest.json` directly in the browser and reads
comic images, thumbnails, and UTF-8 book files from the URLs it contains. Set
`NEXT_PUBLIC_MEGUMI_MANIFEST_URL` at build time to select the catalog.

The remote origin must return an `Access-Control-Allow-Origin` header that
permits the frontend origin. This applies to the manifest and UTF-8 book files;
comic images use the same resolved object-storage base URL.

## Development

```sh
pnpm install
pnpm dev
```

The reader UI starts from `app/page.tsx`, which renders the migrated
`components/app.tsx` client entry.
