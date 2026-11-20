/** Native user events are blocked during Agent control. Mouse events from CDP are
 * allowed only while an owned Input.dispatchMouseEvent command is in flight.
 * A native shield above the page prevents physical user input in that interval.
 */
import type { WebContents } from "electron";
const states = new WeakMap<WebContents, { controlled: boolean; injected: number }>();
const FROM_DEBUGGER = 1 << 23; // Blink flag exposed as _modifiers by the pinned private Electron.

export function installInputGuard(contents: WebContents): void {
  const state = { controlled: false, injected: 0 };
  states.set(contents, state);
  contents.on("before-input-event", (event, input) => {
    if (state.controlled && !(((input as unknown as { _modifiers?: number })._modifiers ?? 0) & FROM_DEBUGGER)) event.preventDefault();
  });
  contents.on("before-mouse-event", (event) => {
    if (state.controlled && state.injected === 0) event.preventDefault();
  });
}
export function controlInput(contents: WebContents, controlled: boolean): void {
  const state = states.get(contents); if (state) state.controlled = controlled;
}
export async function injectedCommand(contents: WebContents, method: string, params: object): Promise<any> {
  const state = states.get(contents);
  const mouse = method === "Input.dispatchMouseEvent";
  if (mouse && state) state.injected++;
  try { return await contents.debugger.sendCommand(method, params); }
  finally { if (mouse && state) state.injected--; }
}
