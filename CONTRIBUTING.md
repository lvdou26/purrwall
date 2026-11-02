# Contributing

Purrwall is a small community project. Issues and pull requests are welcome.

- **Small fixes:** open a pull request. **Anything bigger:** open an issue
  first so the shape can be agreed before you write it.
- **Setup:** see [Run it locally](README.md#run-it-locally).
- **Before you push:** `npm run lint`, `npm test` and `npm run build` must
  pass. Changes to the data layer, the chart lifecycle or the startup path
  also run `npm run perf`.
- **UI changes:** check them in a browser at desktop and phone widths with a
  clean console, and add a screenshot to the pull request.
- **Read the invariants** in [docs/architecture.md](docs/architecture.md)
  before touching `src/lib/hl/`, `src/components/ChartCell.tsx` or `worker/`.
- **UI text comes in two languages:** add every string to both `en` and `zh`
  in `src/lib/i18n.tsx` (the type check fails if one is missing). If you don't
  write Chinese, copy the English into `zh` and say so in the pull request.
  A user-visible feature gets one bilingual entry at the top of
  `src/changelog.ts`; fixes and refactors add none.
- **English** for code, comments and commit messages.
- **No new runtime dependencies** without a strong reason (today: react,
  react-dom, lightweight-charts).
- **AI-assisted changes** are welcome when you have run them and can answer
  questions about them.
- **Merging deploys:** every push to `main` builds and deploys purrwall.xyz.

## Running your own copy

`npm run build` produces a static `dist/` that runs on any static host; the
charts need nothing else. The Cloudflare Worker adds wall sync, feedback and
the list view's trend glyphs. What a fork has to change (domains, KV
namespaces, the Worker's allowed origins, the feedback mail settings) is
listed in [docs/architecture.md](docs/architecture.md#running-your-own-deployment).
