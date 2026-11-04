# objy

One CLI for your Objy clusters. Deploy locally, with Docker, onto existing VMs, or to Hetzner using Terraform.

```sh
npm ci
node bin/objy.js
```

Requires Node.js 22+. This is an early implementation; the npm package is not published yet. Once installed, the command is `objy`.

## Browser UI

```sh
node bin/objy.js ui
# Once installed: objy ui
```

Opens a small local dashboard with guided deployment, topology, logs and cluster controls. It shares the CLI's state and credentials. Use `--port 7341` to change the port or `--no-open` to skip opening the browser. The UI listens only on this computer; keep the command running while using it.

## Deploy

```sh
objy deploy
```

Choose a destination, a size, and the connection details. The wizard asks only for missing information.

```sh
objy deploy docker --name dev --size tiny
objy deploy local --name laptop --size small
objy deploy hetzner --name production --size medium
objy deploy vm --name private-cluster --size small
```

| Size | Nodes | Shards × copies | Memory per node |
| --- | ---: | ---: | ---: |
| Tiny | 1 | 1 × 1 | 2 GiB |
| Small | 3 | 1 × 3 | 2 GiB |
| Medium | 6 | 2 × 3 | 4 GiB |
| Large | 12 | 4 × 3 | 8 GiB |

Use `--size custom --shards 2 --replicas 2 --memory 4096` for a custom cluster. Memory is the database heap allocation, not total machine RAM.

For local and Docker deployments, choose **Provision storage automatically** or **Use existing S3 storage**. Automatic storage creates the bucket and credentials: MinIO for Docker, or open-source SeaweedFS for local Node.js. SeaweedFS uses [Apache 2.0](https://github.com/seaweedfs/seaweedfs/blob/4.52/LICENSE), which permits production use. Its runtime downloads on demand with a pinned checksum; Docker is not required. Data persists across restarts.

For scripts, use `--storage auto` (the default locally) or `--storage external-s3 --s3-endpoint <url> --s3-region <region> --s3-bucket <bucket>`, with your S3 credentials in the environment.

## Manage

```sh
objy list
objy status production
objy stop production
objy start production
objy restart production
objy logs production --follow
objy resume production
```

`deploy` creates and starts a cluster. `start` reuses its saved configuration. `stop` retains infrastructure, object storage and data; cloud resources remain billable. `resume` continues interrupted setup or a lifecycle operation.

## What needs installing?

| Destination | Requirements |
| --- | --- |
| Local | Node.js and npm. Caddy only for HTTPS. Storage can be provisioned automatically or use an existing S3 bucket. |
| Docker | Docker Engine and Compose. Local object storage is included. |
| VMs | Linux machines with SSH, Node.js 22+, npm, tar, systemd and passwordless sudo; reachable S3 storage. |
| Hetzner | Terraform 1.7+, a local Terraform checkout, cloud API token and object-storage credentials. |

```sh
objy doctor docker
objy doctor hetzner
export OBJY_TERRAFORM_DIRECTORY=/path/to/objydb-terraform
```

Terraform remains external. Missing tools produce an installation link before deployment starts. The local checkout must contain `installer/hetzner`; each deployment saves its own module snapshot and state. HTTPS on Hetzner requires a domain, with TLS on the load balancer. The wizard explains the DNS step.

## Server releases

The CLI does **not** contain or depend on `@objy/server` or the Objy database library. It downloads a pinned release, verifies its SHA-256, and caches it separately. Local server dependencies are installed inside that cache. Docker currently builds an image from the verified release; VMs receive the release over SSH.

The initial default matches the Terraform presets: commit `eb221e0`. Updating the CLI does not update existing deployments. An advanced `--release-manifest file.json` option accepts a pinned source archive:

```json
{
  "version": "my-release",
  "url": "https://example.com/server-source.tar.gz",
  "sha256": "<64-character-sha256>",
  "entrypoint": "src/index.js",
  "nodeMajor": 22
}
```

The archive must contain one root directory with `src/index.js`, `package.json` and `package-lock.json`. Server dependencies must support installation without npm lifecycle scripts.

## Scripts and state

For unattended deployment, provide `--yes`, the target, name, size and required settings. Credentials can come from `OBJY_ADMIN_PASSWORD`, `HCLOUD_TOKEN`, `OBJY_S3_ACCESS_KEY` and `OBJY_S3_SECRET_KEY`. Hetzner also accepts the Terraform storage variables `TF_VAR_s3_access_key` and `TF_VAR_s3_secret_key`.

```sh
# Supply OBJY_ADMIN_PASSWORD through your environment first.
objy deploy docker --name dev --size tiny --yes --json
objy status dev --json
```

`--config deployment.json` provides wizard fields for scripting, including VM connections (`vm0Host`, `vm0User`, `vm0Port`, `vm0Auth`, `vm0Key`, repeated per node). Command flags override the file. Keep credentials in environment variables or a private file.

State, credentials, keys and downloaded releases live under `~/.objy`, with private filesystem permissions. Use `OBJY_HOME` or `--home` to choose another directory. Credentials are stored locally, not encrypted. Existing installer deployments are not imported automatically.

Automatic local storage listens on loopback and keeps its data inside the deployment's `runtime/storage` directory. `stop` leaves storage available; `start` also brings it back after a reboot. Downloaded storage runtimes are cached separately. Local storage supports macOS/Linux on x64 and ARM64, and Windows on x64.

SSH host keys are pinned on first connection. A changed key is rejected.

## Development

```sh
npm run check
npm test
# Optional: creates temporary Docker + local clusters and verifies data survives restart.
npm run test:smoke
```

The terminal and browser UI use the same exported `createManager()` API. The UI is one HTML file served by Node.js, with no additional dependencies. Database server code is downloaded separately.

Cloud and VM operations need live qualification before production use. Resizing, upgrades, deletion, importing existing deployments and migrating the server's current `objy` command are outside this first increment.
