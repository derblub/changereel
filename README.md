<div align="center">

<a href="https://pushingpixels.at">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
    <img src="docs/assets/logo.svg" alt="Pushing Pixels" width="96">
  </picture>
</a>

<h1>changereel</h1>

<p><strong>Find what a change did to the pages of a site and show it as a before and after video.</strong></p>

<p>
  <a href="https://github.com/derblub/changereel/actions/workflows/ci.yml"><img src="https://github.com/derblub/changereel/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
</p>

<p>
  <a href="#how-it-finds-a-change">How it works</a> ·
  <a href="#what-it-leaves-out-so-that-a-change-is-a-change">What it leaves out</a> ·
  <a href="#behind-a-click-or-a-login">Clicks and logins</a> ·
  <a href="#in-a-pull-request">GitHub Action</a> ·
  <a href="#in-a-merge-request-on-gitlab">GitLab</a> ·
  <a href="#on-the-command-line">Command line</a> ·
  <a href="#with-a-voice">Voice</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

</div>

---

<p align="center">
  <img src="docs/assets/demo.gif" alt="A video made by changereel for a sample coffee roastery: for each of five changes the page scrolls to the place, the camera moves closer, the change happens on the page while a mark moves from the old place to the new one, and a sentence says what changed" width="820">
</p>

<p align="center"><sub>Two versions of a sample site, compared (<a href="docs/demo">docs/demo</a>). <a href="https://github.com/derblub/changereel/releases/download/v0.8.1/changereel-demo.mp4">The same video with its voice</a>.</sub></p>

A pull request says what changed in the code. What changed on the screen, the reviewer has to find by clicking through a preview. **changereel** opens every page of the site before and after the change, works out where the two differ and renders a short video that looks like a screen recording: the page scrolls to the place, the camera moves closer, a frame is drawn around what is different, and the change happens as it would on the page. A new section opens and pushes what is below it down, a link put into a menu makes the others move aside, and a place that changed is wiped over. Each scene shows its one change; other changes on the same page wait for their own scene.

```console
changereel --base main --build "npm ci && npm run build" --serve "npm run preview -- --port {port}"
```

It runs on your machine. No account and no service: the comparison is arithmetic on screenshots. A model is only asked when you want a [sentence and a voice](#with-a-voice) for every change, and that model can be a local one.

## How it finds a change

A page is compared like a text file whose lines are its rows of pixels. A section that was added pushes everything below it down, and a pixel by pixel comparison would call all of that changed. Aligning the rows first tells "this band is new" from "this band moved":

| Kind | Means |
| --- | --- |
| **Added** | Rows that exist only after the change: a new section, or a whole new page. |
| **Removed** | Rows that exist only before it. |
| **Changed** | Rows at the same place on both sides whose pixels differ. The video frames the pixels, not the full width. Where something was put into a row of things or taken out, such as a link in a menu, the things are aligned too: what only moved aside is not framed. |

Blank rows match anywhere, so bands are judged by their other rows, and more or less white space alone is not reported. A change that is the same on several pages, such as a new link in the header, is one scene that says on how many pages it is.

## What it leaves out, so that a change is a change

A real page is not the same picture on every visit. Compared with itself, the site this was tried on first reported 8 changes on 6 pages. The steps below bring that down to 6, not to zero: a testimonial picked at random still gets through on some runs.

- **It waits until the page has settled.** Parts that load when the browser is idle arrive after the load event. A page is captured when its markup and its heights have stopped moving.
- **It visits every page more than once.** What differs between two visits of the same version, such as a random testimonial, is left out on both sides, together with what sits right next to it. A page on which it finds a change is visited twice more on both sides: a part that is random can look the same twice by chance, and shows as what it is on another visit.
- **It does not draw frames.** A captcha, a map or a video player belongs to someone else and loads in another state each time. Frames keep their place and stay empty.
- **It compares an app shell and its content apart.** On a page that scrolls inside an element, next to a sidebar that stays, the window is made taller to show all of the content, and the sidebar is compared as the window shows it. Stretched to the height of the content, it would differ whenever the content got longer.
- **It ignores a handful of pixels.** A hairline that rendered one shade off is not shown; a changed digit is.

The price is that a change that lies mostly inside or right next to an unstable part is not seen. `--passes` and `--noise-margin` move the line between a false alarm and a missed change.

What you know to be random, name with `--ignore`. On the site this was tried on, two selectors (a testimonial picked at random, a logo whose gradient starts at a random point) took the comparison of a version with itself from 6 changes to none, and the comparison of two real versions to 14 changes, each of them one the commit had made.

## Behind a click or a login

Some of what a change does only shows after a click: a dialog, a menu, the second tab of a form, everything behind a login. Name these states in a file, and changereel reaches each on both versions and compares it like a page:

```json
{
  "$schema": "https://unpkg.com/changereel@0.9/schema/states.schema.json",
  "schemaVersion": 1,
  "setup": [
    { "action": "navigate", "path": "/login" },
    { "action": "fill", "target": { "label": "Email" }, "valueFrom": { "env": "CHANGEREEL_USER" } },
    { "action": "fill", "target": { "label": "Password" }, "valueFrom": { "env": "CHANGEREEL_PASSWORD" } },
    { "action": "press", "key": "Enter" },
    { "action": "waitFor", "target": { "role": "button", "name": "Log out" } }
  ],
  "states": [
    {
      "name": "Checkout dialog",
      "route": "/cart",
      "steps": [
        { "action": "click", "target": { "role": "button", "name": "Checkout" } },
        { "action": "waitFor", "target": { "role": "dialog", "name": "Checkout" } }
      ]
    }
  ]
}
```

```console
changereel --base main --build "npm ci && npm run build" --serve "npm run preview -- --port {port}" --states changereel.states.json
```

`setup` runs once on each version, before anything is captured, and every page and state is then seen logged in. Each state starts from its `route` and ends with a `waitFor` on what should be in the picture. The route does not have to be among the routes compared. With a states file a site needs no sitemap: then only the states and the `--routes` you name are compared.

A step is one of these. Each takes a `timeout` in milliseconds of its own; the file can set one for all steps at its top (10000 if it does not).

| Step | Fields | What it does |
| --- | --- | --- |
| `navigate` | `path` | Loads the path on the version being run. Stops on a network error or an HTTP status of 400 or more. |
| `click` | `target` | Clicks the middle of the element with the mouse, once it is visible, enabled, no longer moving and not covered by something else. |
| `fill` | `target`, `value` or `valueFrom` | Types the text into the field, replacing what was in it. |
| `press` | `key`, optional `target` | Presses a key such as `Enter`, `Tab`, `Shift+Tab` or `a`, with the target focused first when there is one. |
| `waitFor` | `target`, optional `state` | Waits until the target is visible, or with `"state": "hidden"` until it is gone. |

A target is found the way a person finds it: `{ "role": "button", "name": "Save" }` as a screen reader sees the element, `{ "label": "Email" }` for a form field, or `{ "testId": "save" }` for its `data-testid` (`testIdAttribute` at the top of the file names another attribute). A CSS selector, `{ "css": ".save" }`, works too, but breaks more easily when the markup changes, and both versions have to find the same element. Names are compared exactly and with case, after the whitespace is tidied. A target that finds more than one visible element stops the step (`found 2; add nth to pick one`): give `nth`, counted from 0. If the head adds a second "Save" button, the state does not quietly click another one. A `confirm()`, `alert()` or `prompt()` of the page is accepted, and the log says so.

The same steps run on both versions. If a step works on one and not on the other, that is shown as what the change did, like a page that was added or removed: the state **can no longer be reached**, or **can be reached now**, with the step that stopped and why (`not found`, `not visible`, `covered by div.cookie-banner`). A stop on one version only is run again on both, `--confirm` times, and counts only if it happens every time at the same step. A way to the state that comes and goes is left out and listed under **Not compared**, as is a state that stops on both versions: that says the file does not fit the site. The rest of the run is done and written first. Then the command ends with exit code 2.

A `setup` that stops on one version only is the one finding: **The login no longer gets through**, or **gets through only now**, with the step and the page where it stopped. Nothing else is compared then, because every page would differ only by the login. The login is run again from its first step, `--confirm` times, before it counts as stopped. When it stops on both versions there is nothing to compare: the run ends with exit code 2 and says where each stopped.

Passwords never go in the file. `fill` takes `valueFrom` with the name of an environment variable, and changereel writes that value nowhere. In the action, pass the variables in `env` of the step, from secrets. GitHub gives a pull request from a fork no secrets, and a variable that is not set stops the run, so the step is skipped for forks:

```yaml
- uses: derblub/changereel@v0
  if: github.event.pull_request.head.repo.full_name == github.repository # forks get no secrets
  with:
    build: npm ci && npm run build
    serve: npm run preview -- --port {port}
    states: changereel.states.json
  env:
    CHANGEREEL_USER: ${{ secrets.DEMO_USER }}
    CHANGEREEL_PASSWORD: ${{ secrets.DEMO_PASSWORD }}
```

`changereel --states changereel.states.json --check` checks the file without a browser and says where it is wrong, such as `states[0].steps[1].target`. It exits with 0 when the file is right and 2 when it is not. The variables that `valueFrom` names have to be set for it too; the message names one that is missing, never a value. A `css` selector the browser cannot read is only found when a run starts, before the first page. When the file names the `$schema`, your editor checks it as you write.

In `changes.json` a state is an entry of `pages` with a `state` (its `name` and number of `steps`). One that stopped has the type `unreached` or `reached` and a `stopped` with the `side`, the `step`, its `path` in the file (`states[1].steps[0]`), what it `does` and the `reason`. A login that stopped is an entry with `setup: true`. `checked` counts the states, `checkedStates` says how many of them there were, and `problems` lists those that were not compared, with what each side said.

Good to know:

- Use a test account with test data. What is behind the login ends up in the screenshots, the video, the artifact and, for a public repository, the preview in the comment. With `--narrate`, excerpts of the pages go to the model. See [SECURITY.md](SECURITY.md).
- Each visit reaches the state anew, and a page is visited `--passes` times and again when it shows a change. Steps that change data on the server (an order, a message) change it every time, so keep the steps to what only looks.
- A `value` in the file is not secret: a `fill` that stops is described with it, in the log, the report and the video. Use `valueFrom` for anything that is.
- When both versions talk to the same backend, a change the steps make on one shows on the other.
- The steps run on every visit, so a state takes longer than a page. The log ends with how long the states took.

## In a pull request

The action builds and serves the base of the pull request and its head, compares them and renders the video. The pull request gets a comment with a moving preview of the video, what changed on which page, and a link to the video itself; a later run changes that comment instead of adding one. GitHub shows no video in a comment, so the preview is a small animated picture, kept on a branch of its own (`changereel-previews`); in a private repository the comment has the link only. A pull request that changes no page gets no comment.

```yaml
name: What changed
on:
  pull_request:
    # "closed" only takes the previews of the pull request off their branch
    types: [opened, synchronize, reopened, closed]

jobs:
  changereel:
    runs-on: ubuntu-latest
    permissions:
      contents: write # for the preview on its branch
      pull-requests: write # for the comment
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # the base commit has to be there
      - uses: derblub/changereel@v0
        with:
          build: npm ci && npm run build
          serve: npm run preview -- --port {port}
          ignore: .testimonial, .hero-video
```

| Input | Default | Description |
| --- | --- | --- |
| `serve` | | Command that serves one version; `{port}` is replaced by the port to listen on. Required. |
| `build` | | Command that builds one version, run in each of the two checkouts. |
| `base` | base of the pull request | Commit, branch or tag to compare with. |
| `head` | `HEAD` | Commit to show as the version after the change. |
| `routes` | | Paths to compare. Empty reads them from the sitemaps of both versions. |
| `ignore` | | CSS selectors, separated by commas, of parts to leave out of the comparison. |
| `states` | | Path to a [states file](#behind-a-click-or-a-login), relative to the repository. Empty compares only pages. Passwords go in `env` of the step. |
| `title` | title of the pull request | Title on the first card. |
| `video` | `true` | `false` only compares. |
| `passes` | `2` | How often each page is captured. |
| `max-scenes` | `8` | Scenes in the video. |
| `ready-timeout` | `120` | Seconds to wait for a served version to answer. |
| `narrate` | | Model that says in one sentence what each change is, such as `claude-opus-5-5`. See [below](#with-a-voice). |
| `anthropic-api-key` | | Key for that model, from a secret. |
| `voice` | | Piper voice that speaks the sentences, such as `en_US-lessac-medium`. Empty shows them as captions. |
| `language` | `en` | Language of the sentences and of the words in the video: `en` or `de`. |
| `upload` | `true` | Keep the video as an artifact of the run. |
| `artifact-name` | `changereel` | Name of that artifact; each use of the action in one run needs its own. |
| `preview` | `true` | A moving preview in the comment, kept on the branch `changereel-previews`. |
| `comment` | `true` | Comment on the pull request. |
| `github-token` | `github.token` | Token for the comment. |

| Output | Description |
| --- | --- |
| `changes`, `pages` | Number of visible changes, and of pages that have one. |
| `video` | Path to the video. Empty when nothing changed. |
| `report` | Path to `changes.json`. |
| `video-url` | Address of the artifact with the video. |

Each version is built in its own git worktree, so two installs and two builds run in the job. The first render downloads the browser Remotion renders with, about 100 MB.

## In a merge request on GitLab

In GitLab CI the command line does the same, and `--comment` writes the comment on the merge request. GitLab plays a video in a comment, so the comment holds the video itself, with its sound when it has a voice, and no preview is needed; that works in a private project as well.

```yaml
changereel:
  stage: test
  image: node:24-bookworm
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_DEPTH: 0 # the base commit has to be there
  before_script:
    - apt-get update && apt-get install -y --no-install-recommends chromium
  script:
    - npx changereel --base "$CI_MERGE_REQUEST_DIFF_BASE_SHA" --build "npm ci && npm run build" --serve "npm run preview -- --port {port}" --comment
  artifacts:
    paths: [out/]
    expire_in: 2 weeks
```

The comment needs a token that may write one: a project access token with the scope `api` and at least the role Reporter, as the CI/CD variable `CHANGEREEL_GITLAB_TOKEN` (masked). The token of the job itself may not comment. Without the variable the job still compares and keeps the video as an artifact.

## On the command line

It needs Node 22 or newer and a Chrome or Chromium. Run it without installing:

```console
npx changereel --help
```

Or add it to a project with `npm install --save-dev changereel`.

From a repository, with the versions built and served for you:

```console
changereel --base main --build "npm ci && npm run build" --serve "npm run preview -- --port {port}"
```

Or between two sites that are already running, such as the live site and a local build:

```console
changereel --before https://example.com --after http://localhost:3000
```

| Option | Default | Description |
| --- | --- | --- |
| `--base` | | Commit, branch or tag to build and serve as the version before. Needs `--serve`. |
| `--head` | `HEAD` | Commit to build and serve as the version after. Uncommitted changes are not part of it. |
| `--build` | | Command that builds a version, run in each checkout. |
| `--serve` | | Command that serves a version on `{port}`. |
| `--before`, `--after` | | Instead of `--base`: addresses of two running sites. |
| `--ready-timeout` | `120` | Seconds to wait for a served version to answer. |
| `--routes` | | Paths to compare, separated by spaces. Empty reads them from the sitemaps of both sites. |
| `--sitemap` | | URL or file of one sitemap to read the routes from instead. |
| `--ignore` | | CSS selectors, separated by commas, of parts to leave out of the comparison: a random testimonial, an animated logo. They stay in the video. |
| `--states` | | A file of states to reach with clicks or a login, and compare as well. See [Behind a click or a login](#behind-a-click-or-a-login). |
| `--check` | | With `--states`: only check the file and say where it is wrong. Needs no sites and no browser. |
| `--out` | `out` | Directory for the screenshots, `changes.json` and `changereel.mp4`. |
| `--title` | `What changed` | Title on the first card. |
| `--before-label`, `--after-label` | | Names for the two versions on the first card, such as a branch. Default: the commit or the host. |
| `--width` | `1280` | Width of the browser window. |
| `--wait` | `500` | Milliseconds to wait after a page has loaded, before it is watched until it has settled. |
| `--passes` | `2` | How often each page is captured. More visits find more of what is not stable. |
| `--confirm` | `2` | How often both sides of a page are visited again before a change on it counts. |
| `--noise-margin` | `64` | Rows above and below an unstable part that count as part of it. |
| `--per-route` | `2` | Scenes per page, largest change first. |
| `--max-scenes` | `8` | Scenes in the video. |
| `--no-video` | | Only compare and write `changes.json`. |
| `--preview` | | A small animated picture of the video as well, `changereel.gif`. |
| `--comment` | | In GitLab CI for a merge request: the comment on it. See [above](#in-a-merge-request-on-gitlab). |
| `--narrate` | | Let a model say in one sentence what each change is. |
| `--model` | `gemma3:4b` | The model that writes the sentences: one in Ollama that reads pictures, or `claude-…` at Anthropic. |
| `--ollama` | `http://127.0.0.1:11434` | Where Ollama listens (or `OLLAMA_HOST`). |
| `--voice` | | A Piper voice (`.onnx`) that speaks the sentences, or a Kokoro voice such as `kokoro:af_heart`. Without it they are captions only. |
| `--piper` | `piper` | The Piper command (or `CHANGEREEL_PIPER`). |
| `--kokoro` | `python3` | The Python that Kokoro is installed in (or `CHANGEREEL_KOKORO`). |
| `--language` | `en` | Language of the sentences and of the words in the video: `en` or `de`. Take a voice of the same language. |

Chrome or Chromium is found in the usual places; `CHROME_PATH` names another. The video is rendered with [Remotion](https://www.remotion.dev), which downloads its own browser on the first run. Remotion has its own [licence](https://www.remotion.dev/docs/license): free for individuals and small teams, paid for larger companies.

## With a voice

With `--narrate`, every scene gets a sentence: "A 'Subscriptions' link was added to the navigation between 'Shop' and 'Our roastery'." A model that reads pictures writes it from the changed spot before and after, and with `--voice` it is spoken and the scene lasts as long as the sentence. The voice is [Piper](https://github.com/OHF-Voice/piper1-gpl) and always runs on the machine. For the model there are two ways.

**On your own machine**, in [Ollama](https://ollama.com). No screenshot of your site is sent anywhere.

```console
ollama pull gemma3:4b
python3 -m piper.download_voices en_US-lessac-medium
changereel --base main --serve "npm run preview -- --port {port}" --narrate --voice en_US-lessac-medium.onnx
```

**At Anthropic**, with a model named `claude-…` and a key in `ANTHROPIC_API_KEY`. The excerpts of the pages that the model has to see are sent there. This is the way for a pull request, where the runner has no model:

```yaml
      - uses: derblub/changereel@v0
        with:
          serve: npm run preview -- --port {port}
          narrate: claude-opus-5-5
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          voice: en_US-lessac-medium
```

How good the sentences are depends on the model. On seven changes of a real site, each sentence checked against the pictures:

| Model | Where | Right | Per scene |
| --- | --- | --- | --- |
| `gemma3:4b` (3 GB) | local | 3 of 7 | 1.5 to 2.5 s |
| `gemma3:12b` (8 GB) | local | 5 to 6 of 7 | 1 to 3 s |
| `claude-haiku-5-5` | Anthropic | 6 of 7 | 1.5 to 4 s |
| `claude-opus-5-5` | Anthropic | 7 of 7 | 2 to 4 s, about half a cent |

The local times are from a graphics card with 12 GB. The small local model reads short text well, a changed price or a new label on a button, and is often wrong on a rewritten paragraph. No model is reliable enough to be read without the picture next to it, which is why the sentence is a caption under the page and not a report.

While the voice speaks, the sentence under the page follows it word by word: what is still to come is grey, what was said is white. Piper tells when each word is spoken if the `onnx` package is installed next to it (`pip install piper-tts onnx`); without it the times are guessed from the length of the words. The voice gets the sentence as it is said, a price as "18 euros" and a badge "NEW" as a word, and the caption follows that form; the comment keeps the written one.

**Kokoro** is a second voice, for English only, and more natural than Piper; the demo above speaks with it. It runs on the processor, a sentence in about four seconds, and tells when each word is spoken. The voice and an English model for its pronunciation are fetched on the first run.

```console
python3 -m venv ~/.local/share/kokoro && ~/.local/share/kokoro/bin/pip install kokoro soundfile
changereel … --narrate --voice kokoro:af_heart --kokoro ~/.local/share/kokoro/bin/python
```

Voices starting with `a` speak American English, with `b` British; the [list of voices](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md) has all of them. The action speaks with Piper.

With `--language de` the sentences and the words in the video are German ("Geändert", "Vorher", "Nachher"); text from the page is quoted as it is. Take a voice that speaks it, such as `de_DE-thorsten-medium`.

The model sees little more than the changed pixels, and is told when the spot was empty on one side; shown more of the page, it describes the neighbours. A scene it does not answer for gets a sentence without it ("A part of the page changed on /pricing.").

## Development

```console
npm install
npm test
node test/run-demo.mjs        # compares the two sample sites in test/site and renders out/changereel.mp4
node docs/demo/render.mjs     # the demo of this README, narrated (needs ANTHROPIC_API_KEY and --voice)
```

## Contributing

A page where it reports a change that is none, or misses one that is there, is the most useful report. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, and the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Daniel Kurdoghlian, Pushing Pixels. The typeface in the video, Google Sans Flex, is under the SIL Open Font License.

---

<div align="center">
  <a href="https://pushingpixels.at">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/pushing-pixels-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="docs/assets/pushing-pixels-light.svg">
      <img src="docs/assets/pushing-pixels.svg" alt="Pushing Pixels" width="320">
    </picture>
  </a>
  <p>Built and maintained by <a href="https://pushingpixels.at">Daniel Kurdoghlian</a> at <a href="https://pushingpixels.at">Pushing Pixels</a> in Vienna.<br>
  I build <a href="https://pushingpixels.at/creates/web-apps">custom software</a> and the pipelines that ship it.</p>
</div>
