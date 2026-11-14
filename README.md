# gh-review

A fast local UI for reviewing GitHub pull requests. It uses your `gh` login, and the token never reaches the browser.

```sh
npm install
npm start            # builds, then serves http://127.0.0.1:7777
```

Open a PR by replacing `https://github.com` with `http://127.0.0.1:7777` in its URL, or use the bookmarklet on the
home page. `npm run dev` runs Vite with hot reload on :5173.

- Draft review: click a line number to comment, shift-click for a range, ⌘↵ adds the comment to your pending review.
  Click **Review** to submit (Comment / Approve / Request changes) or discard.
  GitHub only accepts line comments inside its own diff hunks. Clicking a line outside them starts a file comment
  that quotes the line.
- Viewed state syncs with GitHub. **Hide** is local: per file, per folder, per category, or by glob (Overview →
  Hidden rules). Rules for folders, categories and globs apply to every PR in the repo.
- Overview (`o`): files grouped by category and by folder, with churn, viewed progress and bulk actions.
- Keys: `j/k` files, `v` viewed + next, `x` collapse, `s` split/unified, `[ ]` context, `- =` font, `/` filter,
  `r` refresh, `c` file comment, `?` help.

`npm test` runs the unit tests and `npm run typecheck` runs the type checker. Design and decisions: `docs/plan.md`.
