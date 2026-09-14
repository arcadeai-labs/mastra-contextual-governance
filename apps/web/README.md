# apps/web — the demo UI

Next.js. Eventually the split screen: a deliberately boring enterprise loan app on the
left, the Arcade control plane on the right (#22). Today it carries the identity
(#82), the control-plane panel (#21), the approval page (#19), and the scaffold's
placeholder home page.

```sh
bun run --cwd apps/web dev               # then open /panel or /approvals/<id>
bun test apps/web
bun run --cwd apps/web build
bun run --cwd apps/web verify:standalone # drives the Docker image, not `next start`
```

The last one needs a Docker daemon and takes about a minute. It is not a nicety:
`next start` resolves imports against a full `node_modules` and the deployed image
resolves them against whatever Next's file tracing carried, and #92 is what lives in
that gap — `POST /api/chat` answered 500 on Render, with `Cannot find module 'ws'`,
after passing the tracer bullet locally and three reviewers. Anything that changes
`apps/web`'s runtime dependencies should be run past it. `-- --image <tag>` drives an
image that already exists instead of building one, which is how you watch it fail.

`PORT` comes from this directory's own `.env.local`, the way it does for the three Bun
services: `dev` and `start` go through `scripts/next.ts`, which is a process Bun runs
directly so the file is loaded before Next starts ([#50](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/50),
fixed in #55). A real environment variable still wins, which is what
`PORT=4420 bun run --cwd apps/web dev` and Render's injected `PORT` rely on.

## Identity — sign in, the gateway token, the verifier route

`DESIGN.md` → **Identity** and **Identity and OAuth**. There are two authentication
hops with two different mechanisms, and this service owns its side of both. Nothing
here is the agent; #14 puts the agent on top.

```
Dana, in her own Chrome profile
  → "Sign in as Dana"        GET /api/auth/signin?persona=dana
      OIDC code + PKCE against apps/idp as client C, prompt=login
    → cg-idp's login page, cg-idp's consent page
  → GET /api/auth/callback   code → token → /oauth2/userinfo → email
      sealed cookie { email }
  → hop 1                    GET /api/arcade/start
      401 on the gateway → resource metadata → authorization-server metadata
      → dynamic client registration → PKCE authorize → Arcade's consent screen
  → GET /api/arcade/callback sealed cookie { email, gateway access + refresh }
  ─── later, on the persona's FIRST tool authorization ───
  → hop 2                    GET /api/arcade/verify?flow_id=…
      email from the sealed session, never from the request
      → POST cloud.arcade.dev/api/v1/oauth/confirm_user   (server-side)
      → fetch next_uri                                     (server-side)
      → send the browser on
```

Five route handlers, and they are the whole of it:

| route | what it does |
|---|---|
| `GET /api/auth/signin` | starts sign-in at cg-idp as client C, `prompt=login` |
| `GET /api/auth/callback` | makes the session; completes a parked verification if there is one |
| `GET /api/arcade/start` | begins the gateway authorization for the signed-in persona |
| `GET /api/arcade/callback` | stores the gateway access + refresh token on the session |
| `GET /api/arcade/verify` | Arcade's custom user verifier |
| `POST /api/auth/signout` | forgets the persona and the gateway token together |

Each `app/api/**/route.ts` is a wrapper around a plain `(Request) => Promise<Response>`
in `lib/identity/handlers.ts`. That is what lets `test/identity-flow.test.ts` mount the
same functions behind a real `Bun.serve` and drive them with a cookie jar over real
HTTP, against a real `apps/idp` subprocess — so the suite asserts on the `Set-Cookie`
headers a browser would actually receive rather than on a mock's arguments.

### One sealed cookie, one persona per browser

No fourth database. The persona's email and the gateway access + refresh token live in
one cookie, **AES-256-GCM under `SESSION_SECRET`**, `HttpOnly; Secure; SameSite=Lax`,
chunked across `cg_session.0`, `cg_session.1`, … when it exceeds what a browser will
hold. Two JWTs and an email exceed 4KB comfortably, so chunking is the normal case; a
browser handed an oversized `Set-Cookie` drops it in silence, and the symptom is a
sign-in that appears to work and then forgets.

Encrypted rather than merely signed, because the value is a bearer token for the whole
gateway and a signed-but-readable cookie would put it in the persona's own DevTools.
There is no development fallback key, and a weak one is refused as firmly as an
absent one: `SESSION_SECRET` must be **at least 32 characters with at least 8 distinct
ones**, or `/health` reports all three capabilities `missing` and every identity route
answers `503` naming the minimum. 32 because the derived key is 256 bits and SHA-256
does not add entropy — a shorter secret is the part an attacker has to guess; the
distinct-character floor because length alone is satisfiable by padding.

That is not hypothetical tidiness. Round 1 of #84's review set `SESSION_SECRET=x`,
and the built service reached `Ready`, `/health` said `configured` three times, and
every sign-in worked — under a key anybody could guess, protecting two bearer tokens.
A refusal that fires only on an *absent* value misses the case a human produces.
`lib/identity/seal.ts::sessionSecretProblem` is the single definition, used by the
key derivation, by `/health` and by every route, so the three cannot disagree.

One persona per browser is a design, not a limitation — on stage each persona runs in
its own Chrome profile. Spike #75 named the trap: a verifier that reads a
browser-keyed session while four personas share one browser binds every tool call to
whoever signed in last.

### Switching persona forces a fresh login, and that is measured

`prompt=login` rides on **every** sign-in, not only on a detected switch: a switch that
has to be detected is a switch that can be missed, and being wrong costs every tool
call for the rest of the demo being made as the wrong person while the screen says
otherwise.

Measured against a real `apps/idp`, two sign-ins in one browser:

```
                              with prompt=login          without
after "Sign in as Dana"   dana.okafor@bank.example   dana.okafor@bank.example
after "Sign in as Sam"    sam.reyes@bank.example     dana.okafor@bank.example
pages shown by the switch                        2                          0
```

Without it the second authorization continues off the IdP session the first one left
behind, renders nothing, and the browser comes back as Dana.
`test/identity-flow.test.ts` pins both halves.

### The verifier never reads identity from the request

Arcade sends a verifier **exactly one** parameter, `flow_id` — measured on #75 by
recording the whole query string rather than reading the field we expected. So the
email comes from this browser's sealed session and from nowhere else, and a request
carrying `user_id`, `email`, `sub` or `login_hint` is refused with `400` rather than
quietly served. Ignoring them would be correct too; refusing them is testable from
outside.

Two measured facts shape the rest of it:

- **`confirm_user` is called server-side with `ARCADE_API_KEY`, in-flow.** Run by hand
  it is unreliable: Arcade accepts it only while the flow is still awaiting
  verification, and that window is shorter than a human's turnaround — the same call
  succeeded once at ~8 minutes and returned a bare `{"code":400,"msg":"Bad request"}`
  the next time, for a flow Arcade still recognised.
- **`next_uri` is fetched server-side.** Arcade does not finalise the grant until
  something lands there. A verifier that returns the 303 and trusts the browser to
  follow it is correct for a browser and wrong for everything else.

A `confirm_user` non-2xx or a `user_mismatch` renders a page carrying Arcade's own
words and says plainly that nothing was authorized. Nothing fails quietly.

**No session is the expected case**, on every fresh Chrome profile. The flow id is
parked in a sealed, ten-minute cookie, the browser is sent to sign in, and the same two
calls run from the sign-in callback. A parked flow that expires renders a page saying
so and what to do — it is never dropped in silence.

### The identity seam a forker replaces

One seam, and it is named so that "replace it with your own auth" is a specific
instruction rather than a gesture.

| | |
|---|---|
| **the seam** | `lib/identity/session.ts` — `readSession(request)` and `readSessionFromCookies(jar)` |
| **what it returns** | `Session { email, gateway?, signed_in_at }`, or `null` |
| **who calls it** | every route handler and every server component that needs to know who is acting: `lib/agent/handlers.ts`, `lib/agent/tool-list.ts`, `app/chat/page.tsx`, `app/page.tsx`, `lib/identity/verifier.ts` |
| **what a forker keeps** | the two functions, their signatures, and `email` being the join key |
| **what a forker deletes** | `apps/idp`, `lib/identity/oidc.ts`, `lib/identity/personas.ts`, `lib/identity/roster.ts`, `components/identity/SignInPanel.tsx` |

Point `readSession` at your own session store — Okta, Auth0, a NextAuth cookie,
an enterprise header a trusted proxy sets — and return a `Session` whose `email`
is the address your directory knows the person by. Everything downstream is
unchanged, because nothing downstream reads an identity from anywhere else.

**Nothing else may resolve identity, and that is checkable rather than polite.**
There is no branch in `lib/agent/handlers.ts` or `lib/identity/verifier.ts` that
reads a persona from a body, a query string or a header — the verifier refuses a
request carrying one with `400`. `lib/identity/roster.ts` runs only in the
label direction, email → name and role, and deliberately offers no
`emailFor(persona)`: a caller holding one would be one refactor away from
signing somebody in as a persona the *browser* named.

The `gateway` field is the one thing a forker has to think about rather than
swap. It holds this persona's Arcade gateway token, which is how the tool call
reaches Arcade as that person; a real IdP replaces how the session is
established, not hop 1. `lib/identity/handlers.ts::liveGatewayToken` stays.

`/approvals/{id}` carries a second, narrower "acting as" cookie
(`lib/persona.ts`) that predates this and is not a sign-in — it chooses which
roster member presses a button on that page, which is what makes the
self-approval refusal demonstrable. It never touches the agent's persona.

### Configuration, and what `/health` says

```
curl -s localhost:3000/health
{"status":"ok","service":"web","signin":"configured","gateway":"configured","verifier":"configured","agent":"configured","panel_stream":"fixture"}
```

Five fields rather than one flag, because they fail independently and the person reading
this is trying to find out which step is outstanding. They arrived from three slices:
`signin`, `gateway` and `verifier` with #82; `agent` with #14 — a cg-web with no
`ANTHROPIC_API_KEY` signs Dana in, holds a gateway token, answers the verifier, and then
`/chat` answers 503 the first time somebody presses Send; and `panel_stream` with #81.

`panel_stream` is the odd one out and has three values, not two: `live`, `fixture` or
`unconfigured`. A replay somebody asked for is a mode, not a fault — the panel says
`FIXTURE REPLAY` on screen — while `unconfigured` means the panel is watching nothing.
See [Which stream it watches](#which-stream-it-watches) and #81. The other four say
`configured` or `missing`, and never which value is wrong, because the value is a
credential in most cases.

**`status` is `degraded` whenever any capability is `missing` or the panel is
`unconfigured`, and the response is still HTTP 200.** Round 2 of #84's review ran a
cg-web with sign-in configured and `ARCADE_GATEWAY_ID` absent and got `{"status":"ok", … "gateway":"missing"}` — the
field anybody actually reads, describing a deployment that could not make a tool call
as fine. The status line stays 200 on purpose: Render treats a non-200 on
`healthCheckPath` as a dead instance and abandons the deploy, and an instance that
never comes up is an instance whose `/health` nobody can read. CI asks the same
question with `curl -fsS` and keeps passing.

The home page carries the same news for whoever is not curling anything: a red
`role="alert"` banner above the persona buttons, listing the same sentences the 503
pages render, and the persona buttons go inert while sign-in itself is unconfigured.
Inert rather than hidden — hiding them would leave a visitor wondering whether this
demo has personas at all. `test/configuration-banner.test.tsx` pins the banner, the
disabled buttons, and the fully-configured case where neither appears.

| variable | what it is |
|---|---|
| `IDP_ISSUER` | `apps/idp`'s public origin, **as a URL** — not the HOST-form the cross-service keys use |
| `IDP_CLIENT_ID` / `IDP_CLIENT_SECRET` | client C, this service's own registration at the IdP |
| `SESSION_SECRET` | seals the session cookie. No fallback, and ≥32 characters / ≥8 distinct is enforced. `openssl rand -hex 32` |
| `PUBLIC_URL` | this service's own origin, with the scheme. Every `redirect_uri` is built from it |
| `ARCADE_GATEWAY_ID` | `cg-demo-us`, the User Source gateway hop 1 authorizes against |
| `ARCADE_API_KEY` | the project key `confirm_user` is authenticated with |
| `IDP_SCOPES` | defaults to `openid email`. `email` is the join key, so it is not optional |
| `ARCADE_CLOUD_URL` | defaults to `https://cloud.arcade.dev`, which is **not** `ARCADE_API_URL`. A test seam |
| `ARCADE_MCP_CLIENT_ID` | optional, and blank is correct. Pins the gateway's MCP client id instead of registering one per process |
| `ANTHROPIC_API_KEY` | the agent's model key (#14). No default; `/chat` refuses without it |
| `MODEL_ID` | defaults to `claude-sonnet-5`. Set on `cg-web` explicitly so the blueprint is the whole list |
| `ARCADE_LOAN_TOOLKIT` | `Loan`. Here it is the **allow-list** deciding which gateway tools the agent is handed |

Every one of them is in `.env.example` and is a `sync: false` entry on `cg-web` in
`render.yaml`. The ones with no default a human sets; `IDP_SCOPES`, `ARCADE_CLOUD_URL`,
`ARCADE_MCP_CLIENT_ID` and `MODEL_ID` have working defaults — the first three should be
left blank, and `MODEL_ID` is pinned in the blueprint so the list is complete rather
than most of it.

Two steps are not environment variables on this service:

- **Client C must exist on cg-idp**, with `${PUBLIC_URL}/api/auth/callback` allowlisted:
  `IDP_OAUTH_CLIENTS=web` and `IDP_OAUTH_REDIRECT_URIS_WEB=…` there, then
  `bun run --cwd apps/idp oauth-client --client web --rotate`, which prints the secret
  exactly once (#70).
- **Arcade dashboard → Auth → Settings → Custom verifier route** must be
  `${PUBLIC_URL}/api/arcade/verify`. Without it Arcade uses its own verifier, which
  demands an Arcade account that is a project member — our personas are not, the grant
  binds to whoever is signed in at `account.arcade.dev`, and the tool re-challenges
  forever with nothing on the panel to say why (`DESIGN.md` open risk 4). Check it
  through the admin API, not the dashboard label.

### Running the identity locally

Two terminals, plus whatever port this worktree owns. `apps/idp` needs its own install
(`bun install --cwd apps/idp`) — see `DESIGN.md`.

```sh
# Terminal 1 — the identity provider, with client C
PORT=8083 IDP_PUBLIC_URL=http://localhost:8083 \
  IDP_OAUTH_CLIENTS=web \
  IDP_OAUTH_REDIRECT_URIS_WEB=http://localhost:3000/api/auth/callback \
  bun apps/idp/src/index.ts

# then, in the same environment, mint client C's secret (printed once)
IDP_PUBLIC_URL=http://localhost:8083 IDP_OAUTH_CLIENTS=web \
  IDP_OAUTH_REDIRECT_URIS_WEB=http://localhost:3000/api/auth/callback \
  bun run --cwd apps/idp oauth-client --client web --rotate

# Terminal 2 — the web app
PORT=3000 PUBLIC_URL=http://localhost:3000 \
  IDP_ISSUER=http://localhost:8083 \
  IDP_CLIENT_ID=<from above> IDP_CLIENT_SECRET=<from above> \
  SESSION_SECRET=$(openssl rand -hex 32) \
  bun run --cwd apps/web dev
```

Open `/`, press a persona, sign in with the fixture password from
`apps/idp/src/fixtures/people.json`. `/health` reports `signin: configured`; hop 1 and
the verifier need `ARCADE_GATEWAY_ID` and a real `ARCADE_API_KEY` and are exercised
locally by `test/identity-flow.test.ts` against a stand-in.

## The control-plane panel

`/panel` renders it full-screen. `<ControlPlanePanel>` is the component #22 drops into
the right half; it renders no `<html>` or `<body>` of its own.

Three lanes — Access, Pre, Post — fed by a `text/event-stream` of `GovernanceEvent`s
(#5). Green allow, red deny with the rule that fired, amber modify with a before/after
diff. Newest at the top of each lane, so the freshest card never moves.

**`/access` is called on `tools/list` for every tool in the gateway and again on each
call, so access rows outnumber pre rows by design.** That is the hook doing its job, not
a leak.

### Repeated access decisions share a row

Arcade calls `/access` once per tool-schema resolution, so one `tools/call` fans out
into several decisions about the same person and the same tool. Measured at the #13
sitting with retry off: one `Loan.GetLoan` produced **three** access rows and one
`Loan.ApproveLoan` produced **two** (#64).

The Access lane collapses **adjacent** decisions that share `user_id`, `tool` and
`decision` and land within `ACCESS_GROUP_WINDOW_MS` (three seconds,
`lib/governance/grouping.ts`) into one card carrying their count; the individual event
ids are on the card behind a disclosure. Three limits, all deliberate:

- **Presentation only.** Nothing is deduplicated in `audit_log` or in the stream, the
  timeline still holds every event, and both tallies still count every one of them. A
  card saying *3 decisions* is a claim that three were made.
- **Only adjacent decisions group.** Reaching past an intervening event to merge two
  matching ones would reorder the lane, and not reordering is the timeline's first
  property. A fan-out that arrives interleaved with something else stays several rows.
- **A row spans at most the window, measured from its newest member.** Chaining
  neighbour to neighbour would let a slow drip of matching decisions collapse into one
  row claiming they arrived together.

`/panel?fanout=1` replays the measured shape through the fixture stream, so the two
rows and their counts are something to look at rather than read about.

### Which stream it watches

Read in the **server** component and passed down as a prop. Never a `NEXT_PUBLIC_`
variable — `.env.example` explains why at length: `next build` inlines those into the
client bundle while Render supplies service variables at runtime, so one would be
`undefined` in the deployed browser and perfectly fine under `next dev`.

One knob, `GOVERNANCE_STREAM`, and three states:

| `GOVERNANCE_STREAM` | Stream | Badge on screen |
|---|---|---|
| `hooks` | `http(s)://$HOOKS_PUBLIC_HOST/events` | `LIVE · cg-hooks.onrender.com` |
| `fixture` | `/api/governance/fixture-stream` — this app, replaying #5's fixture sequence | `FIXTURE REPLAY` |
| unset, under `next dev` | the same replay | `FIXTURE REPLAY` |
| unset, **deployed** | nothing. `/panel` is an error state naming the variable | `NO STREAM` |

Anything else is refused by name rather than resolved to something, because a typo on
a Render service page would otherwise be a panel quietly showing the demo.

**The replay is the development default deliberately.** `apps/hooks` *does* serve
`/events` — the stream half of #20 landed on #54 — but it is a second service with a
database of its own, and most of the time a fresh clone does not have it running.
Defaulting to it would open the panel on a connection retrying against nothing, which
reads as a broken app rather than as a control plane nobody started. Opting in is two
variables:

```sh
GOVERNANCE_STREAM=hooks HOOKS_PUBLIC_HOST=localhost:4411 bun run --cwd apps/web dev
```

**That reasoning does not survive a deploy, which is #81.** A deployed panel is in
front of an audience and has a control plane to watch, so an unset variable there is
not a convenience — it is the panel answering "is this real?" with a replay. It did
exactly that: `render.yaml` never declared `GOVERNANCE_STREAM` for `cg-web` between #21
and #81, so every production deploy was in fixture replay by construction, and on
2026-09-11 a human made a real governed `Loan_GetLoan` against the live gateway and
watched the panel play #5's demo sequence instead. Nothing on the page said so.

So, deployed (`NODE_ENV=production`, or Render's `RENDER=true`):

- an unset `GOVERNANCE_STREAM`, or `hooks` with no `HOOKS_PUBLIC_HOST`, renders an
  error state in place of the lanes — naming the variable, opening no socket, and
  replaying nothing. A warning *above* a running replay would still be a running
  replay, and the rows are the lie.
- `GET /health` reports `"panel_stream"` as `live`, `fixture` or `unconfigured`, and
  answers `"status":"degraded"` on the last — beside the three identity capabilities
  #82 added, for the same reason and in the same shape.
- the replay is still available when it is asked for: `GOVERNANCE_STREAM=fixture`, or
  `/panel?fixture=1` for a single request. It says `FIXTURE REPLAY` on screen either way.

Both modes carry a badge, always. `LIVE` names the host, because "live" on its own is a
word a fixture could print and the host is the part somebody at the back of the room can
check. A rehearsal must not mistake a replay for the live control plane, and the answer
belongs on the projector rather than in the presenter's narration.

### Watching it absorb a burst

A whole-project `/access` decides 10,844 tools in one call, so "handles a burst" is not
hypothetical. In fixture mode the page's own query string tunes the replay:

```
/panel?repeat=2000&delayMs=0     # 10,000 events, as fast as the socket carries them
/panel?delayMs=300               # the four acts, faster than the default 900ms pacing
/panel?fanout=1                  # the acts, then the measured /access fan-out (#64)
```

Lanes are bounded **separately** — one shared window would let an `/access` sweep evict
the `/pre` denial act 2 turns on — and every event past a lane's window is counted in
that lane's header rather than discarded. An audit surface that quietly drops records
argues against the thing this project argues for.

### What it will not show you

Two limits, both deliberate.

**A removed value is never rendered.** `before` is replaced by a mask built from the
value's type and nothing else — not truncated, not partially shown, not hashed. The
panel is the one surface guaranteed to be on a projector; act 3's whole point is that a
bank account number did not reach the model, and printing it here would be worse than
having no diff. `after` *is* shown, because that is what the model received.

The mask says `text withheld` on a hatched field rather than drawing a row of dots. A
design review found the dots read, at projector distance, as a value in a masked font
rather than as the absence of one — and the phrasing leaks strictly less, since the dots
were length-proportional and these are not. `maskedDiff()` has an `annotation` slot
ready for `redactions[]` chips; #8 has landed the `RedactionRecord` type but
`GovernanceEvent` does not carry an array of them yet, so nothing populates it.

**A layer-2 refusal never reaches this panel, and an empty lane is not proof that
nothing was tried.** Arcade evaluates a tool's auth requirements *before* `/pre`, so a
persona without a token for a tool is refused upstream of every hook: no `/pre` event,
no audit row, nothing on screen (measured, spike #2; `DESIGN.md` open risk 2). Every
decision the access, pre and post hooks made is on the panel. That is not the same as
every refusal the persona met, and no beat that needs to be *seen* should be staged as
an auth failure.

This caveat used to be a paragraph in the panel's bottom-left corner. Design review cut
it, fairly: nobody at the back of a room reads a footnote, and the space it took
belonged to the lanes. It is true, it matters, and it belongs in the runbook rather than
on the projector.

### Correlation

`lib/governance/correlation.ts`, one `correlate()` over two keys — the swappable seam
the issue asks for. Denials carry the token `apps/hooks` embeds in the `error_message`
it owns (`[ref evt_…]`, #6); allows carry `execution_id` on the payload. It fails soft
in every direction: a message with no parseable token is an *uncorrelated* event,
rendered in its lane without a join, never dropped. The prefix Arcade puts ahead of our
text is theirs and undocumented, and a panel that went blank because Arcade edited a
string would be a bad thing to discover on stage.

### Why not `EventSource`

It cannot set a request header, so it cannot resume with `Last-Event-ID`, and its
reconnect timing is the browser's rather than ours — on stage that is an outage of
unpredictable length in the middle of an act. `fetch` over a `ReadableStream` gives both
back, and makes the whole path testable against a real server instead of a stub.

`lib/governance/subscribe.ts` is the only file that knows the wire contract, and
`apps/hooks/src/events.ts` is the only file that writes it — #54 implemented that shape
rather than negotiating a new one, so the two halves have never had to be reconciled.

## Fonts

GT Cinetype and GT Cinetype Mono are Arcade's licensed faces and are **not committed** —
this is a template anyone can fork. The stack names them first, because they are
installed on the machine that presents this, and falls back to the brand kit's own
documented websafe fallback everywhere else.

## `/approvals/{id}` — the approval page

The page the Slack DM links to. It is built on **one** read, `GET /approvals/{id}` on
`apps/hooks`, because the link carries an opaque id and nothing else: no token, no
signature, no query string. That response carries everything the page shows — who asked,
what for, how much, which rule was tripped, why, who it was routed to, and who was
sufficient and deliberately not asked.

**Opening the page is not permission.** The requester can read the DM she sent, so she can
open the link too, and the read answers her exactly as it answers the approver. Whether the
person looking may *decide* is settled when a button is pressed.

### Pressing a button is a governed tool call

Approve and Deny both call `Approvals.Decide` **through Arcade, as the clicking user**, so
the press passes `/access`, the auth requirements, `/pre` and `/post` like any other tool
call. There is deliberately no second path: `apps/web` never writes to `governance.db`, never
calls the approvals store to record a decision, and has no branch that records one when
Arcade refuses. A privileged path that made the demo work would also make it false.

Three outcomes, and they stay three:

| | what it means | what the page shows |
|---|---|---|
| recorded | the tool ran | the decision, and the details above update |
| refused | `/pre` said no | `CHECK_FAILED`, the hook's own message verbatim, and "the request is unchanged" |
| failed | Arcade unreachable, misconfigured, unexpected | "no control has spoken" |

Collapsing a failure into a refusal would make an outage look like a control firing. That is
the comfortable direction to get it wrong, and it is still wrong.

The refusal is styled as a deliberate screen rather than an error page, because it is a beat:
Dana clicking her own link sees the same `CHECK_FAILED` her agent saw, and there is an audit
row for it against her identity.

### Acting as

`lib/persona.ts` is the persona switcher, standing in for real login exactly as `DESIGN.md`
says: each persona is a real Arcade account with a real email, and the switcher chooses which
of them the tool call is made under. It defaults to the routed approver, so the link works
straight from Slack, and ignores a cookie naming somebody the control plane has never heard
of. It is not a permission — choosing the requester and pressing Approve is the beat, not a
hole.

### Configuration

`lib/config.ts` is the only place this service reads its environment, and
`APPROVALS_STORE_TOKEN` is the one variable it will not invent. Unset outside
production it takes the same development fallback `apps/hooks` takes, so a clean
checkout runs with no configuration at all; unset **under
`NODE_ENV=production` it throws**, with the same wording the control plane uses:

```
APPROVALS_STORE_TOKEN is required in production
```

That fallback is written out in the source, so a production service using it
would be authenticating to the approvals store with a value anyone can read —
and doing it quietly, because the fallback works locally. `test/config.test.ts`
pins both halves of the guard on both sides, and CI hands the token to the
`build web image` smoke the same way it hands it to `build hooks image`.

`/health` deliberately does not read *this* variable — it reports the identity
capabilities and the panel's stream, never the approvals token — so it answers
`200` either way; the guard fires on the first request that needs the token,
which is any view of an approval.

## The agent — `/chat`, and the denial it is built to show

`POST /api/chat` runs one turn of a Mastra agent on Claude Sonnet 5 at temperature 0,
in a Next.js route handler. `GET /chat` is the bare page that drives it. Both arrived
with #14, the tracer bullet: the first end-to-end path through every layer.

    this browser's session  →  gateway token (#82)  →  MCPClient, static bearer
      →  api.arcade.dev/mcp/cg-demo-us  →  /access, /pre  →  tools/loan
        →  apps/loan-app

**"Acting as Dana" means signed in as Dana in this browser.** There is no branch in
`lib/agent/handlers.ts` that reads an identity from the body, the query string or a
header — the persona comes from the sealed session and the gateway resolves the bearer
that came out of it. An actor a request can name is an actor the model can forge
(`DESIGN.md` rule 1), and act 4 is the model trying.

### The system prompt says nothing about being denied

This is the load-bearing decision and it is easy to undo by accident. `lib/agent/agent.ts`
tells the model what it could not know — that it is working in a bank's loan book and
that its tools write to a system of record — and nothing about authority, escalation,
approvals or retrying. `DESIGN.md` → Determinism: **the hook writes the remediation
instruction, not the system prompt.** A prompt that also wrote it would make the demo
pass while proving nothing.

Measured, on the wire, by `test/tracer-bullet.test.ts`:

```
Tool execution was denied by an extension policy: DENIED: approving LN-2291 for 95000
exceeds your approval authority of 50000. To proceed, call Approvals.RequestApproval
with action=approve_loan, resource_id=LN-2291, amount=95000 and justification=<…>,
then wait for the approval and retry Loan.ApproveLoan with loan_id=LN-2291 and
amount=95000 unchanged. [ref evt_tkgv4b30gj]
```

Everything after Arcade's prefix is `pre.approve-within-clearance`'s own `reason`,
rendered with the call's values, with the audit row's id appended (#6). It reaches the
model's next prompt intact — the suite reads that off the conversation the model was
handed, not off the stream the page renders.

### Eight tools come back, six reach the model

A live `tools/list` for a signed-in persona returns **eight** entries: the project's six
plus the gateway's own `System_ManageAuthorization` and `Arcade_ListApps`. The agent is
given the ones whose wire names start with `Loan_` and `Approvals_` and nothing else —
an allow-list keyed on `ARCADE_LOAN_TOOLKIT`, not a deny-list on those two names, so a
built-in Arcade adds tomorrow does not appear in front of the model either. Handing a
model that has just been refused the tool whose job is acquiring authorization is not a
thing to do by omission.

A toolkit name that matches nothing selects nothing, and `/chat` answers 502 naming the
variable. An agent with no tools still answers — fluently, from memory, about a loan
book it never read — and that is the worst output this demo could produce.

### Two spellings of one tool name

MCP says `Loan_GetLoan`. A hook frame says `Loan.GetLoan`. Both are real, neither is
invented here, and `scripts/gateway-stand-in.ts::qualifiedToolName` is the only place
that converts between them. There is no third form.

### Layer 2 is a link, not a refusal

A persona's first governed call can come back with an `authorization_url` and
`llm_instructions` instead of a result: Arcade evaluates tool auth requirements *before*
`/pre`. It arrives in the same `isError: true` envelope a hook denial does, so the two
are told apart by reading the text (`lib/agent/authorization.ts`). The page renders it as
a clickable step and stops.

**No hook fires and no audit row is written** — `DESIGN.md` open risk 2, which
`tracer-bullet.test.ts` now measures rather than restates. Reported as a denial it would
put a refusal on screen that no rule produced, and somebody would go looking for the rule.
Dana and Sam hold live `cg-idp` grants so a rehearsal will not reach this path, which is
exactly why it has a test: the first person it breaks for is a forker on their first run.

### What the route refuses before a token is spent

| | |
|---|---|
| the environment is not configured | `503`, naming the variables |
| nobody is signed in | `401`, pointing at `/api/auth/signin` |
| signed in, hop 1 never run | `401`, pointing at `/api/arcade/start` |
| the gateway will not take this browser's bearer | a stream carrying one `authorization` event |
| the gateway could not be reached | `502`, as plumbing |
| the gateway listed nothing at all | `502`, naming the control plane |
| the toolkit name matched nothing | `502`, naming `ARCADE_LOAN_TOOLKIT` |

The last four are one symptom — an agent with no tools — with four causes, and
each split was paid for.

The bottom two are told apart on a measured fact: a live `tools/list` always
carries the gateway's own two built-ins, even when policy hides every project
tool. **Zero** entries is the list failing to come back, and saying "check
`ARCADE_LOAN_TOOLKIT`" about a control plane that is down sends somebody a long
way in the wrong direction.

### A rejected gateway token, and why it is asked about first (#94)

`@mastra/mcp` 1.17.3 does **not** throw when the gateway refuses the bearer.
`listToolsets()` resolves, with `{}`, because the connection failure is logged
per server and dropped — so a dead token and a mistyped `ARCADE_LOAN_TOOLKIT`
arrive as the same value. Live on 2026-09-14 that produced *"The gateway
advertised 0 tools and none of them belong to \"Loan\" or \"Approvals\" … Check
ARCADE_LOAN_TOOLKIT and ARCADE_APPROVALS_TOOLKIT"* while both variables were
correct and the whole fix was one click on `/api/arcade/start`.

So the bearer is asked about before the toolset is read: one raw JSON-RPC
`initialize` with the token on it (`probeGatewayToken`). `401` or `403` is the
gateway refusing the credential, `2xx` is acceptance, anything else is
unreachable and says nothing about the credential.

`MCPClient.getServerAuthState()` was the cheaper candidate and was measured
rather than assumed. It is right when the 401 surfaces as the SDK's
`UnauthorizedError` — a stub answering `401` leaves it `'needs-auth'` — and
`undefined` whenever the streamable POST fails some other way and the client
falls back to SSE, which is the shape the live cg-web log shows
(*"Could not connect to server with any available HTTP transport"*). Both
measurements are in `test/gateway-token-rejected.test.tsx`. An HTTP status is
the gateway's own word about the credential and it is the same in both shapes.

On a rejection the turn answers **200 with an ndjson stream** carrying one
`authorization` event pointing at `/api/arcade/start` and a `done` — a stream
rather than a status because the answer has to carry a clickable link, and
`authorization` rather than `denied` because hop 1 is upstream of every hook, so
nothing was refused and no audit row exists. The dead bearer is dropped from the
sealed session and the sign-in is kept, so the sign-in panel then reads
**`Gateway token: rejected`** rather than `none` and offers the one link that
fixes it. The token is never in the event, the cookie, or the log.

`liveGatewayToken` fails the same way: a refresh that answers non-2xx, or 2xx
with no `access_token` on it, returns `{ token: null, reason }` and logs the
status alone. It never hands back the bearer it already had — a stale token is
accepted by the type system, presented to the gateway, refused there, and read
on screen as a missing toolkit.

The persona tool list on `/` and `/chat` (#15) draws the same distinction for
the same reason: an empty list asks about the bearer before it names `/access`.

### The stream

NDJSON, one object per line, seven kinds: `text`, `tool-call`, `tool-result`, `denied`,
`authorization`, `error`, `done`. Not the AI SDK's UI message stream — three of these are
not text, and a plain text stream would flatten a hook denial, a tool call and an
authorization link into prose the page would have to parse as English. `lib/agent/events.ts`
is the whole vocabulary and both sides import it.

The denial's remediation text is rendered verbatim, `[ref evt_…]` token included. #21's
panel joins on that token; a UI that tidied it away would make the two screens describe
different events.

### Running it

Against the deployed system, signed in as a persona, at `${PUBLIC_URL}/chat`. That needs
Arcade, so it is the live-acceptance path rather than something a laptop can do.

Locally, the whole governed chain runs under `bun test`:

```sh
bun test --cwd apps/web test/tracer-bullet.test.ts
```

That boots the real `apps/hooks`, the real `apps/loan-app` and the repo's own dev IdP as
subprocesses on OS-assigned ports, puts `scripts/gateway-stand-in.ts` where Arcade would
be, and drives `POST /api/chat` over real HTTP with a cookie jar. Every denial you see is
the actual rule refusing the actual call, and every approval is a row in a real
`loans.db`.

**Which model ran matters, and the suite says so on the first line:**

```
[tracer-bullet] model: SCRIPTED (ANTHROPIC_API_KEY is not set)
[tracer-bullet] model: LIVE claude-sonnet-5 at temperature 0
```

`bun test` sets `NODE_ENV=test`, and **Bun does not load `.env.local` under that**, so a key
sitting in `apps/web/.env.local` will not reach the suite and it will quietly report
`SCRIPTED`. Pass it on the command line:

```sh
ANTHROPIC_API_KEY=… bun test --cwd apps/web test/tracer-bullet.test.ts
```

With no key the scripted model plays the tool calls and everything on both sides of it is
real — the call reaches `/pre` as the right persona, the hook's message crosses into the
model's prompt, a denied write leaves `loans.db` untouched. What it cannot prove is that
Claude, handed that text, says the right thing and stops. Export `ANTHROPIC_API_KEY` and
the same tests run against the real model and do prove it. **A green run that says
`SCRIPTED` has not measured the three criteria that are claims about the model.**

`scripts/gateway-stand-in.ts` is runnable on its own and prints a bearer per persona,
which is enough to drive `tools/call` by hand with curl:

```sh
ARCADE_API_URL=http://localhost:4405 HOOKS_PUBLIC_HOST=localhost:4401 \
  LOAN_APP_PUBLIC_HOST=localhost:4402 PERSONA_DANA_EMAIL=dana.okafor@bank.example \
  bun run --cwd apps/web gateway-stand-in
```

It binds the port in `ARCADE_API_URL` and **never** `PORT` — `PORT` in
`apps/web/.env.local` belongs to the web app, and reading it made the stand-in announce
`:4400` and answer on it, which is where `next dev` wants to be. That is #56's bug and
this is #56's fix, the same one `apps/loan-app/scripts/dev-idp.ts` uses. Leave
`ARCADE_API_URL` off and it binds `:0` and tells you what it got. It is not enough to drive `/chat` from a browser offline: that needs a gateway token in a
sealed session, which means hop 1's authorization server, and the only stand-in for that
lives in `test/identity-harness.ts`. Folding the two stand-ins together so the chat runs
offline end to end is worth doing and is filed as #87, not done here.

## Act 1 — the tool an analyst cannot see

`/chat` shows who is signed in, with the role and authority `DESIGN.md`'s cast gives
them, and the tools the **gateway** answered `tools/list` with for that person's bearer.

```
Sam Reyes  sam.reyes@…            Dana Okafor  dana.okafor@…
Credit Analyst · $0                Loan Officer · $50,000

Loan_SearchLoans                   Loan_SearchLoans
Loan_GetLoan                       Loan_GetLoan
Loan_DenyLoan                      Loan_ApproveLoan
                                   Loan_DenyLoan
```

`Loan_ApproveLoan` is **absent** from Sam's list. Not greyed out, not struck through,
not rendered with a padlock — absent, because `access.analysts-cannot-see-approve`
removed it from the deny map before the gateway answered. Ask Sam's agent to approve the
$95K loan and it explains it has no such capability, and **no denied tool call appears in
the audit log**, because no call was attempted. That negative is the easy one to skip and
it is the one worth checking: a `/pre` denial as Sam would mean the access hook did not
do its job and something else produced that event.

### The list is the gateway's, and the page says so

`lib/agent/tool-list.ts` makes one real `tools/list` over MCP with the signed-in
persona's gateway token — the same call `lib/agent/handlers.ts` makes to build the
agent's toolset. There is no catalogue in `apps/web` and no client-side filter on tool
names. A UI that filtered a full catalogue would render exactly the same three rows while
proving the opposite thing, so the page prints where the list came from.

`components/identity/PersonaToolList.tsx` holds no tool names at all, which is the
structural half of the same guarantee: there is no version of that component that could
show Sam a crossed-out approval tool.

The two gateway built-ins are dropped by the same allow-list the agent uses, and they are
**named on screen** — "2 further entries were advertised by the gateway and are not the
agent's to call". Eight became six is an arithmetic nobody should take on trust.

### The authority figure is the seeded one, and says so

`PERSONAS` in `lib/identity/personas.ts` carries each persona's `roleKey` and `clearance`,
the same values `apps/hooks` seeds `governance.db` with. They are copied rather than
imported — `apps/web` does not depend on `apps/hooks` in the package graph and should not
start to — and `test/persona-roster.test.ts` reads the other service's fixture and fails
if the two disagree.

What that cannot catch is a clearance a presenter raises live on stage, which
`DESIGN.md` explicitly allows. So the card labels the number *as seeded in the policy*,
and the audit row on the panel is what says what the control plane actually decided.

The addresses are never in this repo: `PERSONA_DANA_EMAIL`, `PERSONA_SAM_EMAIL`,
`PERSONA_RILEY_EMAIL`, `PERSONA_MORGAN_EMAIL`. An address none of them names renders with
the email and no role — the card says the deployment names nobody there rather than
borrowing a label.

### A list that did not come back is not an empty list

Measured while building this, and it is the sort of thing that would have shipped:
`MCPClient.listToolsets()` does **not** throw when the gateway answers a JSON-RPC error.
It logs and returns `{}`. So a control plane whose `/access` cannot be reached — which
makes the gateway hide everything and say so — arrived looking exactly like a persona the
policy permits nothing.

Those are opposite facts and only one of them is about governance. A live answer always
carries the gateway's own two built-ins, even when policy hides every project tool, so
zero advertised entries is reported as the list failing to come back — by the page, and
by `/api/chat` as a 502 that names the control plane rather than sending somebody to check
a toolkit variable.

### Running it

```sh
bun test --cwd apps/web test/act1-tool-list.test.ts
```

Real `apps/hooks` with the real rule compiled, a real `POST /access` per `tools/list`, the
real audit log read over `GET /audit`. The gateway's transport is the stand-in, and the
model is scripted unless `ANTHROPIC_API_KEY` is set — the suite prints which, exactly as
the tracer bullet does. **A green run that says `SCRIPTED` has not measured the sentence
the agent says**; everything else in that file — the absence, the access rows, the rule
id, the zero `/pre` denials — is mechanical and is measured either way.

## Driving the two beats locally

Three terminals. No Arcade account, no network, no secrets to set: `apps/hooks`
and the stand-in both fall back to the same development bearers outside
production.

Pick your own ports — every service reads `PORT` and this worktree owns a block
of ten. The ports below are examples; substitute yours.

**Terminal 1 — the control plane.** Owns `governance.db`, serves the hooks and
the four `/approvals` endpoints.

```sh
PORT=4401 GOVERNANCE_DB_PATH=/tmp/cg/governance.db bun apps/hooks/src/index.ts
```

**Terminal 2 — the Arcade stand-in.** Prints the port it bound. It is a
development fixture, and it says so on every boot.

```sh
PORT=4402 HOOKS_PUBLIC_HOST=localhost:4401 bun run --cwd apps/web arcade-stand-in
```

Leave `PORT` off and it binds `:0` and tells you what it got.

**Terminal 3 — the web app**, pointed at the stand-in. `ARCADE_API_KEY` must be
non-empty; the stand-in ignores the value.

```sh
PORT=4400 HOOKS_PUBLIC_HOST=localhost:4401 \
  ARCADE_API_URL=http://localhost:4402 ARCADE_API_KEY=offline \
  bun run --cwd apps/web dev
```

Now create the escalation act 2 produces — normally `tools/approvals` writes
this after the pre-hook refuses Dana, and here you write it directly:

```sh
curl -s -X POST http://localhost:4401/approvals \
  -H "authorization: Bearer cg-approvals-store-dev-token-not-for-production" \
  -H 'content-type: application/json' \
  -d '{"requester_id":"dana.okafor@bank.example","action":"approve_loan",
       "resource_id":"LN-2291","amount":95000,
       "justification":"Eleven years in business, 742 credit score.",
       "approver_id":"riley.chen@bank.example",
       "candidate_approver_ids":["riley.chen@bank.example","morgan.ellis@bank.example"],
       "required_clearance":95000}'
```

It answers with the record; take the `id` and open
`http://localhost:4400/approvals/<id>`.

**Beat one — Riley approves.** The page opens acting as Riley Chen, the routed
approver. Press **Approve**. You get *Decision recorded*, the status chip turns
`approved`, and `governance.db` now holds a grant — `active`, single use,
pinned to `LN-2291`, ceiling 95,000.

**Beat two — Dana is refused.** Create a second request with the same curl.
On its page, switch **Act as** to *Dana Okafor* and press **Approve**. You get
the `CHECK_FAILED` screen carrying the pre-hook's own words —
*"Dana Okafor raised this approval request, and separation of duties means the
person who asks cannot also be the person who approves"* — plus the `[ref evt_…]`
token that joins it to the audit row. The request stays `pending`.

That refusal is the actual policy in `governance.db` refusing, reached through
the actual `/pre`. The stand-in cannot answer at all without asking first: see
`scripts/arcade-stand-in.ts`, which the test suite imports rather than
duplicating, so what you see here and what `bun test` pins are one
implementation.

To watch the decisions land:

```sh
sqlite3 /tmp/cg/governance.db \
  "SELECT hook, user_id, tool, decision, rule_id FROM audit_log ORDER BY seq DESC LIMIT 5;"
sqlite3 /tmp/cg/governance.db "SELECT id, status, authorizes, uses_remaining FROM grants;"
```

### Unverified

`lib/arcade.ts` has never spoken to `api.arcade.dev`: #13 registers the gateway and the
provider. The tests drive the real pre-hook through a stand-in that calls it the way the
engine does and runs the tool only on `OK`, so the refusals under test are produced by the
actual policy — but the live round trip is not evidence this slice can offer.
