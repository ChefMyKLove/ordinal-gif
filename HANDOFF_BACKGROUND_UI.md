# HANDOFF: mint.html foreground still reads as washed-out/translucent after background swap

Written 2026-11-11. Repo: `C:\Users\micha\ordinal gif` (local, not pushed — `git status` shows `mint.html` modified, nothing committed). Branch `main`, clean otherwise.

**For the next agent:** read this in full before touching anything. Section 5 has the one concrete lead worth checking first. Do not repeat the CSS-alpha debugging in Section 3 — it was tried, verified server-side, and did not change the rendered result at all, which is itself the important finding.

---

## 1. What this project is

`mint.html` is the minting UI for "Rainbow Legends," a 16-piece animated-ordinal series. It's a Vite project (`npm run dev` → `https://localhost:5173/mint.html`, self-signed HTTPS via `@vitejs/plugin-basic-ssl`, required because the Yours Wallet browser extension only injects its provider on secure-context pages). The backend (separate repo, `ORDINALRAINBOWS-Vol.1`) runs via `vercel dev --listen 3000`.

## 2. The task in progress

The user asked for the minter's background to match the main site's (`ordinalrainbows.com` / repo `ORDINALRAINBOWS-Vol.1`) aesthetic: an animated crossfade of component-art photos with an SVG-turbulence "cloud warp" overlay. I ported the real, current files — `css/bg-anim.css` and `js/bg-anim.js` from `ORDINALRAINBOWS-Vol.1` (NOT the stale same-named files that sit unused at that repo's root — confirmed by checking what `index.html` actually `<link>`s/`<script>`s) — into `ordinal gif/public/css/` and `ordinal gif/public/js/`, and wired the SVG filter defs + layer markup into `mint.html`. **This part worked and looks correct** per the user's screenshots — the animated cloud background renders.

**The problem:** every foreground panel and the grid-card thumbnails now read as washed-out / translucent against the new, much busier background, to the point of being hard to read. The user asked for a fix; three rounds of CSS changes (detailed below) produced **zero visible change** in the browser across multiple hard-refreshes, a full dev-server restart, and a brand-new tab — even though the server was independently verified (via `curl`, not the browser) to be serving the new CSS correctly each time.

**That non-response to verified-correct served CSS is the actual mystery, not the CSS itself.**

## 3. What was changed (verified present in the served file, each round)

| Element | File:line (current) | Before | After | Verified server returns this? |
|---|---|---|---|---|
| `--panel` (CSS var) | `mint.html:14` | `rgba(255,255,255,0.03)` | `#14101f` (fully opaque) | Yes — `curl -sk https://localhost:5173/mint.html \| grep "#14101f"` matched |
| `.preview-glass` (big left preview overlay) | `mint.html:84` | `rgba(255,255,255,0.055)` + `backdrop-filter: blur(20px) saturate(180%) brightness(1.05)` | Reverted to original after over-darkening it by mistake (see note) — currently back to the original light/subtle values | N/A, reverted |
| `.wallet-section` | `mint.html:211` | had `backdrop-filter: blur(16px) saturate(160%)` | backdrop-filter removed entirely, background is now `var(--panel)` = opaque `#14101f` | Yes |
| `.panel` (wraps the collection grid) | `mint.html:238` | same as above | same fix as above | Yes |
| `.mint-card` | `mint.html:246` | `background: #080810` (already opaque), thin border | border strengthened to `rgba(255,255,255,0.14)`, added `box-shadow: 0 6px 20px rgba(0,0,0,0.55)` | Yes |
| `.mint-card.minted` / `.coming` | `mint.html:257-258`(approx, search for these classes) | `opacity: 0.35` / `0.22` (dims the WHOLE box incl. its own opaque background) | `0.6` / `0.55` | Yes |
| `.mc-glass` (overlay on each grid thumbnail) | `mint.html:274` | `background: rgba(255,255,255,0.045)` (a **white** tint) + `backdrop-filter: blur(10px) saturate(160%) brightness(1.04)` (brightening — wrong direction) | `background: rgba(5,4,10,0.72)` (dark), backdrop-filter removed entirely | Yes |
| `.mc-info` (bottom text strip on each card) | `mint.html:312` | no background declared at all | `background: #080810` added explicitly, belt-and-suspenders | Yes |

**Note on `.preview-glass`:** I initially darkened this the same way as the grid cards, then realized it's a fundamentally different element — it sits over the *actual live card preview* (the big rotating image with the speed/fade sliders), which the user needs to see clearly, not a competing-background problem like the small grid thumbnails. I reverted it to its original subtle/brightening values. This was a correct self-catch, not a loose end, but worth knowing it happened.

## 4. Why "zero visible change" is suspicious, not just disappointing

Between round 1 (`--panel: rgba(255,255,255,0.03)`, nearly invisible) and round 3 (`--panel: #14101f`, fully opaque solid dark purple-black, zero alpha, zero backdrop-filter anywhere in the `.wallet-section`/`.panel` chain), the **rendered screenshot is pixel-indistinguishable** — same light, translucent, sky-colored wash behind "ORDINAL RAINBOWS" text, across three separate screenshots taken after three separate rounds of real, server-verified CSS changes, including a full dev-server restart and a brand-new browser tab in between.

If the browser were rendering the CSS the server is serving, the left panel background would visibly be a solid dark box by round 3. It is not. This means the browser is very likely **not applying the page's own CSS at all** for this visual effect, or something is layered on top of the rendered page that these CSS edits can't reach.

## 5. The one lead worth checking first

**A color/theme/dark-mode browser extension overriding page rendering.** The user's Chrome toolbar (visible in every screenshot) has a large number of extension icons. Extensions like Dark Reader, or any accessibility/color-filter/night-mode extension, apply a filter or recoloring pass on top of the fully-rendered page — which would:
- Explain identical visual output across genuinely different underlying CSS (the extension's filter dominates regardless of source colors)
- Explain why a hard refresh / new tab / server restart changed nothing (the extension re-applies its filter to whatever loads, every time)
- Produce exactly this "soft, washed, everything looks slightly translucent/pastel" look

**How to check:** in the browser, disable extensions one at a time (or open the page in Incognito with extensions off, or in a completely different browser — Edge, Firefox) and reload. If the panels suddenly look correctly opaque/dark, that's the answer, and the fix is a user-side browser setting (disable the extension for `localhost`), not more CSS.

If that's not it, next things to check, in order:
1. **DevTools → Elements → inspect `.wallet-section` directly**, check the *computed* `background-color` value. If it shows `rgb(20, 16, 31)` (= `#14101f`) but the page still looks washed out, the CSS is applying and something else (a filter, an overlay, mix-blend-mode from an ancestor) is the culprit — check every ancestor element up to `<html>` for `filter`, `mix-blend-mode`, or `opacity` in DevTools, not just in the source file (computed styles can differ from source due to inheritance/cascade surprises I can't see without a live inspector).
2. **DevTools → Network tab**, hard-reload, check whether `mint.html` shows a `200` or a `304`/`(disk cache)` for this specific load — rule out a caching layer my `curl` checks (which have no cookies/cache/extensions) can't see.
3. Check whether `.cloud-layer` (the new animated background, `z-index: 1`) is somehow stacking **above** the content instead of behind it — inspect z-index/stacking context computed values for `.wallet-section`/`.panel` (they should be implicitly above z-index 1 by DOM order, but if a `transform` or other property on an ancestor created an unexpected stacking context, order could be wrong). I could not verify this without a live browser.

## 6. Known-good, don't re-touch

- The background animation itself (`public/css/bg-anim.css`, `public/js/bg-anim.js`, the SVG filter defs + layer markup near the top of `mint.html`'s `<body>`) — confirmed working correctly by the user's own screenshots.
- `js/bubble-physics.js` idle-drift frequency halved (separate, unrelated task, done and not revisited) — in the **other** repo, `ORDINALRAINBOWS-Vol.1`.
- `api/mint-complete.js` retry/backoff fix for the reward-crediting race — also in `ORDINALRAINBOWS-Vol.1`, unrelated to this UI issue, done.

## 7. Open questions only the user can answer

1. Which extensions are installed/enabled on the Chrome profile being used to test? (Screenshot shows many icons; can't identify them from a screenshot alone.)
2. Does the same washed-out look appear in a different browser (Edge/Firefox) or Incognito window with extensions disabled?
3. Has this same translucent/washed look ever appeared on any OTHER page in this browser profile (a prior symptom would confirm it's profile-wide, not page-specific)?

---

## Paste this first

```text
Read HANDOFF_BACKGROUND_UI.md in full before doing anything. The core finding: three rounds of CSS fixes were server-verified correct (via curl) but produced zero visible change in the browser across hard-refreshes, a dev-server restart, and a new tab — meaning the browser is very likely not applying this page's own CSS for the visual effect in question, most likely because of a browser extension (Dark Reader or similar) recoloring the rendered page. Check Section 5 first: have the user disable extensions / try Incognito / try a different browser before touching any more CSS. Do not repeat the CSS-opacity debugging already done in Section 3 without first ruling out Section 5's hypothesis — re-deriving it wastes a cycle the first agent already spent.
```
