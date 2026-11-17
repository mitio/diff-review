# diff-review

A fast local UI for reviewing diffs: GitHub pull requests, commits and compares, local git changes and pasted diffs.
It uses your `gh` login, and the token never leaves the local server.

```sh
npm install
npm start            # builds, then serves http://127.0.0.1:7777
npm link             # optional: puts the diff-review CLI on your PATH
```

Requires Node 24+ and an authenticated [GitHub CLI](https://cli.github.com/) (`gh auth login`). Open a PR, commit or
compare by replacing `https://github.com` with `http://127.0.0.1:7777` in its URL, pasting it on the home page, or
using the bookmarklet there. The home page lists the last 50 reviews you opened, with live state, CI and review
decision for PRs. `npm run dev` runs Vite with hot reload on :5173.

## Local reviews (commits, compares, local and pasted diffs)

Everything except PRs is reviewed locally: comments and viewed state never go to GitHub. They are stored as JSON in
`~/.local/state/diff-review` (`$XDG_STATE_HOME` or `$DIFF_REVIEW_STATE_DIR` override it). Any line can take a comment.
**Comments** in the top bar copies or downloads them as Markdown (file:line, the quoted code, your comment), ready to
hand to an agent. A file that changes after you marked it viewed shows "changed since viewed", and a comment whose
code changed is marked outdated (it moves with its code when it can).

```sh
diff-review                     # uncommitted changes in this repo, incl. untracked files
diff-review main...             # any git diff range: <rev>, a..b, a...b
diff-review -c HEAD             # one commit
git diff | diff-review -        # a diff from stdin; or: diff-review fix.patch
diff-review <github url>        # a PR, commit or compare
diff-review export [same args]  # print the comments as Markdown (--all includes resolved)
```

The CLI starts the server if it isn't running (log: `~/.local/state/diff-review/server.log`) and opens the browser;
`--print` prints the URL instead. A local diff refreshes on window focus, so you can keep it open while an agent works.

## Pull requests

- **Draft review:** click a line number to comment, drag or shift-click for a range, ⌘↵ adds the comment to your pending
  review. Click **Review** to submit (Comment / Approve / Request changes) or discard. GitHub only accepts line
  comments inside its own diff hunks; clicking a line outside them starts a file comment that quotes the line.
- **Conversation** (`t`): the PR description, top-level comments and review summaries. Comments posted there go out
  immediately, separately from your draft review.
- **Viewed** state syncs with GitHub. **Hide** is local: per file, folder, category or glob (Overview → Hidden rules).
  Folder, category and glob rules apply to every PR in the repo.
- **Overview** (`o`): files grouped by category and by folder, with churn, viewed progress and bulk actions.
- **CI**: the checks of the head commit, failing first; the chip polls while checks are running.
- **Syntax highlighting** (`h` toggles) runs in a web worker and never blocks scrolling.
- **The URL holds the view** (tab, focused group, filter, current file), so back/forward and links work.
  Unified/split, context and font size are preferences and stay as you set them.
- **Keys:** `j/k` files, `v` viewed + next, `x` collapse, `s` split/unified, `[ ]` context, `- =` font, `/` filter,
  `o/d/t` overview/diff/conversation, `r` refresh, `c` file comment, `z` outline, `?` help.

`npm test` runs the unit tests and `npm run typecheck` runs the type checker. Design and decisions: `docs/plan.md`.

## How it stays fast

- A cached copy of the PR (IndexedDB) paints first; the fresh one replaces it in the background.
- GitHub's patch decides what is commentable; the rest of each file comes from the head blob, fetched in batches of
  40 through GraphQL and cached.
- Diffs render in 400-row chunks that mount near the viewport and unmount far from it.

## Security

The server binds to 127.0.0.1, holds the token, and only proxies an allowlist of GitHub endpoints. It rejects
requests without its own header or with a foreign `Host`/`Origin`, so other websites can't use it. Opening a local
review runs `git diff` in that repo, the same as running it yourself.

## License

MIT
