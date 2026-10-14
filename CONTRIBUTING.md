# Contributing

Thanks for taking the time. The most useful contribution is a page the comparison gets wrong: a change it reports that is none, or one it does not see.

## Reporting a wrong result

Open an [issue](https://github.com/derblub/changereel/issues/new/choose) with:

- the command or the workflow step you ran,
- the entry of `changes.json` that is wrong, or what is missing from it,
- the two screenshots of that page from `out/shots/`, or two public addresses to compare.

If the page is not the same on every visit (a random quote, a clock, an animation that does not follow `prefers-reduced-motion`), say so: that is the hard part, and the case decides how it is handled.

## Development setup

You need Node 22 or newer and a Chromium or Chrome.

```console
$ git clone https://github.com/derblub/changereel
$ cd changereel
$ npm install
$ npm test
$ node test/run-demo.mjs
```

`node test/run-demo.mjs` compares the two sample sites in `test/site` and renders `out/changereel.mp4`. `CHROME_PATH` names the browser when it is not in a usual place. Without a browser the tests against real pages are skipped.

Before you open a pull request, run `npm test` and add an entry under "Unreleased" in `CHANGELOG.md`.

## Where things live

| File | What it does |
| --- | --- |
| `src/diff.mjs` | The comparison: rows of pixels aligned like lines of text, bands, boxes, and what counts as noise |
| `src/browser.mjs` | Full-page screenshots over the DevTools protocol: settling, layers of an app shell, `--ignore` |
| `src/routes.mjs` | Routes from a list or from the sitemaps of both sites |
| `src/versions.mjs` | Two versions of a repository in git worktrees, built and served |
| `src/cli.mjs` | The command line: options, the comparison of every route, scenes, the summary, the render |
| `src/narrate.mjs`, `src/speak.py` | A sentence per scene from a model in Ollama or at Anthropic, spoken by Piper with the time of each word |
| `src/comment.mjs`, `src/gitlab.mjs` | The comment on a GitHub pull request or a GitLab merge request, and the preview on its branch |
| `src/texts.mjs` | The words of the video in English and German |
| `video/Reel.jsx`, `video/geometry.mjs` | The video, a Remotion composition: title, one scene per change, closing card; its measures and arithmetic, tested apart |
| `action.yml` | The GitHub Action |
| `test/site/` | Two versions of a small site with six known changes, and a page that scrolls inside an element |
| `docs/demo/` | The sample site of the demo in the README, and the script that renders it |
| `docs/assets/` | Brand files. Do not edit or redraw them |

The comparison uses no model and no service. Please keep it that way: what counts as a change has to be the same on every run.
