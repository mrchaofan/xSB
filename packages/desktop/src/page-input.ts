/** Native user events are blocked during Agent control. Mouse events from CDP are
 * allowed only while an owned Input.dispatchMouseEvent command is in flight.
 * A shield view above the page, owned by the window that shows it (page-host.ts),
 * takes physical mouse input in that interval.
 *
 * While the user annotates a page, its keyboard is blocked too; the mouse goes
 * on to the page, where the debugger's node selection takes clicks and hovers
 * and leaves only scrolling to the page.
 */
import type { WebContents } from "electron";
const states = new WeakMap<WebContents, { controlled: boolean; annotating: boolean; injected: number; pressed: number }>();
/** How recent a press of the user's counts as what gave a page the keyboard. */
const PRESS_MS = 500;
const FROM_DEBUGGER = 1 << 23; // Blink flag exposed as _modifiers by the pinned private Electron.

export function installInputGuard(contents: WebContents): void {
  const state = { controlled: false, annotating: false, injected: 0, pressed: 0 };
  states.set(contents, state);
  contents.on("before-input-event", (event, input) => {
    if ((state.controlled || state.annotating) && !(((input as unknown as { _modifiers?: number })._modifiers ?? 0) & FROM_DEBUGGER)) event.preventDefault();
  });
  contents.on("before-mouse-event", (event, mouse) => {
    if (state.controlled && state.injected === 0) event.preventDefault();
    else if (state.injected === 0 && (mouse as { type?: string }).type === "mouseDown") state.pressed = Date.now();
  });
}
/** Whether the user, not an agent, pressed the mouse on the page a moment ago. */
export function pressedByUser(contents: WebContents): boolean {
  return Date.now() - (states.get(contents)?.pressed ?? 0) < PRESS_MS;
}
export function controlInput(contents: WebContents, controlled: boolean): void {
  const state = states.get(contents); if (state) state.controlled = controlled;
}
export function annotateInput(contents: WebContents, annotating: boolean): void {
  const state = states.get(contents); if (state) state.annotating = annotating;
}
export async function injectedCommand(contents: WebContents, method: string, params: object): Promise<any> {
  const state = states.get(contents);
  const mouse = method === "Input.dispatchMouseEvent";
  if (mouse && state) state.injected++;
  try { return await contents.debugger.sendCommand(method, params); }
  finally { if (mouse && state) state.injected--; }
}

/**
 * A page has one debugger, which an agent (browser.ts) and the user's
 * annotations (page-annotations.ts) share. Each holds it while it needs it;
 * the last to let go detaches it.
 */
const holders = new WeakMap<WebContents, number>();
export function holdDebugger(contents: WebContents): () => void {
  const count = holders.get(contents) ?? 0;
  if (!count && !contents.debugger.isAttached()) contents.debugger.attach("1.3");
  holders.set(contents, count + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (holders.get(contents) ?? 1) - 1;
    holders.set(contents, left);
    if (!left && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
  };
}
