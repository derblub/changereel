/**
 * The words of the video and of the sentences that need no model, in the languages there
 * are. A model is asked for its sentence in the same language.
 *
 * A step is shown as the file says it (`click button "Checkout"`), in the words of the file,
 * with the quotes of the language. The reasons a step stops for are translated where there
 * is a word for them; one that names a part of the page (`covered by div.banner`) stays.
 */
const states = (count, one, many) => `${count} ${count === 1 ? one : many}`;

export const TEXTS = {
  en: {
    name: "English",
    kind: { added: "Added", removed: "Removed", changed: "Changed", unreached: "No longer reachable", reached: "Reachable now" },
    page: (kind) => `${kind} page`,
    login: "Login",
    before: "Before",
    after: "After",
    more: (count) => `and ${count} more page${count > 1 ? "s" : ""}`,
    summary: (changes, changed, pages, changedStates = 0, checkedStates = 0) =>
      `${changes} change${changes === 1 ? "" : "s"} on ${changed} of ${pages} pages` +
      (checkedStates ? ` and ${changedStates} of ${states(checkedStates, "state", "states")}` : ""),
    loginSummary: "The login stopped, nothing else was compared",
    madeWith: "made with changereel",
    changes: "Changes",
    pages: "Pages",
    states: "States",
    of: (changed, pages) => `${changed} of ${pages}`,
    quote: (text) => String(text).replace(/"([^"]*)"/g, "“$1”"),
    reason: (reason) => reason,
    // The line under a state that is reached on one side only: "Step 1 of 2 stopped: click button “Checkout”, not found".
    // A state reached only now stopped before: the line says so, since the picture is of after
    stopped: (stop, steps, t) =>
      stop.side === "before"
        ? stop.step === null
          ? `Before, the page was not there: ${stop.reason}`
          : `Before, step ${stop.step + 1} of ${steps} stopped: ${t.quote(stop.does)}, ${t.reason(stop.reason)}`
        : stop.step === null
          ? `The page is not there: ${stop.reason}`
          : `Step ${stop.step + 1} of ${steps} stopped: ${t.quote(stop.does)}, ${t.reason(stop.reason)}`,
    loginStopped: (stop, t) => `The login stopped on the version ${stop.side}: step ${stop.step + 1}, ${t.quote(stop.does)}, ${t.reason(stop.reason)}`,
    plain: {
      page: { added: (route) => `The page ${route} was added.`, removed: (route) => `The page ${route} was removed.` },
      sentence: (type, where) => `${{ added: "A part of the page was added", removed: "A part of the page was removed", changed: "A part of the page changed" }[type]} ${where}.`,
      onPages: (count) => `on ${count} pages`,
      onHome: "on the home page",
      on: (route) => `on ${route}`,
      inState: (name, route) => `in “${name}” on ${route}`,
      state: {
        unreached: (name, route) => `“${name}” on ${route} can no longer be reached.`,
        reached: (name, route) => `“${name}” on ${route} can be reached now.`,
      },
      login: {
        unreached: "The login no longer gets through, so nothing else was compared.",
        reached: "The login gets through only now, so nothing else was compared.",
      },
    },
  },
  de: {
    name: "German",
    kind: { added: "Neu", removed: "Entfernt", changed: "Geändert", unreached: "Nicht mehr erreichbar", reached: "Jetzt erreichbar" },
    page: (kind) => ({ Neu: "Neue Seite", Entfernt: "Seite entfernt" })[kind] ?? `${kind}: Seite`,
    login: "Anmeldung",
    before: "Vorher",
    after: "Nachher",
    more: (count) => (count > 1 ? `und ${count} weitere Seiten` : "und eine weitere Seite"),
    summary: (changes, changed, pages, changedStates = 0, checkedStates = 0) =>
      `${changes} ${changes === 1 ? "Änderung" : "Änderungen"} auf ${changed} von ${pages} Seiten` +
      (checkedStates ? ` und ${changedStates} von ${states(checkedStates, "Zustand", "Zuständen")}` : ""),
    loginSummary: "Die Anmeldung brach ab, sonst wurde nichts verglichen",
    madeWith: "erstellt mit changereel",
    changes: "Änderungen",
    pages: "Seiten",
    states: "Zustände",
    of: (changed, pages) => `${changed} von ${pages}`,
    quote: (text) => String(text).replace(/"([^"]*)"/g, "„$1“"),
    reason: (reason) =>
      ({ "not found": "nicht gefunden", "not visible": "nicht sichtbar", disabled: "deaktiviert", "still moving": "bewegt sich noch", "still visible": "noch sichtbar" })[
        reason
      ] ?? reason,
    stopped: (stop, steps, t) =>
      stop.side === "before"
        ? stop.step === null
          ? `Vorher fehlte die Seite: ${stop.reason}`
          : `Vorher scheiterte Schritt ${stop.step + 1} von ${steps}: ${t.quote(stop.does)}, ${t.reason(stop.reason)}`
        : stop.step === null
          ? `Die Seite fehlt: ${stop.reason}`
          : `Schritt ${stop.step + 1} von ${steps} gescheitert: ${t.quote(stop.does)}, ${t.reason(stop.reason)}`,
    loginStopped: (stop, t) =>
      `Die Anmeldung brach in der ${stop.side === "after" ? "neuen" : "alten"} Version ab: Schritt ${stop.step + 1}, ${t.quote(stop.does)}, ${t.reason(stop.reason)}`,
    plain: {
      page: { added: (route) => `Die Seite ${route} ist neu.`, removed: (route) => `Die Seite ${route} wurde entfernt.` },
      sentence: (type, where) =>
        `${where[0].toUpperCase()}${where.slice(1)} ${{ added: "ist ein Teil der Seite neu", removed: "wurde ein Teil der Seite entfernt", changed: "hat sich ein Teil der Seite geändert" }[type]}.`,
      onPages: (count) => `auf ${count} Seiten`,
      onHome: "auf der Startseite",
      on: (route) => `auf ${route}`,
      inState: (name, route) => `in „${name}“ auf ${route}`,
      state: {
        unreached: (name, route) => `„${name}“ auf ${route} ist nicht mehr erreichbar.`,
        reached: (name, route) => `„${name}“ auf ${route} ist jetzt erreichbar.`,
      },
      login: {
        unreached: "Die Anmeldung klappt nicht mehr, darum wurde sonst nichts verglichen.",
        reached: "Die Anmeldung klappt erst jetzt, darum wurde sonst nichts verglichen.",
      },
    },
  },
};

export const textsFor = (language) => TEXTS[language] || TEXTS.en;

/** What a scene shows, as the line above the recording and the closing card name it. */
export function kindOf(scene, texts) {
  if (scene.setup) return texts.login;
  if (scene.type === "unreached" || scene.type === "reached") return texts.kind[scene.type];
  return scene.page ? texts.page(texts.kind[scene.type]) : texts.kind[scene.type];
}

/** The line that says where the steps of a scene stopped, or null for a scene that did not stop. */
export function stopLine(scene, texts) {
  if (!scene.stopped) return null;
  return scene.setup ? texts.loginStopped(scene.stopped, texts) : texts.stopped(scene.stopped, scene.steps, texts);
}
