# Perry's landing site

The page at the project's Vercel domain: a Next.js 16 app of its own, with its own `pnpm-lock.yaml`. Vercel builds it from `site/` on every push; CI's `site` job typechecks and builds it.

```sh
pnpm install
pnpm dev        # http://localhost:3000
pnpm typecheck
pnpm build && pnpm start
```

## Analytics, speed and logs

The site uses [Vercel Web Analytics](https://vercel.com/docs/analytics) and [Speed Insights](https://vercel.com/docs/speed-insights), added in `app/layout.tsx` with `<Analytics />` and `<SpeedInsights />`. Both are cookieless, so there's no cookie banner, and both send to the site's own `/_vercel/*` paths, so the page still talks only to its own origin.

**One manual step:** in the Vercel dashboard, open the project and turn on **Analytics** (Analytics tab → Enable) and **Speed Insights** (Speed Insights tab → Enable), then redeploy. Until then the scripts load but Vercel records nothing.

Where to look, in the project on vercel.com:

- **Analytics** tab: visitors, page views, referrers, countries, devices, and the custom events below. Filter by environment to leave out preview deployments.
- **Speed Insights** tab: real visitors' Core Web Vitals (LCP, INP, CLS, FCP, TTFB), by page and device.
- **Logs** tab: requests to the deployment and anything the server prints. Every page is prerendered when the site is built, so a failure there shows in the deployment's **Build Logs** (Deployments → the deployment), and the site's code prints nothing at runtime.

### Custom events

Sent with `track()` from `lib/analytics.ts`, which lists them with their properties. The Analytics tab groups by these names, so renaming one starts a new series. Vercel shows custom events on Pro and Enterprise plans.

| Event | Properties | Sent when |
| --- | --- | --- |
| `CTA click` | `cta`: `get_perry` or `see_day`; `from`: `nav`, `hero` or `close` | a Get Perry button, or See a day with Perry |
| `GitHub click` | `link`: `repo` or `install_guide` | the footer's GitHub or Install guide link |
| `Copy command` | `command`: `install` or `run`; `os`: `unix` or `windows`; `copied`: whether the clipboard took it | a Copy button in Setup |

### Outside Vercel

- `pnpm dev` loads Vercel's debug scripts, which print each page view and event to the browser console and send nothing.
- `pnpm build && pnpm start` loads the real scripts from `/_vercel/insights` and `/_vercel/speed-insights`, which only exist on Vercel. Locally they 404 and the browser console says so once each; the page works and nothing is sent.

`artifacts/site-analytics/run.ts` checks all of this end to end: `bun artifacts/site-analytics/run.ts` from the repo root.
