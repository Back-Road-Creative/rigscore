# `container` pack — governed-egress devcontainer

An agent sandbox where **the network is the boundary**: the dev container sits on an internal-only
Docker network with no route out, and its only leg to the internet is a proxy that denies by default
and allows just the hosts you list. Install: `rigscore init --pack container` (inert until the pack
framework ships).

- **Fail-closed allow-list** — `FilterDefaultDeny Yes`: an unlisted host is refused, not allowed.
- **A healthcheck that proves both directions** — the part that matters. A proxy whose filter fails
  to parse **fails open** (admits everything), and a happy-path-only healthcheck calls that healthy.
  `healthcheck.sh` also asserts a disallowed host is *refused*, so a fail-open proxy fails `--wait` at
  create time instead of quietly handing the agent the whole internet.
- **No direct route out** — `internal: true` network; only the proxy holds an outbound leg.
- **DNS exfil closed** — `--dns=127.0.0.1`, so DNS can't be a side channel.
- **Hardened proxy** — `cap_drop: ALL`, `read_only`, `no-new-privileges`, `USER nobody`, pinned.

**Vars.** `PROJECT_NAME` prefixes the networks/container/image; `ALLOWED_HOSTS` adds allow-list lines
(extended regex, one per line); `EGRESS_SUBNET` is pinned so the proxy's client ACL can't drift.

**By design:** `--cap-drop=ALL` + `no-new-privileges` mean **`sudo` does not work** in the dev
container — install packages at image-build time. An agent that cannot escalate is the point.

**Deferred**, so this pack does the egress core properly rather than five things half-way:

- **SSH-over-proxy shim** (`socat`) — `ConnectPort 22` is open; only the client-side `ProxyCommand`
  is missing. Use HTTPS remotes meanwhile.
- **Editor settings baking** — opinionated, and orthogonal to egress.
- **Guard-hook suite** — belongs with the sibling `guards` pack.
- **Custom dev-container image** — a stock base keeps the pack readable; swap `image` for `build`.
