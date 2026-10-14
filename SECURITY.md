# Security policy

## Supported versions

Security fixes go into the latest release. Please upgrade before reporting.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through [GitHub's vulnerability reporting](https://github.com/derblub/changereel/security/advisories/new) or by email to [daniel@pushingpixels.at](mailto:daniel@pushingpixels.at).

You will get an answer within five working days. Once a fix is released, the report is credited in the changelog unless you prefer otherwise.

## What it does with your data

changereel opens the pages of the two addresses you give it, or of the two versions it builds from your repository, in a headless Chromium on the machine it runs on. The comparison sends nothing anywhere. Three things do, and only when you ask for them: `--narrate` with a model named `claude-…` sends the excerpts of the pages the model has to see to Anthropic (a model in Ollama keeps them on the machine); the GitHub Action keeps the video as an artifact of the run and the preview on a branch of your repository; `--comment` in GitLab CI uploads the video to your project. With `--base`, it runs the build and serve commands you pass, in temporary git worktrees of your repository: pass only commands you would run yourself. The screenshots, `changes.json` and the video show whatever those pages show: look at them before you publish them.
