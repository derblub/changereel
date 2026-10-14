# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

- The action comments on the pull request: what changed on which page, the sentence for each change when there is one, and the way to the video. A later run changes the comment instead of adding one; a pull request that changes no page gets none.
- The action keeps the video as an artifact of the run itself, as the video and not in a zip (inputs `upload`, `artifact-name`; output `video-url`).
- The comment shows a moving preview of the video, kept on the branch `changereel-previews` (input `preview`; `--preview` renders it as `changereel.gif`).

## [0.5.2] - 2026-10-14

- On npm: `npx changereel`. `--help` and `--version`.
- Runs when started through the link npm installs, and renders the video from inside node_modules.
- A release on GitHub publishes the same version to npm, with provenance.
- The measures and arithmetic of the video are in a module of their own, with tests.

## [0.5.1] - 2026-10-14

- The page before stands still for a good second once the camera is there, before it changes to the page after. A sign in the corner of the recording says which side it is.
- The place is marked on both sides, each measured on its own page, and the mark moves and grows from the one into the other: dashed around what was, hatched where there is nothing yet or nothing any more, solid in the accent around what is now. The page around it is dimmed a little, and what is new lights up as it comes.
- A page on which a change is found is visited again on both sides before the change counts (`--confirm`, default 2). A random part that looked the same twice by chance no longer shows as a change.
- The frame around a section that came, went or grew goes around what is drawn in it, not from edge to edge of the page.

## [0.5.0] - 2026-10-13

- The video is made like one screen recording of the page: rounded corners and a soft shadow, the page scrolls to the place, the camera goes to the change on a spring, and there the page changes from before to after. The recording stays through all scenes. Above it a line says which scene this is, under it the sentence runs as the subtitle.
- The spoken sentence follows the voice word by word.
- The pages are shown with twice the pixels, so they stay sharp when the camera moves closer.
- The frame around changed pixels grows to the words they belong to, so a changed digit no longer cuts a price in two.
- An opening card with the facts of the run and a closing card that lists the changes.
- `reel.json` next to the video holds what it was rendered from.

## [0.4.0] - 2026-10-13

- `--language de` (input `language`): German sentences and German words in the video.
- The README shows a video.

## [0.3.0] - 2026-10-13

- Narration with a model of Anthropic (`--model claude-opus-5-5`, key in `ANTHROPIC_API_KEY`), for better sentences and for where there is no local model.
- The action narrates: inputs `narrate`, `anthropic-api-key` and `voice`.
- A new page is described by what it is about.
- Narration: a sentence is no longer cut off at a full stop inside quoted text, and a part that grew a lot is shown to the model as it is now, not next to the short part it was.

## [0.2.0] - 2026-10-13

- `--narrate`: a local model in Ollama says in one sentence what each change is; the sentence is shown under the page.
- `--voice`: Piper speaks the sentences, and a scene lasts as long as its sentence.

## [0.1.0] - 2026-10-13

- Compares every route of two versions of a site and renders the changes as a video: the page before, a wipe to the page after, a frame around what differs.
- Pages are compared like text files whose lines are rows of pixels, so a new section is "added" and what it pushed down is not "changed".
- Takes the two versions from two running sites (`--before`, `--after`) or builds and serves them from a repository (`--base`, `--build`, `--serve`).
- Leaves out what is not stable: waits until a page has settled, visits it more than once, does not draw frames, compares an app shell and its content apart, and takes `--ignore` selectors.
- GitHub Action with a job summary and the video as an output.

[Unreleased]: https://github.com/derblub/changereel/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/derblub/changereel/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/derblub/changereel/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/derblub/changereel/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/derblub/changereel/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/derblub/changereel/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/derblub/changereel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/derblub/changereel/releases/tag/v0.1.0
