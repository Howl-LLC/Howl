# Howl marketing site

Static marketing site (Astro) for `howlpro.com`: marketing pages are static
HTML on the apex domain; the app stays on `app.howlpro.com`.

## How content works

The site has no copy of the marketing pages. The content collection
(`src/content.config.ts`) reads the seven publish-ready pages straight from
`../docs/marketing/` at build time, so `docs/marketing/` stays the single
source of truth. Editing a page there and rebuilding is the whole publishing
workflow.

Entry ids are the frontmatter `slug` values (the glob loader uses `slug` as
the id when present), and each URL is an explicit file under `src/pages/` so
the target URLs are pinned:

| Page | URL |
|---|---|
| compare-discord.md | `/compare/discord` |
| compare-fluxer.md | `/compare/fluxer` |
| compare-stoat.md | `/compare/stoat` |
| compare-matrix.md | `/compare/matrix` |
| migrate-from-discord.md | `/docs/migrate-from-discord` |
| self-hosted-discord-alternatives.md | `/blog/self-hosted-discord-alternatives` |
| security-page.md | `/security` |

Frontmatter is validated at build time (title <= 60 chars, description <= 155,
`lastVerified` a date), so a bad edit in `docs/marketing/` fails the build
instead of publishing.

## What each page emits

- Canonical URL on `howlpro.com`, OG/Twitter meta, generated sitemap
  (`/sitemap-index.xml`, referenced from `robots.txt`).
- JSON-LD: `FAQPage` (extracted from each page's `## FAQ` section by
  `src/lib/faq.ts`), `Article` with `dateModified` from `lastVerified`,
  `BreadcrumbList` on `/docs/*`, and `Organization` + `SoftwareApplication` +
  `WebSite` on the home page. Validate with Google's Rich Results Test after
  the first deploy.

## Visual design

The site replicates the app landing page (`components/LandingPage.tsx`) 1:1:
its `LANDING_CSS` tokens (pure-black surface ladder, brand blue `#076FA0`,
CTA fill `#02385A`, oklch text/border scale, radius 12, dark only), the
Satoshi/Clash Display font faces from `app.css`, the HowlBrand nav lockup,
the veil-blur fixed nav, and the landing footer (crypto disclaimer + legal
links). The landing page is the visual source of truth — if its tokens
change, update `src/styles/global.css` to match; don't restyle here first.
Pricing plan data mirrors the landing `PricingSection` verbatim; keep them
in the same PR when prices change.

## Fonts

Clash Display and Satoshi are fetched at build time by
`scripts/fetch-fonts.mjs` (wired into `predev`/`prebuild`); they are not
committed because the ITF Free Font License has unclear redistribution terms —
the same policy the app uses. The fetch is best-effort: if Fontshare is
unreachable the build still succeeds and the CSS falls back to the system
sans-serif stack.

## Commands

```bash
npm install
npm run dev       # local dev server
npm run build     # static build to dist/
npm run preview   # serve the build locally
```

## Deploying (Cloudflare Pages)

1. Create a Pages project from this repository.
2. Root directory: `marketing-site` (the build reads `../docs/marketing`,
   which is included in the checkout).
3. Build command: `npm run build`. Output directory: `dist`.
4. Custom domain: `howlpro.com` (and `www` redirect). The app keeps
   `app.howlpro.com`.

## Remaining setup

- [ ] Confirm the domain split: `howlpro.com` = this site, `app.howlpro.com` =
      app. The app's `index.html` canonical/OG URLs already point at
      `app.howlpro.com`.
- [ ] Screenshots for the migration guide (needs a running instance).
- [ ] Verify the domain in Google Search Console + Bing Webmaster Tools and
      submit `https://howlpro.com/sitemap-index.xml`.
- [ ] Privacy-respecting analytics (Plausible/Umami) snippet in
      `src/layouts/Base.astro`.
- [ ] Optional: add a `marketing-site` build job to CI so a `docs/marketing/`
      edit that breaks frontmatter is caught on PR.
