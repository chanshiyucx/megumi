# Megumi

Standalone build tools for a static remote reader.

## Backend Build

The backend scans a resource root whose immediate child directories are
libraries, generates thumbnails in that same resource root, and writes
`manifest.json`.

The project is only the tool implementation. Your actual resource directory can
live elsewhere, for example `/Users/xin/Downloads/eriri`.

Copy `build.sh` and `sync.sh` into the resource directory, then run them there:

```sh
cd /Users/xin/Downloads/eriri
./build.sh
```

Optional URL prefix:

```sh
./build.sh --public-base-url https://cdn.example.com
```

Output layout:

```text
resource-root/
  manifest.json
  thumbnail/<matching-resource-directories>/<original-name>.webp
  .megumi/state.json
  <your libraries and resources>
```

The manifest uses resource-root-relative object keys and never stores absolute
local source paths. `.megumi/` is local build state and is excluded by `sync.sh`.

## Sync

Configure your R2 remote in `rclone`, then run from the resource directory:

```sh
MEGUMI_R2_REMOTE=cf-r2:gallery ./sync.sh
```

Useful environment variables:

- `MEGUMI_PROJECT_DIR`: project directory, defaults to `/Users/xin/Developer/shiyu/megumi`
- `MEGUMI_R2_REMOTE`: rclone remote, defaults to `cf-r2:gallery`
- `MEGUMI_RCLONE_LOG`: sync log file, defaults to `$HOME/megumi-r2-sync.log`

## Frontend Reader

The frontend is a standalone Next.js App Router app under `frontend/`. It hosts
the migrated Eriri reader UI and loads the generated manifest and resources
directly from remote object storage in the browser.

```sh
cd frontend
pnpm install
pnpm dev
```

Set `NEXT_PUBLIC_MEGUMI_MANIFEST_URL` to the public manifest URL. The object
storage origin must allow cross-origin `GET` requests from the deployed frontend
origin. For Vercel, use `frontend/` as the project root and `pnpm build` as the
build command.
