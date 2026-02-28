# Testing Checklist

## Viewer Mode Visual Regression

Use this quick checklist after any UI changes to `static/index.html`, `static/styles.css`, or `static/app.js`.

### 1) Group Viewer Mode (timeline thumbnail open)

- Open a timeline thumbnail and confirm viewer opens full screen.
- Confirm `X` close button is visible and returns to timeline.
- Confirm previous/next controls are visible and functional.
- Confirm info bars are visible (date/location/name placement is correct for landscape and portrait images).
- Double-click image and confirm details panel opens; click outside details panel and confirm it closes.
- Click overlay background and confirm viewer closes.

### 2) Vector Viewer Mode (semantic search result open)

- Open an image from semantic search results.
- Confirm `X` close button is visible.
- Confirm previous/next controls are visible and move through semantic result set.
- Confirm info bars are visible and image metadata labels render as expected.
- Double-click image and confirm details panel opens.
- Click overlay background and confirm viewer closes.

### 3) Random Viewer Mode (RANDOM tab slideshow)

- Enable random viewer from the `Random` tab and confirm slideshow starts.
- Confirm only image content is shown (no close button, no prev/next controls, no info bars, no details panel).
- Confirm image is full-bleed within viewer stage (no reserved UI padding for hidden chrome).
- Confirm double-click does not open details panel.
- Confirm clicking overlay background does not close slideshow.
- Disable random viewer toggle and confirm slideshow exits back to normal app view.

### 4) Cross-Mode Isolation Checks

- After stopping random mode, open group/vector viewer and confirm normal chrome returns.
- Open details in group/vector mode, then start random mode; confirm details panel is hidden/disabled in random mode.
- Switch between timeline and semantic results and confirm mode-specific navigation behavior remains correct.
