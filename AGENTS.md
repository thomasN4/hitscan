# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## Project

Browser FPS demo: Three.js + Vite, TypeScript throughout `src/`, no framework. All game code lives in `src/`; markup/CSS in `index.html`. Intra-`src/` imports are extensionless (`from './core/state'`) — that is what let files rename to `.ts` one at a time without touching importers (Vite only maps a `'./x.js'` specifier onto `x.ts` when the *importer* is TS).

The canonical remote is a self-hosted Gitea instance on the LAN:
`http://192.168.2.161:3000/thomasN4/another-cs-clone` (`origin`). GitHub is no
longer the source of truth — `gh` is the wrong tool here; use `tea`.

**Every repository-scoped `tea` command here needs
`--repo thomasN4/another-cs-clone`** — `tea pr`, `tea comments`, `tea issues`,
`tea actions`. Auto-detection cannot supply it: `origin`'s SSH port (2222) does
not match the login's `ssh_host` (`192.168.2.161:3000`), so it fails even from
inside a worktree, with `remote repository required: specify id via --repo`. The
flag is scoped to those commands and not global — `tea logins add` rejects it
outright with `flag provided but not defined: -repo`.

**Commands acting on an existing issue or PR additionally need its index**, as a
positional argument: `tea pr edit <index>`, `tea comments add <index>`. Omitting
it fails separately, with `must specify at least one pull request index` and
`please specify issue / pr index` respectively. `tea pr create` takes no index —
it is what mints one.

Both failures are loud on the terminal and *silent about the workflow*, which is
the part that catches you: an arming command that errors changes no title, fires
no `edited` event, and leaves step 6 waiting on a run that was never created.

There are **two** configured `tea` logins, and which one a command runs under is
a deliberate choice, not a default:

- **`gitea-lan`** — the user (`thomasN4`), who owns the repo. Everything that
  reads, and everything the user does by hand. It is the fallback login, so an
  unflagged `tea` command runs as the user.
- **`code-bot`** — a dedicated collaborator account with write permission. This
  is the identity the planner acts under in **Review Loop** below: its pushes,
  its PR, its `WIP: ` toggles and its comments. Reach it with
  `--login code-bot`; nothing selects it implicitly.

**`code-bot` is a collaborator, and one thing Review Loop needs is gated on
being the repo's owner instead.** `tea actions variables list`, which step 5
depends on, answers a `code-bot` token with HTTP 403 and
`user should be the owner of the repo`. That is not a permission level to be
raised past: the account was tested at both `write` and `admin` and got the same
403, while the owner's token succeeds holding no admin scope at all
(`write:issue,write:repository,read:user`). Ownership is the gate, no
collaborator role clears it, so that lookup stays on `gitea-lan` permanently.
Do not try to fix it by promoting the bot — that buys nothing and costs the
`main` protection below, since a repo admin can override a merge whitelist.

The 403 also has to be told apart from the `variable not found` that step 5
warns about. They look alike and mean opposite things: not-found means unset,
which means reviews are *enabled*, while a 403 means the value was never read.

Both logins live in `~/.config/tea/config.yml` (mode 0600). Git access as the
bot is a separate credential from its API token — an SSH key registered on the
`code-bot` account, reached through a host alias, so no token ever sits in a
remote URL and there is no ambiguity about which account a push authenticates
as. One-time setup on a new machine:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_code_bot -C code-bot -N ""
tea logins add --name code-bot --url http://192.168.2.161:3000 --token <CODE_BOT_TOKEN>
# add ~/.ssh/id_ed25519_code_bot.pub to the code-bot account's SSH keys
# (needs a token with write:user scope, or paste it in that account's Settings)

cat >> ~/.ssh/config <<'EOF'
Host gitea-code-bot
    HostName 192.168.2.161
    Port 2222
    User git
    IdentityFile ~/.ssh/id_ed25519_code_bot
    IdentitiesOnly yes
EOF

# Repo-wide, once — both of these live in the shared .git/config, so every
# linked worktree gets them and a second Review Loop must not repeat them.
git remote add code-bot ssh://gitea-code-bot/thomasN4/another-cs-clone.git
git config extensions.worktreeConfig true
```

`main` is protected: push and merge are whitelisted to `thomasN4`, so `code-bot`
is mechanically unable to merge a PR or push to `main`. That backs the standing
rule below rather than replacing it — outside Review Loop the agent still acts
through the user's own key, where nothing but the rule stops it.

## Workflow

Default loop for every non-trivial change: **plan → worktree → implement → open draft PR**.

1. **Plan** — agree scope and approach with the user before touching code.
2. **Worktree** — every branch is developed in its own git worktree, never directly in the shared primary checkout (which stays on `main`). One session per worktree; never run two sessions against one working copy:

   ```sh
   git worktree add ../acsc-<slug> -b feat/<short-slug>
   ```

3. **Implement** — on a feature branch cut from `main` (inside its worktree):
   - Branch prefix, `<prefix>/<short-slug>` — the set is these four, no others:
     `feat/` new gameplay or behavior · `fix/` bug fixes · `refactor/` structure
     and tooling with no behavior change · `docs/` documentation only. Take the
     prefix from this list rather than from habit: `chore/` is the Conventional
     Commits default for tooling and is NOT used here.
   - As many WIP commits as sensible while working; commit messages: short imperative summary, optionally `;`-joined clauses, e.g.

   ```
   Fix missing player import breaking reload; add smoke test and debug hook

   Co-authored-by: <model> <noreply@acsc>
   ```

   Every commit message MUST end with a trailer naming the model that produced it, in the full `Name <email>` form where possible. **Which trailer depends on who authored the commit:**

   - Authored by the user (`Thomas Nguyen <…>`) — `Co-authored-by: <model>`. The model worked alongside a human author, which is what the trailer says.
   - Authored by `code-bot`, as every Review Loop commit is — `Authored-by: <model>`. There is no human author for the model to be "co-" with; the model wrote it and the bot account committed it. Note the cost of being accurate here: `Co-authored-by` is a trailer Gitea parses and renders as an additional author, and `Authored-by` is not, so on those commits the model appears as plain trailer text only.
4. **Draft PR** — once implementation AND verification (build + smoke test) pass, push the branch and open a draft PR against `main`:
   - `tea pr create --draft --repo thomasN4/another-cs-clone --title "<imperative summary>" --description "..."`
   - Gitea has no draft flag on the pull request itself. `--draft` prepends
     `WIP: ` to the title and Gitea refuses to merge while that prefix is
     present — removing the prefix is what marks a PR ready for review.
   - PR body: what changed, why, and verification results. The PR body/description and every subsequent PR comment MUST also end with a trailer, chosen by the same rule as commit messages: `Co-authored-by: Muse Spark <muse-spark@meta>` when the user posts it, `Authored-by: Muse Spark <muse-spark@meta>` when `code-bot` does.
5. **Review** — the user merges personally in the Gitea UI. Do NOT run `tea pr merge`, and do not strip a PR's `WIP: ` prefix, unless explicitly instructed for that specific PR. **Review Loop** below is the standing form of that instruction: it grants the prefix, the push and the draft PR for one named PR, and never the merge.
   - Dropping the `WIP: ` prefix is also what triggers the automated reviewer
     (`.github/workflows/review.yml`): the selected headless reviewer reads the
     diff and posts a comment-review as `review-bot`, once per head commit.
     Codex is the default; the repo Actions variable `AI_REVIEWER=claude` or
     `AI_REVIEWER=opencode` selects Claude or OpenCode manually. AI review is
     enabled by default; setting the repo Actions variable
     `ENABLE_AI_REVIEW=false` temporarily skips it, while unsetting the variable
     or setting it to `true` enables it. It is advisory and gates nothing —
     `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` in
     `ci.yml` remain the only checks that can fail a PR.

Direct pushes to `main` are the exception, only when the user asks (e.g., hotfixes, workflow/docs meta-changes).

### Plan Relay (planning agent → OpenCode executor)

**Plan Relay** is the optional split-agent implementation path for a task whose
plan should be settled up front by a planning agent and executed by the
repository's pinned OpenCode agent. The planner is whichever agent the user is
working in — the relay assumes nothing about which, and the approved plan
document is the whole interface. The ordinary single-agent loop above remains
valid. When Plan Relay is chosen, its ownership boundary is strict:

1. **The planner plans** — inspect the worktree read-only, settle every product
   and implementation decision with the user, and write an approved Markdown
   plan.
2. **The user approves** — an unresolved choice is a planning blocker, not a
   decision for the executor to improvise.
3. **OpenCode implements** — from the clean linked worktree, run:

   ```sh
   scripts/plan-relay.sh <plan.md>
   ```

   The runner pins the repository's `executor` agent, model, permissions and
   runtime isolation. The executor runs under a watchdog (`OPENCODE_TIMEOUT`,
   default 2700 s) whose nonzero status — including the watchdog's own 124 —
   propagates; an exit-0 session must additionally pass a liveness gate over
   the retained event stream
   (`scripts/planRelayGate.mjs`), because a `length`-truncated final step
   otherwise exits 0 over a session that did nothing. It never commits,
   pushes or opens a PR.
4. **The planner verifies** — read the retained transcript and working-tree
   diff, rerun the plan's checks independently, and report deviations before
   the normal commit / draft-PR stages continue. Git publication remains the
   user's decision — under **Review Loop** below, that decision is the one the
   user made in choosing the workflow.
5. **The planner logs** — append a wave entry to
   [`docs/plan-relay-log.md`](docs/plan-relay-log.md), taking the numbers from
   each run's `summary.json` and adding the verdict a machine cannot write.
   Both versions belong in the entry, and they are different numbers: the
   tooling version in `scripts/planRelayVersion.mjs`, pinned by a source digest
   that fails `npm test` when the relay changes without a bump, and the plan
   document's own `plan_relay_version`, which versions the handoff schema below.

The handoff plan is a public interface between the two agents. It must be a
non-empty Markdown file with exactly one version and baseline in YAML
frontmatter, plus all five required sections:

```md
---
plan_relay_version: 1
baseline_commit: <40-character Git commit>
---

# Task title

## Summary
## Interfaces
## Implementation
## Test Plan
## Assumptions
```

`baseline_commit` is the clean worktree commit the plan was written against.
The runner refuses a primary worktree, `main`, dirty state, malformed plan, or
baseline mismatch. It copies the approved input and OpenCode JSONL events to an
ignored `.plan-relay/<baseline>.<random>/` directory, whose path it prints, and
attempts to write a `summary.json` beside them — cost, tokens, per-turn timing,
files touched, denied tool calls, gate verdict — for **every** run, including the
ones the watchdog killed, because those are the runs whose cost you cannot
otherwise account for. A summary failure is reported but does not replace the
executor's exit status; use the retained `events.jsonl` as the fallback record.
That directory stays local evidence and is routinely pruned; the committed
record is the planner's short wave entry in
[`docs/plan-relay-log.md`](docs/plan-relay-log.md), which cites the run and adds
what deviated, what the planner fixed afterwards, and whether the relay was
worth using. OpenCode must treat both this file and the copied plan as binding;
if repository truth contradicts the plan, it stops and reports the conflict
instead of redesigning the task.

### Plan Relay fan-out (one planner, several executors)

**A wave is one planner fanning one baseline out to N executors, each in its own
worktree.** The relay enforces none of this — it sees one plan and one worktree,
and that isolation is the point — so the protocol is the planner's to keep, and
every rule below exists because nothing will catch you breaking it:

- **Disjoint ownership per plan.** Two plans in one wave may not edit the same
  file, and may not both change one interface. Name the owned files in each
  plan's `## Interfaces` section and treat an overlap as a planning blocker, not
  a merge problem — two executors editing `core/state.ts` produce two clean,
  individually-passing worktrees that conflict on merge, and by then both
  transcripts are cold.
- **One baseline per wave.** Every plan carries the same `baseline_commit`, so
  the diffs compose and a failure is attributable to a plan rather than to drift
  between them.
- **Its own install.** A worktree in a wave needs a real `node_modules`, not a
  `node_modules -> ../acsc-main/node_modules` symlink — that link is how
  parallel worktrees usually share one install (see `.gitignore`), and it makes
  concurrent `npm test` and `npm run build` runs share one `node_modules/.vite`
  cache. Run `npm install` in the worktree first. With `PLAN_RELAY_WAVE` set the
  runner warns when it sees the symlink; it does not refuse.
- **A distinct dev-server port each**, via `CS_SMOKE_BASE`, for any plan whose
  Test Plan runs the smoke test.
- **Verify each worktree independently, before merging any.** A wave that passes
  as a set but was never checked apart hides which plan broke what.

Export `PLAN_RELAY_WAVE=<slug>` when launching each executor. The runner stamps
it into every `summary.json`, and that stamp is the only thing tying the runs
together: there is no cross-worktree lock, no shared state and no wave registry,
and adding one would trade the relay's independent worktrees for exactly the
shared mutable state this repository bans elsewhere. Unset, a run's wave id
defaults to its own run directory, so a solo run never claims a fan-out.

### Review Loop (planner drives one PR to ready)

**Review Loop** is the named workflow for driving one PR from an approved plan
to merge-ready, taking the arming, waiting, reading and disposition of the
reviewer off the user. It does not remove the user from planning: under Plan
Relay every remediation plan still needs approval, so those rounds keep a user
turn by design. Its subject is exactly one
PR, and its terminal state is that PR with the `WIP: ` prefix off, `ci.yml`
green, and every review finding either fixed or answered in writing. The planner
is whichever agent the user is working in, as in Plan Relay above.

Choosing Review Loop for a PR **is** the explicit instruction step 5 of the
workflow above requires. For that one named PR it grants the planner four
things and no others: pushing the branch, opening its draft PR, toggling its
`WIP: ` prefix, and answering findings in the PR thread — the fourth because the
loop's own stopping rule below tells it to answer some findings in writing, and
a grant that omitted that would stall the cycle it exists to allow.
`tea pr merge` stays banned, the user still merges by hand in
the Gitea UI, and the grant does not carry to the next PR.

**All four are exercised as `code-bot`, never as the user.** Commit as
`code-bot <code-bot@example.com>`, push to the `code-bot` remote, and pass
`--login code-bot` to every `tea` write. The point is legibility: with one
account doing both, a reader of the PR timeline cannot tell which prefix toggle
or which comment was the agent's, and that distinction is the whole basis on
which the user reviews what the loop did.

The bot identity is set **per worktree, with `--worktree`**, and that flag is the
whole point rather than a flourish:

```sh
git config --worktree user.name code-bot
git config --worktree user.email code-bot@example.com
```

A plain `git config user.name` inside a linked worktree does not scope to that
worktree — it writes the repository's shared `.git/config`, which every worktree
reads. Set it that way and the primary checkout on `main`, and every other
feature worktree, silently starts authoring its commits as `code-bot` too; you
find out when a commit you made somewhere else carries the bot's name. `--worktree`
needs `extensions.worktreeConfig`, which is part of the one-time repo setup
above, alongside the `code-bot` remote — that remote is shared for the same
reason, so add it once for the repository and never per worktree.

`main`'s branch protection whitelists `thomasN4` for push and merge, so the ban
on `tea pr merge` is now enforced by the server for this account and not only by
this document — and only for as long as `code-bot` stays a non-admin
collaborator, because the rule leaves `block_admin_merge_override` off. Do not
read any of it as the ban having become someone else's problem: it holds for
`code-bot` alone, and every rule here is still written for an agent that also
holds the user's key.

1. **The planner and the user agree the PR** — its scope, the commits it should
   arrive in, and whether implementation runs under Plan Relay.
2. **The planner plans** — one approved plan per commit-sized unit of work.
   Under Plan Relay that is the handoff document above, and its step 2 is
   unchanged: the user approves each one, including the ones a review sends the
   loop back for. Otherwise it is the ordinary step-1 agreement. An unresolved choice is a planning blocker here
   too.
3. **The executors implement** — `scripts/plan-relay.sh <plan.md>` per plan, one
   worktree each, under the fan-out protocol above; or the planner implements
   directly. Either way the planner verifies independently before anything is
   pushed, and a relay run is logged before that.
4. **The planner publishes** — commit, `git push code-bot HEAD`, and open the PR
   with `tea pr create --draft --login code-bot --repo thomasN4/another-cs-clone`
   if it is not already open.
   **Push every commit of the
   round before step 5.** `review.yml`'s concurrency group is keyed by PR number
   with `cancel-in-progress`, so a push landing during an in-flight review kills
   that review. Nothing is posted, but the run itself records the cancellation
   as its terminal status, which is the state step 6's watcher reads.
5. **The planner arms the reviewer** — read `ENABLE_AI_REVIEW`, then strip the
   prefix. It is a repo Actions variable, not anything in the tree, and the
   Gitea SDK cannot list them, so read it by name. This
   is the one Review Loop command that must **not** run as `code-bot`: the
   endpoint requires the repo's owner, which no collaborator role satisfies, so
   `code-bot` gets a 403 rather than a value. See Project above.

   ```sh
   tea actions variables list --repo thomasN4/another-cs-clone --name ENABLE_AI_REVIEW
   ```

   Only the literal `false` disables reviews. Unset is the default and means
   enabled, and the lookup reports that as `Error: variable not found` — so read
   the value, not the exit status, or the one case that needs no action reads as
   the one that stops you. A 403 is neither: it means the command ran under the
   wrong login and the variable was never read at all, so re-run it on
   `gitea-lan` rather than treating it as unset. If it *is* `false`, stop and
   ask: the user set it
   deliberately, and stripping the prefix anyway would mark the PR ready with no
   review at all. Otherwise note which route `AI_REVIEWER`
   selects, then drop the prefix with
   `tea pr edit <index> --ready --login code-bot --repo thomasN4/another-cs-clone`,
   which is itself the `edited` event that starts the run.
6. **The planner waits** — arm a background watcher, then leave the PR alone
   until it fires. The watcher must exit on the failure paths too, not only on
   the review landing: a reviewer that dies posts nothing at all, and silence
   looks exactly like a slow review.
7. **The planner reads the review** — it is a pull-request review rather than an
   issue comment (Gitea has no commit-comment API), so it is the body under
   `/pulls/{index}/reviews` carrying this head commit's
   `<!-- ai-review:<sha> -->` marker.
8. **The planner decides** — another round, or stop. Another round re-adds the
   `WIP: ` prefix first and returns to step 2. Stopping means reporting to the
   user: `ci.yml`'s result, and every finding marked fixed or declined with its
   reason. Report it that way rather than as "nothing is blocking" — the review
   gates nothing by construction. What does block a merge is `ci.yml`, the
   `WIP: ` prefix, and a conflict with `main`, which the other two cannot see: a
   PR whose base moved under it stays green with every finding resolved and
   still will not merge. Ask Git for that one rather than the PR — Gitea reports
   `mergeable: false` for a `WIP: `-prefixed PR as well, so mid-loop it cannot
   tell you which of the two it is answering:

   ```sh
   git fetch origin main    # a failure here is a fetch failure, not an answer
   git merge-tree --write-tree origin/main HEAD; echo "merge-tree: $?"
   ```

   Run them as two commands and read only the second. `merge-tree`'s exit 1 is a
   conflict and 0 is clean, neither depending on the title; anything else — 128,
   say — is the tool failing rather than a verdict, so report it as that.
   Chaining them with `&&` merges two different failures into one status: the
   canonical remote is a LAN box, and when it is unreachable the compound exits
   nonzero having compared nothing at all, which under the reading above is
   indistinguishable from a real conflict.

Every rule below exists because this machinery fails quietly rather than loudly,
and a planner waiting on it cannot tell the difference from the outside:

- **Three automatic rounds, then stop.** Cap the cycle at three arms of the
  reviewer without a user turn. The reviewer is advisory and will nearly always
  find something, so the loop has no fixed point of its own and would otherwise
  spend the user's quota indefinitely.
- **Only substance earns a round.** A finding earns another round when it is a
  correctness bug, or when it violates a rule in Architecture rules or Gotchas
  learned the hard way. Style and preference findings are answered in the PR
  thread, `tea comments add <index> --login code-bot --repo thomasN4/another-cs-clone`,
  ending in the `Authored-by`
  trailer that a `code-bot` post takes — and do not restart the loop.
- **A failed reviewer posts nothing at all.** A usage limit or provider error
  exits the model command nonzero, which fails the Review step it runs in and
  skips everything after it; the export step's empty-file check is the narrower
  case where the command exited 0 having written nothing. Either way the `post`
  job's condition goes unsatisfied, no comment appears, and none ever will. A watcher that greps only for the comment therefore hangs forever;
  watch the workflow run's terminal status alongside it, and give the wait a
  deadline past the sum of the jobs it waits on. Those run in sequence and cap
  at 5 + 25 + 5 minutes, so a deadline merely past the reviewer's own
  `timeout-minutes: 25` can fire during a healthy run. `timeout-minutes` bounds
  execution and not the wait for a free runner, and the Codex route queues for
  the dedicated `ai-review` one, so no deadline is safe as a verdict. Treat its
  expiry as the cue to go read the run's status, never as proof the reviewer
  died.
- **Re-triggering costs no commit.** `edited` is in the workflow's trigger list,
  so re-adding `WIP: ` and stripping it again re-runs the reviewer against the
  same head commit. That is safe to do without checking first: `already-reviewed`
  keys off the per-commit marker, so if a review did post, the rerun is a no-op
  rather than a duplicate.
- **Switch route before retrying a quota failure.** Quota is per-provider, so
  retrying the same exhausted `AI_REVIEWER` spends another 25 minutes failing
  identically. Switching to `claude` or `opencode` spends a *different*
  subscription of the user's — ask first, and never rotate routes unattended.
- **Two failed rounds is a stop, not a third try.** Re-add the `WIP: ` prefix
  first, then report which routes failed and hand the decision back; the third
  attempt is the user's to authorize. The prefix goes back on for **every** exit
  from the loop that did not get a review, not just this one — that is the
  invariant, and step 5 already enforces it for the `ENABLE_AI_REVIEW=false`
  case, refusing to strip the prefix "because stripping it anyway would mark the
  PR ready with no review at all". Stripping the prefix is what arms the
  reviewer, so by the time a failure is known the prefix is already off: a stop
  that only reports leaves behind a PR that is prefix-off, green on `ci.yml` and
  unreviewed, which is indistinguishable from one the loop finished. That is the
  single end state this loop must never produce by accident.
- **A cancelled run means a newer event landed, not necessarily a push.** The
  concurrency group is keyed by PR number and does not care which event opened
  the run, so an `edited` — a title toggle, or a description fix — cancels an
  in-flight review exactly as a push does. Find out which happened before
  re-arming from step 5; only the push case also changed what is being
  reviewed.
- **The marker, not the kind of edit, decides what an `edited` event does.** A
  description fix and a `WIP: ` toggle produce the same event, and the dedupe
  reads only the head SHA. So before a review has posted, *either* restarts the
  reviewer — which mid-flight means cancelling the run in progress and starting
  over on an unchanged head, so a typo fix in the description costs a whole
  review and step 6's "leave the PR alone" is not a politeness. After one has
  posted, *neither* does anything: the toggle is no more able to force a second
  opinion on a reviewed commit than the body edit is. Only a new commit moves
  the head, and only a new head earns a new review.

## Commands

```sh
npm run dev                    # dev server (http://localhost:5173)
npm run build                  # production build -> dist/
npm run lint                   # ESLint (flat config); no-undef for .js, type-aware rules for .ts,
                               # browser globals/imports banned in src/**/*.test.ts
npm run typecheck              # tsc --noEmit; strict + noUncheckedIndexedAccess
npm test                       # Vitest: unit tests + the doc gates (no browser, ~200 ms)
node scripts/smoke-test.mjs    # headless E2E check (requires dev server running)
```

Four static/sim layers, deliberately split:

- **`npm run lint`** — static: unused bindings, the `any` ban (`no-explicit-any` + `no-unsafe-*` family), `@ts-ignore` ban. For `.js` files it still owns missing-import detection via `no-undef`; for `.ts` files `no-undef` is OFF and that job belongs to typecheck — though the type-aware rules independently flag unresolved names as error-typed values, so the class is double-covered. It also owns unit-test purity: `src/**/*.test.ts` gets `no-restricted-globals` (browser globals) and `no-restricted-imports` (browser-side modules). Do NOT assume withholding globals is what enforces that — `no-undef` is off for `.ts`, so the rules are the mechanism (review lessons 10, 17, 19).

- **`npm run typecheck`** — the compiler as a gate: `strict`, and `noUncheckedIndexedAccess`, which makes every `WEAPONS[wpn.slot]`-style read prove what happens on a miss. This is now the primary missing-import catcher for `.ts` code (TS2304), which neither `npm run build` nor `npm test` can see.

- **`npm test`** — pure simulation logic: state, accuracy, recoil, ballistics, damage, movement, world registration. Runs in plain Node, no browser, no dev server. Fast enough to run on every edit. When a browser-side module holds pure logic the suite cannot reach, split out a seam rather than mocking — `sim/recoil.ts:convertOnSwap()` is the worked example, and lesson 19 is what it cost to learn twice. The suite also carries two repo-hygiene checks that are not simulation logic: `scripts/lessonNumbering.test.mjs`, which reads `docs/*-plan.md` off disk and fails if a review-lesson number moves out from under the comments citing it (see Roadmap); and `scripts/planRelayLog.test.mjs`, which reads `docs/plan-relay-log.md` and fails if its version history does not reach `PLAN_RELAY_VERSION` — that is what turns a Plan Relay source change into a written explanation, since `planRelay.test.mjs` already fails the bump itself.
- **`scripts/smoke-test.mjs`** — integration: real rendering, real input events, every map. This is the layer that catches wiring breakage. Drives the user's Brave browser via puppeteer-core; its executable path is machine-specific (Flatpak path) and may need adjusting on other machines. Point it at a non-default port with `CS_SMOKE_BASE=http://localhost:5177 node scripts/smoke-test.mjs`. Note Vitest resolves through its own bundled Vite (8.x), not the workspace Vite 5 — a resolution edge must work under both.

A fifth layer reads rather than runs: the CI reviewer in
`.github/workflows/review.yml`. Its standing instructions are
`scripts/review-prompt.md` — edit that file, not the workflow, to change what
the reviewer looks for. That file's header carries the by-hand invocation for
iterating on it locally without pushing; it lives there and not here because the
snippets have to track the workflow's actual Claude, Codex and OpenCode calls,
and two copies drifted apart within one PR the first time there were two.

## Architecture rules

- **All shared mutable state lives in `src/core/state.ts`**, grouped into owner-scoped slices written by one system each — `session`/`input`/`aim`/`wpn`/`motion`/`score` (see the slices' docs for their writers) — alongside `player`, `weapon`, `keys`, `bots`, the effects collections, `gameTime` and `soundEvents` (the bot-audible sound ring, `sim/soundEvents.ts:SoundRing`), plus the domain vocabulary (`WeaponDef`, `LiveWeapon`, `PlayerState`, the structural `Bot` shape, `HitZone`) — except the world registries `solids`/`colliders`/`navLinks`/`liftPads`/`elevators`, which `world.ts` owns so registration has exactly one path. Do not create new cross-module mutable globals elsewhere. `window.__cs.game`'s flat shape is a delegation-only facade over the slices built in main.ts; gameplay code imports slices directly.
- **`core/state.ts` must stay importable in plain Node.** It may use THREE's math classes (`Vector3`, `Box3`), but never `document`, `window`, `location`, or a `WebGLRenderer`. This is what makes the simulation unit-testable: `src/core/state.test.ts` runs in plain Node, so a browser global at module scope breaks every test in it on import. Browser-derived values are written IN by `main.ts` at startup (see `session.map`) rather than read here. Anything browser-only belongs in `core/engine.ts` or behind an `init*()` function.
- **Engine singletons (`renderer`, `scene`, `camera`, `clock`) live in `src/core/engine.ts`** and are created by `initEngine()`, not at module scope. They are `export let` live bindings typed at their non-optional class types: reading them before init yields `undefined` at runtime, and the "read only after init" contract is documented rather than encoded as `| undefined`.
- **No module-scope side effects that touch the engine or the DOM.** A module needing either exposes an `init*()` function that `main.ts` calls in order. Current order, which `main.ts` documents inline:

  ```
  initEngine() → initHUD() → initWeaponViewmodels() → BUILDERS[session.map]() → respawn() → initMenus() → loop
  ```

- **Gameplay math lives in `src/sim/`, as pure functions.** Accuracy, recoil, ballistics, damage zones, speed tiers and blend easing take every input as a parameter — no engine imports, no DOM, no reads of shared state. That is what makes them unit-testable in plain Node (`npm test`), and it is where new gameplay math belongs. Modules like `weapons.ts` are thin bindings that feed live state in. Four sanctioned exceptions, all stateful per-bot policy classes: `sim/botBrains.ts:DefaultBrain` keeps policy state across `decide()` calls; `sim/botWeapons.ts:WeaponFireController` keeps magazine, reload and cadence state across `tick()` calls; `MeleeFireController` beside it keeps a blade's cadence, which is all a weapon holding no rounds has; and `BotLoadout` keeps which POSITION of `[primary, secondary?, knife]` is active, descending that ladder as each runs dry. All four stay engine-free, DOM-free and shared-state-free — every frame's world knowledge arrives via the `BrainView` parameter, and the weapon's catalog stats arrive as a `WeaponDef` argument rather than a runtime import of `core/state.ts` (the same seam `validateWeapons` uses).
- **The accuracy model** (`sim/accuracy.ts`) is:

  ```
  spread = ((stance + movement + air) × spray + inherent) × ADS
  ```

  Two things about it are easy to get wrong:
  - **`spray` is a MULTIPLIER resting at 1, not an additive accumulator resting at 0.** It scales the situational group only — `inherent`, the weapon's own rest cone, is added afterwards so sustained fire never degrades a weapon's intrinsic accuracy. Anything that resets spray must reset it to `1` (see `combat.ts:respawn`, and the smoke test's accuracy phase).
  - **Movement is cubic** in measured speed, so sprint diverges sharply from walk rather than scaling linearly.
- **Aim has two axes, and both must be shared.** `currentAimPitch()` and `currentAimYaw()` in `weapons.ts` are the single source for the camera (`updateCamera`) *and* the shot direction (`shoot()`). Movement's forward vector and mouse input stay on the base `aim.yaw`/`aim.pitch` — routing the view punch into either would steer the player's legs or fight the mouse.
- **Extract and wire in the same commit.** If you lift a formula or constant into `sim/`, delete the inline original and switch every call site at once. A named constant that nothing imports, or a pure function shadowed by a surviving inline copy, is two sources of truth plus a comment that lies.
- **The per-frame stage order in `main.ts:animate()` is load-bearing:**

  ```
  updateElevators → updateMovement → updateWeapon → updateCamera → updateViewmodel → updateBots → updateHUD
  ```

  `updateWeapon` consumes the blends `updateMovement` writes and decays `wpn.recoil`; `updateCamera` and `updateViewmodel` then read that post-decay recoil, so camera, viewmodel and bullets agree within a frame. Reordering aims the camera a frame ahead of the shots (`5e004a5`). The pin runs the other way too: `updateMovement` writes `camera.position`, and `shoot()` — reached from inside `updateWeapon` — rays from `camera.getWorldPosition()`, so that write cannot be deferred to `updateCamera` without firing every shot from the previous frame's eye. Keep the sequence flat in `animate()` — do not nest one stage inside another.
- **Dependency direction:** everything may import from `core/state.ts` and `sim/`; browser-side modules also import `core/engine.ts` and `world.ts`. Modules must not import each other in cycles. Current flow: `main` → {player, bots, weapons, menu, maps/} → {world, sim, core}. `maps/index.ts` imports only its sibling builders, so the registry adds no new direction. `world.ts` sits between the map builders and `core/`: unlike `sim/` it is not engine-free — it imports `scene` from `core/engine.ts` — but it reads `scene` only inside `addSolidBox`, `addElevator`, and `addOpenStairs`' stringer group, which is what keeps the module importable in plain Node.
- **Dynamic index reads must prove their miss case, or make the miss unrepresentable.** `noUncheckedIndexedAccess` makes an array read `T | undefined`. Prefer removing the case: where the table is fixed-size, key it by a literal union — a tuple indexed by its own union (`wpn.slot: WeaponSlot` into per-position arrays) OR a `Record<WeaponId, WeaponDef>` catalog — either way the read is exempt from the flag and there is no miss to guard. Where the index is genuinely unbounded (`zoomFovs[wpn.zoomLevel]`), decide explicitly: `weapons.ts:aimFovFor` clamps because it owes its caller a number, the HUD zoom label degrades to empty because a view must not throw mid-frame, and a narrowing helper that throws a named error is right where a miss means corrupted state. NO `?? defaultValue` fallbacks on INDEX reads — a fallback invents a value the old code never produced. (A documented-default optional field like `pellets ?? 1` is a different thing: the default is part of the field's contract, stated where the field is declared.) Bare `!` assertions are for bound-guarded reads (`impacts[i]` inside its own loop, `hits[0]` after a length check) and tests.
- **Level geometry must go through `src/world.ts`**, which owns `solids` (raycast targets: bullets, decals, bot LOS) and `colliders` (world-space AABBs for movement), plus the bot-facing traversal registries `navLinks` (stair/lift endpoints for sim/navGrid.ts) `liftPads` (launch triggers for sim/lift.ts), and `elevators` (dynamic decks and their persistent colliders). Adding meshes to the scene directly creates walk-through/shoot-through bugs. That is the whole public surface — if none of these fits, add a function here rather than pushing to the arrays yourself:

  | | |
  |---|---|
  | `addElevator(spec)` | Create and register a cycling vertical deck and its bidirectional navigation link; attach it to the scene. |
  | `registerElevator(spec)` | Same registration without scene attachment, for Node tests; the caller attaches the mesh directly to the scene. |
  | `updateElevators(dt,bodies)` | Advance meshes/colliders before movement; retain time and position on a swept obstruction. |
  | `elevatorCarry(body)` | Read the previous support's displacement once in each actor's movement stage. |
  | `addSolidBox(x,y,z,w,h,d,mat)` | Create + `scene.add` + register both. **The default** for walls and crates. Browser-only. |
  | `addStairs(x,y,z,width,stepH,stepD,count,mat?,dir?)` | Flight of full-height step boxes composed from `addSolidBox`; top riser lands exactly at `y + count*stepH`. Keep `stepH` ≤ `collision.ts:STEP_HEIGHT` or the risers become walls. Browser-only. |
  | `addOpenStairs(x,y,z,width,stepH,stepD,count,treadT,mat?,dir?)` | Open flight — thin treads at the same tops `addStairs` would give, hung on two stringers, with air underneath to walk through. Treads register via `addSolidBox`; stringers are shootable but not blocking. Also publishes the flight's `NavLink`. Browser-only. |
  | `addLiftPad(x,y,z,w,d,h,launchVel,landing,mat?)` | Cargo lift: an ordinary solid pad plus a `liftPads` trigger and a one-way `NavLink` aimed at `landing`. Keep `h` ≤ `collision.ts:STEP_HEIGHT` so it can be walked onto. Browser-only. |
  | `createSolidBox(x,y,z,w,h,d,mat)` | Same construction, but no scene and no registration. Pure; the seam `addSolidBox` is built from, and where `y` = BASE is unit-tested. |
  | `registerSolidBox(mesh)` | Both registries, for a mesh you positioned yourself. Pure. |
  | `registerSolid(mesh)` | Raycast target, **no** AABB — flat ground planes only. Pure. |
  | `registerGroupParts(group, {shootable, blocking})` | Parts under a transformed parent. Flushes the group's world matrix before measuring, and takes two lists because they legitimately differ (a range target's post blocks walking but not bullets). Pure. |
  | `resetWorld()` | Clears all the registries. Tests only. |

  `registerSolid` is narrower than it looks: it is right for the ground planes because a flat `PlaneGeometry` measures to a **zero-height** box at y ≈ 0 — always steppable under the feet-aware collision model (`STEP_HEIGHT`), so an AABB there would do nothing at all — movement is bounded by the perimeter/lane walls instead. Geometry with real height (a floor slab, a raised platform, a ramp) is **not** this case and must go through `addSolidBox`/`registerSolidBox`, or you ship a walk-through floor.

  `addElevator` and `addSolidBox` (and `addStairs`, through it) attach meshes to the scene — `addOpenStairs` composes `addSolidBox` for the treads and adds its stringer group directly — and `addLiftPad` composes `addSolidBox` for the pad; registration and elevator simulation stay scene-free and unit-tested, because both bugs this has caused (`431ac6e` no-clip, `faa52c5` AABBs at the origin) live in the scene-free half — as does the base-vs-centre offset, which has not bitten yet but had no test until `createSolidBox` gave it a seam.
- **Movement collision is feet-aware; elevation is resolved in `collision.ts`, not per entity.** Entities are positioned by their FEET height: `collidesAt(pos, radius, feetY, colliders)` blocks only geometry rising more than `STEP_HEIGHT` above the feet (so risers don't block), and `resolveVertical` integrates gravity against `supportHeightAt` with swept floor and ceiling checks — together they produce resting, step-up, swept landings (no tunneling), walking off edges and head stops under overhead geometry. `slideMoveXZ` also takes a blocked axis move when it strictly UNWEDGES — every collider blocking at the destination overlaps the footprint less along the moving axis than it does now — because a binary overlap test otherwise refuses every direction to an entity already inside geometry, the way out included (lesson 23). Strictly-worse vetoes, so approaching from outside is refused exactly as before and walls stay solid; unchanged is indifferent, not a veto. A grounded entity additionally STICKS to support within one `STEP_HEIGHT` below its feet (`wasGrounded` param fed back from the caller's last frame): without it, descending a flight micro-free-falls every riser (~13 frames of near-full air-accuracy penalty per tread). Deeper drops — ledges — still go airborne; jumps rise until their swept head meets a collider underside. Player AND bots go through the shared `slideMoveXZ` + `resolveVertical` pair; do not open-code a second gate. **A bot STEERS planar but RANGES in 3D**: `perception.ts` reports both the observed feet and eye plus planar `dist`, eye-to-eye `dist3`, and feet-relative `rise`. `botBrains.ts` derives its y-stripped steering vector from `BrainView.selfFeet` and `visual.feet`, while the chase bands and `engageRange` read `visual.dist3`/`visual.rise`; the executor's hit die likewise uses the actual post-move 3D distance. Ranging on the planar number is what once made a target on a deck overhead read as point-blank and pushed bots away from the stairs that reach it. Every `VisualCandidate` carries FEET and EYE separately — `player.pos` is an EYE, so both `bots.ts` and `combat.ts` call `core/state.ts:playerFeet()` when they need the player's feet. The player's `pos` stays the EYE position (`feet = pos.y − eyeHeight`); physics snaps to support instantly while the camera rides `motion.groundSmoothY` (~80 ms blend) so stairs don't jitter the view.
- **Match config is committed as one URL query, and map switching is a full page reload.** The start menu encodes `?map=&tbots=&ctbots=&time=&tweap=&tsec=&ctweap=&ctsec=` (time in SECONDS; `core/sessionConfig.ts` parses/clamps it — pure and unit-tested — and `main.ts` writes the result into `session` at startup). `tweap`/`ctweap` are each side's bot PRIMARY (smg/sniper/shotgun) and `tsec`/`ctsec` its SECONDARY (pistol/revolver), or `mixed` to draw one per bot from that position's own pool (`BOT_PRIMARY_IDS` / `BOT_SIDEARM_IDS`); `asBotWeapon` and `asBotSecondary` narrow them through exhaustive `Record`s and are shared with the menu form for the same reason `asMapName` is — a second literal comparison in `menu.ts` is how the form and the parser drift apart the next time the catalog widens. Neither sidearms nor the blade are legal primaries, and neither primaries, the blade nor `none` are legal secondaries: sidearms arrive via the secondary position and the blade is already every loadout's last position (`sim/botWeapons.ts:makeBotLoadout`), so `asBotWeapon`/`asBotSecondary` fall back rather than accept something the menu never offered. (Tranche 7b once made `knife` a legal primary with a blade-only bot; that was reversed when the menu split into primary/secondary — stale `?tweap=knife`/`?tsec=none` bookmarks fall back to the defaults.) The HELD-weapon types stay wide open: `BotWeaponId` still spans the whole catalog, so every `Record` over it (tuning, silhouettes, attack tones) still fails to compile until a new weapon says how a bot uses it. Play navigates only when the form differs from the applied config; otherwise it just re-locks. Never hot-swap scene contents at runtime — the map builders in `src/maps/` assume a fresh scene. Any new map needs: a builder in `src/maps/` listed in `maps/index.ts`'s `BUILDERS` (a full `Record<MapName, () => void>`, so widening `MapName` fails to compile until it is registered), a `MapName` entry in state.ts + sessionConfig's `asMapName` (shared with the menu form — do NOT re-derive the map from `mapSel.value` in menu.ts), an `<option>` in index.html, a `SUBTITLES` line in menu.ts, a `combat.ts:SPAWN_Z` entry, a `state.ts:AMBIENCE` entry (sky/fog/light colours AND intensities, consumed by `initEngine(map)`; point it at `DESERT_AMBIENCE` to keep the original look), a `state.ts:BOT_SPAWNS` entry (the box each team is drawn from, feet-height aware so a zone can sit on a catwalk — it lives in state.ts rather than bots.ts only because eslint bars the unit suite from importing the browser half), and a smoke-test pass. All but the `<option>` are full `Record<MapName, …>` tables, so the compiler demands each one — the `<option>` is the single site it cannot see, and the one you can forget.
- **Damage flows through `combat.ts`** (`damagePlayer` / `damageBot`) — don't mutate HP from callers.
- DOM writes only in `hud.ts` (in-game HUD) and `menu.ts` (`#startMenu` / `#pauseMenu` / `#loadoutScreen`). Sound synthesis only in `audio.ts`. Every `getElementById` outside markup goes through `hud.ts:requireEl`, so a missing id is a named startup error; every read of three.js's `userData` goes through one owned accessor per tag (`bots.ts:botFor`) rather than scattered casts. The loadout has ONE writer: the picker's Deploy path calls `setLoadout()` (which validates the primary/secondary class split and arms ammo + the live weapon via `armLoadout()`) — never mutate `loadout`/`ammoStore`/`weapon` directly from elsewhere. sessionStorage persistence of the last loadout lives in `menu.ts` because `state.ts` must stay Node-pure; `sanitizeLoadout()` there owns what may be applied.

## Gotchas learned the hard way

- **Missing imports are NOT build errors here.** Vite/rollup won't flag an identifier used inside a function body if it happens to resolve as a global at runtime — it becomes a silent `ReferenceError` when that code path first runs (this is how reload broke once). Since the TS migration the class is double-covered: `npm run lint`'s `no-undef` for `.js` files (per-environment globals in `eslint.config.js`; OFF for `.ts`, where type names would false-positive), and `npm run typecheck`'s TS2304 for `.ts`. Run both after any code movement. Static checks are not a substitute for the smoke test: they see undeclared names, the smoke test sees wiring. `npm test` catches neither for browser-side modules.
- Pointer lock has a browser-enforced cooldown after `exitPointerLock()`; re-locking too soon silently fails. The canvas click handler recovers, keep that behavior when touching menus.
- The game loop only simulates while pointer lock is held (`session.locked && session.started`) but always renders. Anything added to the loop should respect that split.
- **Stale dev servers serve stale code.** An orphaned `vite` process holding port 5173 makes every smoke test validate an old build (new servers silently shift to 5174). Before testing: `fuser -k <port>/tcp`, start the server with `--port <n> --strictPort`, and confirm the port from its log. With parallel worktrees, parallel dev servers are expected — pick a distinct port per worktree and point the smoke test at it with `CS_SMOKE_BASE` (it defaults to 5173).
- `window.__cs` in main.ts is a debug/testing hook relied on by the smoke test — keep it exporting `{ game, weapon, player, bots, bulletHoles, colliders, elevators, gameTime, nav: { route, transportRoute, grid } }` (its shape is declared on `Window` in main.ts).
- **Euler rotation orders matter**: the camera and shot-direction math must both use `'YXZ'`. Default `'XYZ'` silently aims shots somewhere else (this caused bullets flying skyward once). The order now lives in one place — `sim/ballistics.ts:EULER_ORDER` — with a test pinning shot direction against a `'YXZ'` camera matrix, so the two can no longer drift apart silently.

## Conventions

- Real types on exported functions (`src/` is TypeScript); keep "why" comments for non-obvious logic and inline tuning notes on gameplay constants (e.g., `fireRate: 0.105 // ≈ 9.5 rounds/sec`) — those comments survive conversion because the numbers' reasons don't fit signatures. JSDoc `@param` prose only where the parameter's meaning isn't in its name.
- No comments that merely restate code. Keep existing `// ---------- Section ----------` headers.
- Audio remains WebAudio-synthesized. The first-person shotgun, revolver and pistol use Blender sources and checked GLB exports; see `docs/assets.md`. Other visuals remain procedural.

## Roadmap / deferred ideas

**Plans, rationale and the running list of review lessons live in
`docs/<tranche>-plan.md`, one per tranche** — the maintainability tranche's is
[`docs/refactor-plan.md`](docs/refactor-plan.md), and later tranches get their
own rather than growing it. Read the review-lessons section before picking work
up; it records traps that have already cost a cycle each. Completed work is
archived in those documents, not summarized here — this section only tracks
what is still open.

Three rules govern them, enforced by `scripts/lessonNumbering.test.mjs` in
`npm test`:

- **Review lessons share one counter across all plan documents.** A new lesson
  continues from the highest number already used anywhere in `docs/*-plan.md`,
  so a bare `lesson N` in a code comment is unambiguous.
- **Lesson numbers are permanent IDs** — assigned in order of recording, never
  reordered, never reused. A lesson may move between categories or be annotated
  in place; its number goes with it. Append new ones at the end of the list, not
  where they thematically belong.
- **Append and annotate, never renumber.** A closed tranche's record keeps its
  original wording; corrections land as annotations beside the claim, naming
  what changed and which PR changed it.

Deferred to a later tranche:

- Making weapon switching cost time (a draw/holster delay, ideally with a viewmodel animation on `poseWeapon`'s model). Switching is instant today, so `1-2-1` is a free recoil cancel — the conversion in `switchWeapon` is lossless, but the incoming weapon's `recoilRecover` then drains the carried units, and the sniper's 13/s clears a full smg climb in 0.277 s. The same zero-cost window also lets a swap dodge `scopeGate` and re-clamp `spray`. Tracked as **issue #15**; pre-existing behavior, pinned in `sim/recoil.test.ts` so a fix has to update the test deliberately.

Dropped: unifying Bot and the player under a shared entity base class. It addresses none of the regression classes this codebase has actually hit, and would couple a probabilistic AI to a physics-driven controller.
