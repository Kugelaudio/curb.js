# Curb website

The site for **curbjs.com**: a landing page and the docs, built with Astro. The docs come from the
Curb agent guide at `packages/public/curb/packages/framework/docs/agent-guide/`, so editing a guide
page updates them, and the landing page reads its example requests from the same guide. No cookies
and no analytics. A small script adds tabs and copy buttons; without it every panel stays visible.

**It is not deployed.** The domain has no DNS record for it, and there is no deploy workflow.

| Path | What it holds |
|---|---|
| `src/pages/index.astro` | The landing page, the only text this site writes itself besides the prompt below |
| `src/agent-prompt.ts` | The prompt the hero's button copies for coding agents. A test checks its URLs, commands and Node version against the repository |
| `src/guide.ts` | The one table of pages in reading order, with each page's group and description. A test fails when a guide page is missing from it |
| `src/search-index.ts`, `src/pages/search-index.json.ts`, `src/scripts/search.ts` | Docs search: an index built from the guide, and a dialog opened with `/` or Cmd+K |
| `public/sidebar.js` | Keeps the sidebar's open sections and scroll position from page to page, for the tab's session. Blocking, so it runs before the first paint |
| `src/guide-links.ts` | Rewrites `./tools.md#keys` to `/docs/tools/#keys` |
| `src/requests.ts` | Reads the example requests from the guide, and fails the build when they are gone |
| `src/code-theme.ts` | Code colours as classes, because the CSP refuses inline styles |
| `src/pages/docs/[...page].astro` | Every guide page as HTML, plus the changelog from `CHANGELOG.md` beside `website/`, when the repository has one |
| `src/pages/docs/[page].md.ts` | Every guide page as Markdown, at `/docs/<page>.md` |
| `src/pages/llms.txt.ts`, `llms-full.txt.ts` | The index and the whole guide for agents |
| `public/preview.webp` | A real `curb dev` preview of a small insurance agent, matching the demo on the page, in the site's dark colours (the app's colour tokens overridden for the shot; the app itself is light). A scripted test model and an invented company stand in for a real call; replace it before launch |
| `src/layouts/Base.astro` | The page shell, with the CSP as a meta tag because GitHub Pages sends no custom headers |

## Run, build, test

```bash
cd website
npm ci
npm run dev
npm test && npm run check && npm run build
```

It stays outside the npm workspaces, so it has its own lockfile.

## Go live

Nothing below has been done. `.github/workflows/pages.yml` builds this directory with Node 24
(`npm ci`, `npm run build`) and publishes `dist/`.

1. In the repository settings, set **Pages > Source** to **GitHub Actions**.
2. Set **Pages > Custom domain** to `curbjs.com` and add its DNS record. The build has no base path,
   so the `*.github.io` URL shows unstyled pages until the domain works.
3. Links from the guide to `docs.kugelaudio.com/hosted-agents/*` need that release open, or they
   answer 404 for anonymous readers.
