# Megumi State Worker

Cloudflare Worker for reading and writing Megumi reader state.

It exposes:

- `GET /tags`
- `PATCH /tags`
- `GET /tabs`
- `PATCH /tabs`

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
