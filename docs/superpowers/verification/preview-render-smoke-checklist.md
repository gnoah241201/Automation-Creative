# Preview vs Render Smoke Checklist

This checklist covers the remaining verification item that is best validated manually or with a future browser-based integration test.

## Goal

Confirm that preview state and rendered output still match after reset behavior changes.

## Steps

1. Start the frontend and backend locally
2. Load a foreground video and optional logo/button assets
3. Move logo and button away from their defaults
4. Press `Reset Logo` and `Reset Button`
5. Confirm the preview returns to the canonical default position and size
6. Queue one render job after reset
7. Download the result and visually compare logo/button placement and sizing against the preview

## Expected Result

- Preview resets immediately to the default layout
- Rendered output matches the reset preview for logo position, button position, and relative sizing

## Why This Is Manual

The current repository does not include browser automation or image-diff infrastructure. The logic-heavy parts are covered by automated tests in this PR, while this visual parity check remains an explicit smoke test.
