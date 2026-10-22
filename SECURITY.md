# Security policy

## Supported versions

Security fixes go into the latest release. Please upgrade before reporting.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through [GitHub's vulnerability reporting](https://github.com/derblub/changereel/security/advisories/new) or by email to [daniel@pushingpixels.at](mailto:daniel@pushingpixels.at).

You will get an answer within five working days. Once a fix is released, the report is credited in the changelog unless you prefer otherwise.

## What it does with your data

changereel opens the pages of the two addresses you give it, or of the two versions it builds from your repository, in a headless Chromium on the machine it runs on. The comparison sends nothing anywhere. Three things do, and only when you ask for them: `--narrate` with a model named `claude-…` sends the excerpts of the pages the model has to see to Anthropic (a model in Ollama keeps them on the machine); the GitHub Action keeps the video as an artifact of the run and the preview on a branch of your repository; `--comment` in GitLab CI uploads the video to your project. With `--base`, it runs the build and serve commands you pass, in temporary git worktrees of your repository: pass only commands you would run yourself. The screenshots, `changes.json` and the video show whatever those pages show: look at them before you publish them.

## What a states file adds

A states file (`--states`) takes changereel behind a login and behind clicks. Everything it reaches there is treated like any other page: it is in the screenshots, `changes.json` and the video, and so in the artifact of a GitHub Action run, in the preview on the branch `changereel-previews`, in the video that `--comment` uploads in GitLab, and in the `out` directory on disk. In a public repository, whoever can read the repository can read the artifact and the preview. Use a test account with test data, and look at what the pages show before you publish them. When a login stops on one version, the page where it stopped is kept as a picture as well.

With `--narrate` and a model named `claude-…`, the excerpts of those pages go to Anthropic as before. The model is also told the name of each state, its route and what its steps do in words (`click button "Checkout"`), but not what any `fill` types.

Passwords and tokens belong in the environment, named in the file by `valueFrom`. changereel types such a value into the field in the browser on its own machine and writes it nowhere else: not in the log, `changes.json`, the summary of the job, the comment, the video or the text for a model. A step is shown as `fill label "Password" from $CHANGEREEL_PASSWORD`. Two things stay with you. A page can show what was typed into it, such as an address left in a field or a name in the header, and then it is in the screenshot. And the variables are in the environment of the whole run, so the build and serve commands you pass can read them. A `value` in the file, unlike a `valueFrom`, is not secret: a `fill` that stops is described with it, in the log, `changes.json`, the video and the comment.

GitHub gives a pull request from a fork no secrets. A variable that is not set stops the run before anything is built, with a message that names the variable and never a value. The README shows how to skip the step for forks.
