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

The app loads the remote schema v3 `manifest.json` directly in the browser.
Comic and book summaries are available immediately; comic page metadata and
book chapter metadata are fetched from `manifests/<resource-path>.json` when
opened. Images, thumbnails, and UTF-8 book files are then read from their
resolved object-storage URLs. Set `NEXT_PUBLIC_MEGUMI_MANIFEST_URL` at build
time to select the catalog.

Star/delete state is read and written through the tags Worker. Set
`NEXT_PUBLIC_MEGUMI_TAGS_API_URL` to the Worker origin, for example
`https://megumi-tags.<account>.workers.dev`. The Worker stores state in
`.megumi/tags.json` in R2.

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
