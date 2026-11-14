# gh-review

A fast local UI for reviewing GitHub pull requests. It uses your `gh` login, and the token never leaves the local
server.

```sh
npm install
npm start            # builds, then serves http://127.0.0.1:7777
```

Requires Node 24+ and an authenticated [GitHub CLI](https://cli.github.com/) (`gh auth login`). Open a PR by replacing
`https://github.com` with `http://127.0.0.1:7777` in its URL, pasting it on the home page, or using the bookmarklet
there. The home page lists the last 50 PRs you opened, with their live state, CI and review decision.
`npm run dev` runs Vite with hot reload on :5173.

- **Draft review:** click a line number to comment, shift-click for a range, ⌘↵ adds the comment to your pending
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
  `o/d/t` overview/diff/conversation, `r` refresh, `c` file comment, `?` help.

`npm test` runs the unit tests and `npm run typecheck` runs the type checker. Design and decisions: `docs/plan.md`.

## How it stays fast

- A cached copy of the PR (IndexedDB) paints first; the fresh one replaces it in the background.
- GitHub's patch decides what is commentable; the rest of each file comes from the head blob, fetched in batches of
  40 through GraphQL and cached.
- Diffs render in 400-row chunks that mount near the viewport and unmount far from it.

## Security

The server binds to 127.0.0.1, holds the token, and only proxies an allowlist of GitHub endpoints. It rejects
requests without its own header or with a foreign `Host`/`Origin`, so other websites can't use it.

## License

MIT
