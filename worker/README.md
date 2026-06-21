# Megumi Tags Worker

Cloudflare Worker for reading and writing Megumi star/delete state.

It exposes:

- `GET /tags`
- `PATCH /tags`

State is stored at `.megumi/tags.json` in the `MEGUMI_BUCKET` R2 binding. The
file stores only `true` values; missing values mean `false`.

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
pnpm deploy
```

Run or deploy the isolated dev Worker:

```sh
pnpm dev:dev
pnpm deploy:dev
```
