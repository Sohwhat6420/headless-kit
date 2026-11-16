# Raster corrections, 16 Nov 2026

Tool: built-in imagegen, edit mode, one original PNG per call and per variant.
Only the 28 images with demo redraws needed raster corrections. The other 16
images are unchanged. FFmpeg exports normalise the generated results to the
existing PNG dimensions using Lanczos scaling, RGB and PNG compression level 9.
No generated file paths or metadata are needed to view the deliverables.

Each edit asked to preserve the original title, exact project spelling, graphite
palette, accent colour, variant composition, hardware modules and connections.
The shared constraint was no new tiny text, demo output or measurements. The
following prompt instructions were applied separately to variants 1–4:

- Profile hero: remove terminal/calculator demo panels, fill with matching dark
  background or mint constellation lines. Where a screen sits on a product
  plinth, replace it with an Android icon or abstract mint module. Remove white
  border strips and extend the dark background to every edge. Preserve the large
  title and all five project labels. Target 1600 × 500.
- headless-kit cover: remove terminal demo output and its panel. Fill empty space
  with dark background; on a platform replace it with an abstract tile bearing
  only a mint `>_` symbol. Preserve `headless-kit` and `Agent-first tools.`.
  Target 1200 × 630.
- headless-kit social: replace the terminal screen with a clean graphite display
  bearing only a mint `>_` icon. Preserve title, repository label, platforms and
  other module icons. Target 1280 × 640.
- headless-kit architecture: remove the terminal panel and old absent-module
  caption. Use exactly: “Illustrative module map. All four tools are available.”
  Preserve detached-run, reddit-pull, focus-gate, lane-mailbox, headless-kit and
  ONE KIT. Target 1600 × 900.
- Agentroid cover: replace the framed demo panel with an abstract graphite display
  bearing only a cyan `>_` icon. Replace calculator phone screens with an Android
  icon. Preserve Agentroid, AI agent, Preview status, local daemon and Android
  labels. Target 1200 × 630.
- Agentroid social: remove the framed demo inset and fill with dark background;
  replace calculator phone screens with an Android icon. Preserve Android Phone,
  Local Daemon and AI Agent labels and any existing repository label.
  Target 1280 × 640.
- Agentroid architecture: remove the framed Real Demo or Phone / Terminal Demo
  inset, including its heading, and fill with dark background. Replace calculator
  phone screens with an Android icon. Preserve the architecture chain, safety
  boundary, Preview badge and lease/look/tap/verify/receipt loop. Target 1600 × 900.

The original demo files are shown separately in the relevant HTML pages, with
source links and hashes in INDEX. They were copied unchanged; the reduced-motion
PNG is the first decoded frame of the original GIF, exported by FFmpeg.
