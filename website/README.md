# Website

`website/` is the standalone landing site for VA Auto-Pilot.

Features:

- bilingual switch (EN / 中文)
- interactive state machine
- animated execution demo
- generic CLI agent install commands plus Codex and Claude Code examples
- SEO + OG metadata

## Repository Metadata

`website/index.html` uses these meta tags:

```html
<meta name="github-owner" content="Vadaski" />
<meta name="github-repo" content="va-auto-pilot" />
<meta name="github-branch" content="main" />
```

The site derives all install links from these values.

## Local Preview

```bash
cd website
python3 -m http.server 4173
# open http://localhost:4173
```

## Deployment

GitHub Actions workflow: `.github/workflows/deploy-website.yml`

When `main` updates `website/**`, deployment runs automatically.
