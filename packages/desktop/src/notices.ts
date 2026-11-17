/**
 * Notifications of the system: the user hears that the work is done, went
 * wrong, or waits for them (workspace.ts says when), while xsb is not what
 * they look at. A notice of the window in front is shown there already and
 * not repeated. Clicking one brings its window to the front at its agent.
 *
 * Electron's `Notification` is the system's own on both platforms; what
 * differs is how the system knows whose a notification is:
 *
 *   macOS    the app's bundle id. The system asks the user, the first time,
 *            whether xsb may notify; until then, and after a no, nothing shows.
 *   Windows  an AppUserModelID, and a Start menu shortcut that carries the
 *            same one: without the shortcut no notification shows. The app
 *            ships as a zip, with no installer to make one, so it makes its own
 *            on every start, pointing at where it runs from now (the zip may
 *            have been unpacked elsewhere). The id is the app's `appId`
 *            (electron-builder.config.mjs). A run from the sources makes none
 *            and shows none.
 *
 * A notification that is no longer referenced may be collected, and with it
 * what its click does; so each is kept until it is clicked or closed.
 */
import path from "node:path";
import { BrowserWindow, Notification, app, shell } from "electron";

/** The app's `appId` in electron-builder.config.mjs: on Windows, whose notifications these are. */
const APP_ID = "com.xsb.desktop";

const shown = new Set<Notification>();

/** Once, at the start: on Windows, the id notifications go out under and the shortcut that makes it known. */
export function setUpNotices(): void {
  if (process.platform !== "win32" || !app.isPackaged) return;
  app.setAppUserModelId(APP_ID);
  const link = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", `${app.getName()}.lnk`);
  shell.writeShortcutLink(link, "create", { target: process.execPath, appUserModelId: APP_ID });
}

/** Tell the user `title` and `body` about the window `win`, unless they are looking at it. `open` is what a click does once the window is in front. */
export function notice(win: BrowserWindow, title: string, body: string, open: () => void): void {
  if (!Notification.isSupported() || win.isDestroyed() || (win.isVisible() && win.isFocused())) return;
  const note = new Notification({ title, body });
  shown.add(note);
  note.on("click", () => {
    shown.delete(note);
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    open();
  });
  note.on("close", () => shown.delete(note));
  note.show();
}
