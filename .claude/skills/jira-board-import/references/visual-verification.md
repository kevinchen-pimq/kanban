# Verifying the board visually

Chromium in this container cannot reach external hosts, so a screenshot of the
production URL will hang on「載入中」. To actually see the board:

1. Start a local anonymous Convex deployment:
   `CONVEX_AGENT_MODE=anonymous npx convex dev`
2. Import the same payload there.
3. Build and screenshot `vite preview`.

Say plainly that the screenshot is of an identical build against local data,
not of production.

One harness caveat: Playwright scrolls an element into view before clicking
it, which moves the scroll container first. If you are testing scroll
behaviour, click via `el.click()` inside `page.evaluate` so the viewport stays
put — otherwise you will "discover" a scroll-position bug that is entirely
your test's doing.
