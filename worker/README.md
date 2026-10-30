# Megumi State Worker

Cloudflare Worker for reading and writing Megumi reader state.

It exposes:

- `GET /tags`
- `PATCH /tags`
- `GET /tabs`
- `PATCH /tabs`
- `GET /paragraphs`
- `PATCH /paragraphs`
- `GET /progress`
- `PATCH /progress` (also accepted as `POST`)

`GET /tags` is stored by browsers but revalidated on every request. The Worker
returns an R2-backed `ETag` and responds with `304 Not Modified` when the tags
have not changed, avoiding repeated JSON transfers without serving stale state.

State for comics, books, videos, images, and chapters is stored at
`.megumi/tags.json` in the `MEGUMI_BUCKET` R2 binding. The
file stores only `true` values; missing values mean `false`.

The ordered open-tab IDs are stored at `.megumi/tabs.json`. The active tab is
not persisted remotely. Tab mutations are applied against the latest R2 object
with conditional writes and retries, so concurrent clients do not overwrite
the complete list with a stale snapshot.

Favorited book paragraphs are stored at `.megumi/paragraphs.json`, keyed by a
client-generated id. Each entry keeps the paragraph's normalized text, a short
prefix of its neighbours, its chapter and its last known position, so the
reader can find it again after the book is edited. `PATCH /paragraphs` takes
`add`, `update` and `remove` operations and applies them like tab mutations:
against the latest R2 object, with conditional writes and retries.

Reading progress is stored at `.megumi/progress.json`, keyed by comic and book
id. `PATCH /progress` takes `{ comics?, books? }` maps of entries; each entry is
kept only if its `lastRead` is newer than the stored one, so a device that was
offline cannot pull back a position read further on another device. The
response holds the stored entries for the ids in the patch, not the whole file.
`POST /progress` takes the same body; clients send it as `text/plain` with
`keepalive` when a page is hidden or closed, since that request needs no CORS
preflight.
Each collection keeps at most 20,000 entries, dropping the least recently read.

The default Wrangler environment is production:

- Worker: `megumi-tags`
- R2 bucket: `megumi`

The `dev` Wrangler environment is isolated for local validation:

- Worker: `megumi-tags-dev`
- R2 bucket: `megumi-dev`

Configure `ALLOWED_ORIGINS` in `wrangler.jsonc` before deployment:

```json
"ALLOWED_ORIGINS": "https://your-frontend.example,http://localhost:3000"
```

Deploy:

```sh
pnpm install
pnpm run deploy
```

Run or deploy the isolated dev Worker:

```sh
pnpm dev:dev
pnpm run deploy:dev
```
