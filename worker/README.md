# Megumi Tags Worker

Cloudflare Worker for reading and writing Megumi star/delete state.

It exposes:

- `GET /tags`
- `PATCH /tags`

State is stored at `.megumi/tags.json` in the `MEGUMI_BUCKET` R2 binding. The
file stores only `true` values; missing values mean `false`.

Configure `ALLOWED_ORIGINS` in `wrangler.jsonc` before deployment:

```json
"ALLOWED_ORIGINS": "https://your-frontend.example,http://localhost:3000"
```

Deploy:

```sh
pnpm install
pnpm deploy
```
