import { copyButton } from "./content.js";
import { h } from "./dom.js";
import { turnCopyText } from "./turn-copy.js";

// Pending inputs keep their original position when delivered, so entries belonging to
// different turns can overlap on screen. Older transcripts only marked interjections.
function ownerOf(entry) {
  if (entry.kind === "input") return entry.origin.turnId;
  if (entry.kind === "output") return entry.run?.turnId;
  return entry.turnId;
}

function transcriptTurns(entries) {
  const turns = new Map();
  let lastTurn;
  for (const entry of entries) {
    if (entry.kind === "boundary") {
      if (entry.boundary.kind === "cleared") lastTurn = undefined;
      continue;
    }
    if (entry.kind === "publication" || entry.kind === "input" && (entry.pending || entry.unsent || entry.discarded || entry.reply)) continue;
    const owner = ownerOf(entry);
    if (owner === null) continue;
    const id = owner ?? (entry.kind === "input" && !entry.origin.steered ? entry.id : lastTurn ?? entry.id);
    if (!turns.has(id)) turns.set(id, []);
    turns.get(id).push(entry);
    lastTurn = id;
  }
  return turns;
}

// Put the cursor on the final line of Markdown, or on its own line while waiting
// for text (including after a tool, an input, or an attachment).
function placeCursor(cursor, entriesNode, anchor) {
  let last = anchor?.matches(".output") && anchor.querySelector(".content > .md:last-child")?.lastElementChild;
  while (last && !last.matches("p, h1, h2, h3, h4, h5, h6, li, code, td, th")) last = last.lastElementChild;
  if (last) {
    if (cursor.parentElement !== last) last.append(cursor);
  } else if (anchor) {
    if (cursor.previousElementSibling !== anchor) anchor.after(cursor);
  } else if (entriesNode.lastElementChild !== cursor) entriesNode.append(cursor);
}

/** Keep one action per completed turn and one cursor for the foreground turn. */
export function transcriptMarkers(entriesNode, getTranscript) {
  const buttons = new Map();
  const cursor = h("span", { class: "turn-cursor", "aria-hidden": "true" });
  let cursorEntry;
  let turns;

  function sync() {
    const { entries, agent, partialTurnIds } = getTranscript();
    turns = transcriptTurns(entries);
    // An older Hub may only supply the session state and the initiating input.
    const last = [...turns.keys()].at(-1);
    const legacyBusy = agent.state !== "idle" && last && turns.get(last).every(entry => ownerOf(entry) === undefined);
    const active = agent.currentTurnId ?? (legacyBusy ? last : undefined);
    for (const id of partialTurnIds ?? []) if (id !== active) turns.delete(id);
    const nodes = new Map([...entriesNode.children].filter(node => node.hasAttribute("data-id") && !node.hidden).map(node => [node.dataset.id, node]));
    for (const [id, button] of buttons) {
      if (turns.has(id) && id !== active) continue;
      button.remove();
      buttons.delete(id);
    }
    let activeAnchor;
    for (const [id, group] of turns) {
      const last = group.findLast(entry => nodes.has(entry.id));
      const anchor = last && nodes.get(last.id);
      if (id === active) {
        activeAnchor = anchor;
        continue;
      }
      if (!anchor) {
        buttons.get(id)?.remove();
        buttons.delete(id);
        continue;
      }
      let button = buttons.get(id);
      if (!button) {
        button = copyButton(() => turnCopyText(turns.get(id)), "content.copyTurn");
        button.classList.add("turn-copy");
        buttons.set(id, button);
      }
      if (button.previousElementSibling !== anchor) anchor.after(button);
    }
    cursorEntry = activeAnchor?.dataset.id;
    if (active) placeCursor(cursor, entriesNode, activeAnchor);
    else cursor.remove();
  }

  return { sync, update(entry, replaced) {
    // Streaming replaces the same Markdown node for each chunk. Only its cursor
    // needs moving; the completed turns and their copy actions stay in place.
    if (replaced && entry.kind === "output" && entry.streaming) {
      if (entry.id === cursorEntry) placeCursor(cursor, entriesNode, replaced);
    } else sync();
  } };
}
