# How reddit-pull got here

| Date | What happened |
| --- | --- |
| 2 Nov 2026 | **First version** (the original commit in this repo's history). I needed to research Reddit from a laptop where `reddit.com` was blocked for the fetch tools and browsers an AI agent can use, and `reddit.com/*.json` returned `403` to `curl`. [Arctic Shift](https://github.com/ArthurHeitmann/arctic_shift) answered plain HTTPS. The script was written, then used to pull r/hackios in full (262 posts, 1,842 comments) in under 5 minutes. |
| 2 to 3 Nov 2026 | Used for a research pass over several subreddits (agents, Android, OS ports, design, a TV project). Findings on what the archive can and cannot do went into the header comment: `title`/`body` search times out on large subreddits and there is no site-wide search, so pull a date window and filter locally; `api.pullpush.io` returned `522` and was dropped as a fallback. |
| 7 Nov 2026 | **Publishing pass.** The script became an importable module with an offline test suite; stdout became one JSON line (headless-kit's rule); `429`/`X-RateLimit-Reset` is honoured; results are de-duplicated by id; failures are counted and reported instead of silently returning nothing; `--api-base` and `REDDIT_PULL_UA` were added. |

Only that one commit existed before the publishing pass because the tool was written in a single sitting inside a larger research folder. Its message was shortened for this repo; the date and authorship are as they were.
