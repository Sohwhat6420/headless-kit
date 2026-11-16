# Visuals batch 1 — review only

44 PNG images and 44 animated HTML companions using local sibling assets (keep this folder together). Four composition variants per subject. Do not merge without visual review.

## Direction and provenance

Near-black graphite isometric scenes; mint for headless-kit, cyan for Agentroid, amber for BB 5th Coy Administration Portal, coral for Claude for HMOS Lite, violet for Microkernel Harness, blue for the conceptual lane diagram. Hero uses mint as its unifying accent. No humans or characters.

PNG art was generated from plain-language briefs. The 16 Nov correction used the built-in imagegen tool on 28 images to remove generated demo panels, remove the hero border bands and correct the module-map captions. Exports retain the dimensions below. Prompts and preserved details are in [EDIT-PROMPTS.md](EDIT-PROMPTS.md).

Art is illustrative. Generated terminal/calculator redraws have been removed: they are not accurate copies of recordings. Instead the relevant HTML pages show the original demo assets separately, without redrawing their text or numbers:

- [headless-kit demo source](https://github.com/Sohwhat6420/headless-kit/blob/248b8f63d1c67ab6f2431096e78bafbf66fb24ec/tools/research/reddit-pull/docs/demo.svg): `reddit-pull-demo.svg` is a byte-for-byte copy, SHA-256 `b8e803dd35650891a63790fbc365a39724ae3a72709b6bf7ff0e748b7f5bddae`.
- [Agentroid recording source](https://github.com/Sohwhat6420/agentroid-mcp/blob/36d5e2132bf6ae46134b7b75a8b848001583c5c4/docs/media/demo-1.gif): `agentroid-demo.gif` is a byte-for-byte copy, SHA-256 `eeaaf7adb3325e95b14305d305fc412133146a8f72d84257eb535946f37cb05d`. Its first decoded frame is `agentroid-demo-still.png`, used for reduced motion. No live dashboard or new measurement is claimed.
- BB 5th Coy Administration Portal, Claude for HMOS Lite and Microkernel Harness remain abstract product scenes; their source was unavailable. No project UI or data is shown.
- Agentroid architecture explains the AI agent → MCP → local daemon (`bridged`) → adb → Android path and lease/look/tap/verify/receipt loop. It is conceptual, with Preview status, not a benchmark.
- headless-kit components belong to one kit. `focus-gate` and `lane-mailbox` are available on main; the previous absent-module captions were incorrect and have been replaced. Orchestrator/cloud/local lanes remain a conceptual workflow, not a measured deployed service.

The companions run offline with no external requests or JavaScript. Each loads its sibling PNG once instead of embedding a duplicate base64 copy, and adds CSS depth, light sweep and SVG edge flow. Reduced motion disables these effects and selects the still demo frame. The pages and demo blocks allow vertical scrolling on narrow screens. No browser was launched for this correction: playback and responsive rendering were not rechecked. The offline verification checks PNG decoding, inventory, local references, demo hashes, dimensions, border bands and delivery size.

## Files

Every created deliverable is listed, including this index. PNG sizes are physical pixels; HTML sizes are the sibling art/viewBox dimensions. Byte counts are exact.

| File | What it is | Size (px / bytes) | Variant |
| --- | --- | --- | --- |
| [profile-hero-v1.png](profile-hero-v1.png) | Ethan Soh: agent tooling and AI systems — Hero PNG | 1600×500 / 733,382 bytes | 1 — Constellation |
| [profile-hero-v1.html](profile-hero-v1.html) | Ethan Soh: agent tooling and AI systems — Hero animated offline HTML | 1600×500 / 2,857 bytes | 1 — Constellation |
| [profile-hero-v2.png](profile-hero-v2.png) | Ethan Soh: agent tooling and AI systems — Hero PNG | 1600×500 / 743,947 bytes | 2 — Exploded |
| [profile-hero-v2.html](profile-hero-v2.html) | Ethan Soh: agent tooling and AI systems — Hero animated offline HTML | 1600×500 / 2,857 bytes | 2 — Exploded |
| [profile-hero-v3.png](profile-hero-v3.png) | Ethan Soh: agent tooling and AI systems — Hero PNG | 1600×500 / 818,049 bytes | 3 — Orbit |
| [profile-hero-v3.html](profile-hero-v3.html) | Ethan Soh: agent tooling and AI systems — Hero animated offline HTML | 1600×500 / 2,857 bytes | 3 — Orbit |
| [profile-hero-v4.png](profile-hero-v4.png) | Ethan Soh: agent tooling and AI systems — Hero PNG | 1600×500 / 773,557 bytes | 4 — Cascade |
| [profile-hero-v4.html](profile-hero-v4.html) | Ethan Soh: agent tooling and AI systems — Hero animated offline HTML | 1600×500 / 2,857 bytes | 4 — Cascade |
| [cover-bb-5th-coy-v1.png](cover-bb-5th-coy-v1.png) | BB 5th Coy Administration Portal — Cover PNG | 1200×630 / 798,814 bytes | 1 — Constellation |
| [cover-bb-5th-coy-v1.html](cover-bb-5th-coy-v1.html) | BB 5th Coy Administration Portal — Cover animated offline HTML | 1200×630 / 2,217 bytes | 1 — Constellation |
| [cover-bb-5th-coy-v2.png](cover-bb-5th-coy-v2.png) | BB 5th Coy Administration Portal — Cover PNG | 1200×630 / 674,203 bytes | 2 — Exploded |
| [cover-bb-5th-coy-v2.html](cover-bb-5th-coy-v2.html) | BB 5th Coy Administration Portal — Cover animated offline HTML | 1200×630 / 2,217 bytes | 2 — Exploded |
| [cover-bb-5th-coy-v3.png](cover-bb-5th-coy-v3.png) | BB 5th Coy Administration Portal — Cover PNG | 1200×630 / 791,272 bytes | 3 — Orbit |
| [cover-bb-5th-coy-v3.html](cover-bb-5th-coy-v3.html) | BB 5th Coy Administration Portal — Cover animated offline HTML | 1200×630 / 2,217 bytes | 3 — Orbit |
| [cover-bb-5th-coy-v4.png](cover-bb-5th-coy-v4.png) | BB 5th Coy Administration Portal — Cover PNG | 1200×630 / 697,708 bytes | 4 — Cascade |
| [cover-bb-5th-coy-v4.html](cover-bb-5th-coy-v4.html) | BB 5th Coy Administration Portal — Cover animated offline HTML | 1200×630 / 2,217 bytes | 4 — Cascade |
| [cover-agentroid-v1.png](cover-agentroid-v1.png) | Agentroid — Cover PNG | 1200×630 / 696,162 bytes | 1 — Constellation |
| [cover-agentroid-v1.html](cover-agentroid-v1.html) | Agentroid — Cover animated offline HTML | 1200×630 / 2,505 bytes | 1 — Constellation |
| [cover-agentroid-v2.png](cover-agentroid-v2.png) | Agentroid — Cover PNG | 1200×630 / 741,940 bytes | 2 — Exploded |
| [cover-agentroid-v2.html](cover-agentroid-v2.html) | Agentroid — Cover animated offline HTML | 1200×630 / 2,505 bytes | 2 — Exploded |
| [cover-agentroid-v3.png](cover-agentroid-v3.png) | Agentroid — Cover PNG | 1200×630 / 847,536 bytes | 3 — Orbit |
| [cover-agentroid-v3.html](cover-agentroid-v3.html) | Agentroid — Cover animated offline HTML | 1200×630 / 2,505 bytes | 3 — Orbit |
| [cover-agentroid-v4.png](cover-agentroid-v4.png) | Agentroid — Cover PNG | 1200×630 / 730,357 bytes | 4 — Cascade |
| [cover-agentroid-v4.html](cover-agentroid-v4.html) | Agentroid — Cover animated offline HTML | 1200×630 / 2,505 bytes | 4 — Cascade |
| [cover-claude-hmos-lite-v1.png](cover-claude-hmos-lite-v1.png) | Claude for HMOS Lite — Cover PNG | 1200×630 / 691,209 bytes | 1 — Constellation |
| [cover-claude-hmos-lite-v1.html](cover-claude-hmos-lite-v1.html) | Claude for HMOS Lite — Cover animated offline HTML | 1200×630 / 2,187 bytes | 1 — Constellation |
| [cover-claude-hmos-lite-v2.png](cover-claude-hmos-lite-v2.png) | Claude for HMOS Lite — Cover PNG | 1200×630 / 710,629 bytes | 2 — Exploded |
| [cover-claude-hmos-lite-v2.html](cover-claude-hmos-lite-v2.html) | Claude for HMOS Lite — Cover animated offline HTML | 1200×630 / 2,187 bytes | 2 — Exploded |
| [cover-claude-hmos-lite-v3.png](cover-claude-hmos-lite-v3.png) | Claude for HMOS Lite — Cover PNG | 1200×630 / 707,096 bytes | 3 — Orbit |
| [cover-claude-hmos-lite-v3.html](cover-claude-hmos-lite-v3.html) | Claude for HMOS Lite — Cover animated offline HTML | 1200×630 / 2,187 bytes | 3 — Orbit |
| [cover-claude-hmos-lite-v4.png](cover-claude-hmos-lite-v4.png) | Claude for HMOS Lite — Cover PNG | 1200×630 / 762,159 bytes | 4 — Cascade |
| [cover-claude-hmos-lite-v4.html](cover-claude-hmos-lite-v4.html) | Claude for HMOS Lite — Cover animated offline HTML | 1200×630 / 2,187 bytes | 4 — Cascade |
| [cover-microkernel-harness-v1.png](cover-microkernel-harness-v1.png) | Microkernel Harness — Cover PNG | 1200×630 / 665,955 bytes | 1 — Constellation |
| [cover-microkernel-harness-v1.html](cover-microkernel-harness-v1.html) | Microkernel Harness — Cover animated offline HTML | 1200×630 / 2,187 bytes | 1 — Constellation |
| [cover-microkernel-harness-v2.png](cover-microkernel-harness-v2.png) | Microkernel Harness — Cover PNG | 1200×630 / 686,959 bytes | 2 — Exploded |
| [cover-microkernel-harness-v2.html](cover-microkernel-harness-v2.html) | Microkernel Harness — Cover animated offline HTML | 1200×630 / 2,187 bytes | 2 — Exploded |
| [cover-microkernel-harness-v3.png](cover-microkernel-harness-v3.png) | Microkernel Harness — Cover PNG | 1200×630 / 667,842 bytes | 3 — Orbit |
| [cover-microkernel-harness-v3.html](cover-microkernel-harness-v3.html) | Microkernel Harness — Cover animated offline HTML | 1200×630 / 2,187 bytes | 3 — Orbit |
| [cover-microkernel-harness-v4.png](cover-microkernel-harness-v4.png) | Microkernel Harness — Cover PNG | 1200×630 / 797,331 bytes | 4 — Cascade |
| [cover-microkernel-harness-v4.html](cover-microkernel-harness-v4.html) | Microkernel Harness — Cover animated offline HTML | 1200×630 / 2,187 bytes | 4 — Cascade |
| [cover-headless-kit-v1.png](cover-headless-kit-v1.png) | headless-kit — Cover PNG | 1200×630 / 702,919 bytes | 1 — Constellation |
| [cover-headless-kit-v1.html](cover-headless-kit-v1.html) | headless-kit — Cover animated offline HTML | 1200×630 / 2,414 bytes | 1 — Constellation |
| [cover-headless-kit-v2.png](cover-headless-kit-v2.png) | headless-kit — Cover PNG | 1200×630 / 714,684 bytes | 2 — Exploded |
| [cover-headless-kit-v2.html](cover-headless-kit-v2.html) | headless-kit — Cover animated offline HTML | 1200×630 / 2,414 bytes | 2 — Exploded |
| [cover-headless-kit-v3.png](cover-headless-kit-v3.png) | headless-kit — Cover PNG | 1200×630 / 845,836 bytes | 3 — Orbit |
| [cover-headless-kit-v3.html](cover-headless-kit-v3.html) | headless-kit — Cover animated offline HTML | 1200×630 / 2,414 bytes | 3 — Orbit |
| [cover-headless-kit-v4.png](cover-headless-kit-v4.png) | headless-kit — Cover PNG | 1200×630 / 772,994 bytes | 4 — Cascade |
| [cover-headless-kit-v4.html](cover-headless-kit-v4.html) | headless-kit — Cover animated offline HTML | 1200×630 / 2,414 bytes | 4 — Cascade |
| [social-headless-kit-v1.png](social-headless-kit-v1.png) | headless-kit — Social preview PNG | 1280×640 / 796,757 bytes | 1 — Constellation |
| [social-headless-kit-v1.html](social-headless-kit-v1.html) | headless-kit — Social preview animated offline HTML | 1280×640 / 2,424 bytes | 1 — Constellation |
| [social-headless-kit-v2.png](social-headless-kit-v2.png) | headless-kit — Social preview PNG | 1280×640 / 804,873 bytes | 2 — Exploded |
| [social-headless-kit-v2.html](social-headless-kit-v2.html) | headless-kit — Social preview animated offline HTML | 1280×640 / 2,424 bytes | 2 — Exploded |
| [social-headless-kit-v3.png](social-headless-kit-v3.png) | headless-kit — Social preview PNG | 1280×640 / 838,829 bytes | 3 — Orbit |
| [social-headless-kit-v3.html](social-headless-kit-v3.html) | headless-kit — Social preview animated offline HTML | 1280×640 / 2,424 bytes | 3 — Orbit |
| [social-headless-kit-v4.png](social-headless-kit-v4.png) | headless-kit — Social preview PNG | 1280×640 / 849,349 bytes | 4 — Cascade |
| [social-headless-kit-v4.html](social-headless-kit-v4.html) | headless-kit — Social preview animated offline HTML | 1280×640 / 2,424 bytes | 4 — Cascade |
| [social-agentroid-mcp-v1.png](social-agentroid-mcp-v1.png) | Agentroid — Social preview PNG | 1280×640 / 745,471 bytes | 1 — Constellation |
| [social-agentroid-mcp-v1.html](social-agentroid-mcp-v1.html) | Agentroid — Social preview animated offline HTML | 1280×640 / 2,519 bytes | 1 — Constellation |
| [social-agentroid-mcp-v2.png](social-agentroid-mcp-v2.png) | Agentroid — Social preview PNG | 1280×640 / 744,064 bytes | 2 — Exploded |
| [social-agentroid-mcp-v2.html](social-agentroid-mcp-v2.html) | Agentroid — Social preview animated offline HTML | 1280×640 / 2,519 bytes | 2 — Exploded |
| [social-agentroid-mcp-v3.png](social-agentroid-mcp-v3.png) | Agentroid — Social preview PNG | 1280×640 / 766,820 bytes | 3 — Orbit |
| [social-agentroid-mcp-v3.html](social-agentroid-mcp-v3.html) | Agentroid — Social preview animated offline HTML | 1280×640 / 2,519 bytes | 3 — Orbit |
| [social-agentroid-mcp-v4.png](social-agentroid-mcp-v4.png) | Agentroid — Social preview PNG | 1280×640 / 837,078 bytes | 4 — Cascade |
| [social-agentroid-mcp-v4.html](social-agentroid-mcp-v4.html) | Agentroid — Social preview animated offline HTML | 1280×640 / 2,519 bytes | 4 — Cascade |
| [architecture-agentroid-v1.png](architecture-agentroid-v1.png) | Agentroid — Architecture PNG | 1600×900 / 1,435,141 bytes | 1 — Constellation |
| [architecture-agentroid-v1.html](architecture-agentroid-v1.html) | Agentroid — Architecture animated offline HTML | 1600×900 / 2,507 bytes | 1 — Constellation |
| [architecture-agentroid-v2.png](architecture-agentroid-v2.png) | Agentroid — Architecture PNG | 1600×900 / 1,347,340 bytes | 2 — Exploded |
| [architecture-agentroid-v2.html](architecture-agentroid-v2.html) | Agentroid — Architecture animated offline HTML | 1600×900 / 2,507 bytes | 2 — Exploded |
| [architecture-agentroid-v3.png](architecture-agentroid-v3.png) | Agentroid — Architecture PNG | 1600×900 / 1,573,210 bytes | 3 — Orbit |
| [architecture-agentroid-v3.html](architecture-agentroid-v3.html) | Agentroid — Architecture animated offline HTML | 1600×900 / 2,507 bytes | 3 — Orbit |
| [architecture-agentroid-v4.png](architecture-agentroid-v4.png) | Agentroid — Architecture PNG | 1600×900 / 1,367,713 bytes | 4 — Cascade |
| [architecture-agentroid-v4.html](architecture-agentroid-v4.html) | Agentroid — Architecture animated offline HTML | 1600×900 / 2,507 bytes | 4 — Cascade |
| [architecture-headless-kit-v1.png](architecture-headless-kit-v1.png) | headless-kit — Architecture PNG | 1600×900 / 1,336,197 bytes | 1 — Constellation |
| [architecture-headless-kit-v1.html](architecture-headless-kit-v1.html) | headless-kit — Architecture animated offline HTML | 1600×900 / 2,608 bytes | 1 — Constellation |
| [architecture-headless-kit-v2.png](architecture-headless-kit-v2.png) | headless-kit — Architecture PNG | 1600×900 / 1,336,576 bytes | 2 — Exploded |
| [architecture-headless-kit-v2.html](architecture-headless-kit-v2.html) | headless-kit — Architecture animated offline HTML | 1600×900 / 2,608 bytes | 2 — Exploded |
| [architecture-headless-kit-v3.png](architecture-headless-kit-v3.png) | headless-kit — Architecture PNG | 1600×900 / 1,396,366 bytes | 3 — Orbit |
| [architecture-headless-kit-v3.html](architecture-headless-kit-v3.html) | headless-kit — Architecture animated offline HTML | 1600×900 / 2,608 bytes | 3 — Orbit |
| [architecture-headless-kit-v4.png](architecture-headless-kit-v4.png) | headless-kit — Architecture PNG | 1600×900 / 1,398,689 bytes | 4 — Cascade |
| [architecture-headless-kit-v4.html](architecture-headless-kit-v4.html) | headless-kit — Architecture animated offline HTML | 1600×900 / 2,608 bytes | 4 — Cascade |
| [architecture-orchestrator-lanes-v1.png](architecture-orchestrator-lanes-v1.png) | Orchestrator and lanes — Architecture PNG | 1600×900 / 1,378,773 bytes | 1 — Constellation |
| [architecture-orchestrator-lanes-v1.html](architecture-orchestrator-lanes-v1.html) | Orchestrator and lanes — Architecture animated offline HTML | 1600×900 / 2,197 bytes | 1 — Constellation |
| [architecture-orchestrator-lanes-v2.png](architecture-orchestrator-lanes-v2.png) | Orchestrator and lanes — Architecture PNG | 1600×900 / 1,411,344 bytes | 2 — Exploded |
| [architecture-orchestrator-lanes-v2.html](architecture-orchestrator-lanes-v2.html) | Orchestrator and lanes — Architecture animated offline HTML | 1600×900 / 2,197 bytes | 2 — Exploded |
| [architecture-orchestrator-lanes-v3.png](architecture-orchestrator-lanes-v3.png) | Orchestrator and lanes — Architecture PNG | 1600×900 / 1,428,208 bytes | 3 — Orbit |
| [architecture-orchestrator-lanes-v3.html](architecture-orchestrator-lanes-v3.html) | Orchestrator and lanes — Architecture animated offline HTML | 1600×900 / 2,197 bytes | 3 — Orbit |
| [architecture-orchestrator-lanes-v4.png](architecture-orchestrator-lanes-v4.png) | Orchestrator and lanes — Architecture PNG | 1600×900 / 1,464,268 bytes | 4 — Cascade |
| [architecture-orchestrator-lanes-v4.html](architecture-orchestrator-lanes-v4.html) | Orchestrator and lanes — Architecture animated offline HTML | 1600×900 / 2,197 bytes | 4 — Cascade |
| [INDEX.md](INDEX.md) | Complete inventory, provenance and review notes | — / 17,738 bytes | — |
| [agentroid-demo.gif](agentroid-demo.gif) | Unchanged original Agentroid README recording | — / 110,725 bytes | — |
| [agentroid-demo-still.png](agentroid-demo-still.png) | First decoded recording frame for reduced motion | — / 65,547 bytes | — |
| [reddit-pull-demo.svg](reddit-pull-demo.svg) | Unchanged original headless-kit README demo | — / 2,534 bytes | — |
| [EDIT-PROMPTS.md](EDIT-PROMPTS.md) | Raster correction prompts and export notes | — / 2,927 bytes | — |
| [verify.test.mjs](verify.test.mjs) | Offline delivery and demo regression checks | — / 6,180 bytes | — |
