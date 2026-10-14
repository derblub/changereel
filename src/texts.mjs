/**
 * The words of the video and of the sentences that need no model, in the languages there
 * are. A model is asked for its sentence in the same language.
 */
export const TEXTS = {
  en: {
    name: "English",
    kind: { added: "Added", removed: "Removed", changed: "Changed" },
    page: (kind) => `${kind} page`,
    before: "Before",
    after: "After",
    more: (count) => `and ${count} more page${count > 1 ? "s" : ""}`,
    summary: (changes, changed, pages) => `${changes} change${changes === 1 ? "" : "s"} on ${changed} of ${pages} pages`,
    madeWith: "made with changereel",
    changes: "Changes",
    pages: "Pages",
    of: (changed, pages) => `${changed} of ${pages}`,
    plain: {
      page: { added: (route) => `The page ${route} was added.`, removed: (route) => `The page ${route} was removed.` },
      sentence: (type, where) => `${{ added: "A part of the page was added", removed: "A part of the page was removed", changed: "A part of the page changed" }[type]} ${where}.`,
      onPages: (count) => `on ${count} pages`,
      onHome: "on the home page",
      on: (route) => `on ${route}`,
    },
  },
  de: {
    name: "German",
    kind: { added: "Neu", removed: "Entfernt", changed: "Geändert" },
    page: (kind) => ({ Neu: "Neue Seite", Entfernt: "Seite entfernt" })[kind] ?? `${kind}: Seite`,
    before: "Vorher",
    after: "Nachher",
    more: (count) => (count > 1 ? `und ${count} weitere Seiten` : "und eine weitere Seite"),
    summary: (changes, changed, pages) => `${changes} ${changes === 1 ? "Änderung" : "Änderungen"} auf ${changed} von ${pages} Seiten`,
    madeWith: "erstellt mit changereel",
    changes: "Änderungen",
    pages: "Seiten",
    of: (changed, pages) => `${changed} von ${pages}`,
    plain: {
      page: { added: (route) => `Die Seite ${route} ist neu.`, removed: (route) => `Die Seite ${route} wurde entfernt.` },
      sentence: (type, where) =>
        `${where[0].toUpperCase()}${where.slice(1)} ${{ added: "ist ein Teil der Seite neu", removed: "wurde ein Teil der Seite entfernt", changed: "hat sich ein Teil der Seite geändert" }[type]}.`,
      onPages: (count) => `auf ${count} Seiten`,
      onHome: "auf der Startseite",
      on: (route) => `auf ${route}`,
    },
  },
};

export const textsFor = (language) => TEXTS[language] || TEXTS.en;
