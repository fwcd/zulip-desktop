import type {IpcMainEvent, WebContents} from "electron/main";
import {BrowserWindow, app, dialog, powerMonitor, session} from "electron/main";
import path from "node:path";
import process from "node:process";

import * as remoteMain from "@electron/remote/main";
import windowStateKeeper from "electron-window-state";

import * as ConfigUtil from "../common/config-util.js";
import type {RendererMessage} from "../common/typed-ipc.js";
import type {MenuProps} from "../common/types.js";

import {appUpdater, shouldQuitForUpdate} from "./autoupdater.js";
import * as BadgeSettings from "./badge-settings.js";
import handleExternalLink from "./handle-external-link.js";
import * as AppMenu from "./menu.js";
import {_getServerSettings, _isOnline, _saveServerIcon} from "./request.js";
import {sentryInit} from "./sentry.js";
import {setAutoLaunch} from "./startup.js";
import {ipcMain, send} from "./typed-ipc-main.js";

import "gatemaker/electron-setup"; // eslint-disable-line import/no-unassigned-import

// eslint-disable-next-line @typescript-eslint/naming-convention
const {GDK_BACKEND} = process.env;

// Initialize sentry for main process
sentryInit();

let mainWindowState: windowStateKeeper.State;

// Prevent window being garbage collected
let mainWindow: BrowserWindow;
let badgeCount: number;

let isQuitting = false;

// Load this url in main window
const mainUrl = "file://" + path.join(__dirname, "../renderer", "main.html");

const permissionCallbacks = new Map<number, (grant: boolean) => void>();
let nextPermissionCallbackId = 0;

const appIcon = path.join(__dirname, "../resources", "Icon");

const iconPath = (): string =>
  appIcon + (process.platform === "win32" ? ".ico" : ".png");

// Toggle the app window
const toggleApp = (): void => {
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
    mainWindow.show();
  } else {
    mainWindow.hide();
  }
};

function createMainWindow(): BrowserWindow {
  // Load the previous state with fallback to defaults
  mainWindowState = windowStateKeeper({
    defaultWidth: 1100,
    defaultHeight: 720,
    path: `${app.getPath("userData")}/config`,
  });

  const win = new BrowserWindow({
    // This settings needs to be saved in config
    title: "Zulip",
    icon: iconPath(),
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 500,
    minHeight: 400,
    webPreferences: {
      preload: require.resolve("../renderer/js/main"),
      sandbox: false,
      webviewTag: true,
    },
    show: false,
  });
  remoteMain.enable(win.webContents);

  win.on("focus", () => {
    send(win.webContents, "focus");
  });

  (async () => win.loadURL(mainUrl))();

  // Keep the app running in background on close event
  win.on("close", (event) => {
    if (ConfigUtil.getConfigItem("quitOnClose", false)) {
      app.quit();
    }

    if (!isQuitting && !shouldQuitForUpdate()) {
      event.preventDefault();

      if (process.platform === "darwin") {
        app.hide();
      } else {
        win.hide();
      }
    }
  });

  win.setTitle("Zulip");

  win.on("enter-full-screen", () => {
    send(win.webContents, "enter-fullscreen");
  });

  win.on("leave-full-screen", () => {
    send(win.webContents, "leave-fullscreen");
  });

  //  To destroy tray icon when navigate to a new URL
  win.webContents.on("will-navigate", (event) => {
    if (event) {
      send(win.webContents, "destroytray");
    }
  });

  // Let us register listeners on the window, so we can update the state
  // automatically (the listeners will be removed when the window is closed)
  // and restore the maximized or full screen state
  mainWindowState.manage(win);

  return win;
}

(async () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  await app.whenReady();

  if (process.env.GDK_BACKEND !== GDK_BACKEND) {
    console.warn(
      "Reverting GDK_BACKEND to work around https://github.com/electron/electron/issues/28436",
    );
    if (GDK_BACKEND === undefined) {
      delete process.env.GDK_BACKEND;
    } else {
      process.env.GDK_BACKEND = GDK_BACKEND;
    }
  }

  // Used for notifications on Windows
  app.setAppUserModelId("org.zulip.zulip-electron");

  remoteMain.initialize();

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }

      mainWindow.show();
    }
  });

  ipcMain.on(
    "permission-callback",
    (event: Event, permissionCallbackId: number, grant: boolean) => {
      permissionCallbacks.get(permissionCallbackId)?.(grant);
      permissionCallbacks.delete(permissionCallbackId);
    },
  );

  // This event is only available on macOS. Triggers when you click on the dock icon.
  app.on("activate", () => {
    mainWindow.show();
  });

  app.on("web-contents-created", (_event: Event, contents: WebContents) => {
    contents.setWindowOpenHandler((details) => {
      handleExternalLink(contents, details, page);
      return {action: "deny"};
    });
  });

  const ses = session.fromPartition("persist:webviewsession");
  ses.setUserAgent(`ZulipElectron/${app.getVersion()} ${ses.getUserAgent()}`);

  function configureSpellChecker() {
    const enable = ConfigUtil.getConfigItem("enableSpellchecker", true);
    if (enable && process.platform !== "darwin") {
      ses.setSpellCheckerLanguages(
        ConfigUtil.getConfigItem("spellcheckerLanguages", null) ?? [],
      );
    }

    ses.setSpellCheckerEnabled(enable);
  }

  configureSpellChecker();
  ipcMain.on("configure-spell-checker", configureSpellChecker);

  AppMenu.setMenu({
    tabs: [],
  });
  mainWindow = createMainWindow();

  // Auto-hide menu bar on Windows + Linux
  if (process.platform !== "darwin") {
    const shouldHideMenu = ConfigUtil.getConfigItem("autoHideMenubar", false);
    mainWindow.autoHideMenuBar = shouldHideMenu;
    mainWindow.setMenuBarVisibility(!shouldHideMenu);
  }

  const page = mainWindow.webContents;

  page.on("dom-ready", () => {
    if (ConfigUtil.getConfigItem("startMinimized", false)) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });

  ipcMain.on("fetch-user-agent", (event) => {
    event.returnValue = session
      .fromPartition("persist:webviewsession")
      .getUserAgent();
  });

  ipcMain.handle("get-server-settings", async (event, domain: string) =>
    _getServerSettings(domain, ses),
  );

  ipcMain.handle("save-server-icon", async (event, url: string) =>
    _saveServerIcon(url, ses),
  );

  ipcMain.handle("is-online", async (event, url: string) =>
    _isOnline(url, ses),
  );

  page.once("did-frame-finish-load", async () => {
    // Initiate auto-updates on MacOS and Windows
    if (ConfigUtil.getConfigItem("autoUpdate", true)) {
      await appUpdater();
    }
  });

  app.on(
    "certificate-error",
    (
      event: Event,
      webContents: WebContents,
      urlString: string,
      error: string,
    ) => {
      const url = new URL(urlString);
      dialog.showErrorBox(
        "Certificate error",
        `The server presented an invalid certificate for ${url.origin}:

${error}`,
      );
    },
  );

  ses.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const {origin} = new URL(details.requestingUrl);
      const permissionCallbackId = nextPermissionCallbackId++;
      permissionCallbacks.set(permissionCallbackId, callback);
      send(
        page,
        "permission-request",
        {
          webContentsId:
            webContents.id === mainWindow.webContents.id
              ? null
              : webContents.id,
          origin,
          permission,
        },
        permissionCallbackId,
      );
    },
  );

  // Temporarily remove this event
  // powerMonitor.on('resume', () => {
  // 	mainWindow.reload();
  // 	send(page, 'destroytray');
  // });

  ipcMain.on("focus-app", () => {
    mainWindow.show();
  });

  ipcMain.on("quit-app", () => {
    app.quit();
  });

  // Reload full app not just webview, useful in debugging
  ipcMain.on("reload-full-app", () => {
    mainWindow.reload();
    send(page, "destroytray");
  });

  ipcMain.on("clear-app-settings", () => {
    mainWindowState.unmanage();
    app.relaunch();
    app.exit();
  });

  ipcMain.on("toggle-app", () => {
    toggleApp();
  });

  ipcMain.on("toggle-badge-option", () => {
    BadgeSettings.updateBadge(badgeCount, mainWindow);
  });

  ipcMain.on("toggle-menubar", (_event: IpcMainEvent, showMenubar: boolean) => {
    mainWindow.autoHideMenuBar = showMenubar;
    mainWindow.setMenuBarVisibility(!showMenubar);
    send(page, "toggle-autohide-menubar", showMenubar, true);
  });

  ipcMain.on("update-badge", (_event: IpcMainEvent, messageCount: number) => {
    badgeCount = messageCount;
    BadgeSettings.updateBadge(badgeCount, mainWindow);
    send(page, "tray", messageCount);
  });

  ipcMain.on(
    "update-taskbar-icon",
    (_event: IpcMainEvent, data: string, text: string) => {
      BadgeSettings.updateTaskbarIcon(data, text, mainWindow);
    },
  );

  ipcMain.on(
    "forward-message",
    <Channel extends keyof RendererMessage>(
      _event: IpcMainEvent,
      listener: Channel,
      ...parameters: Parameters<RendererMessage[Channel]>
    ) => {
      send(page, listener, ...parameters);
    },
  );

  ipcMain.on("update-menu", (_event: IpcMainEvent, props: MenuProps) => {
    AppMenu.setMenu(props);
    if (props.activeTabIndex !== undefined) {
      const activeTab = props.tabs[props.activeTabIndex];
      mainWindow.setTitle(`Zulip - ${activeTab.name}`);
    }
  });

  ipcMain.on(
    "toggleAutoLauncher",
    async (_event: IpcMainEvent, AutoLaunchValue: boolean) => {
      await setAutoLaunch(AutoLaunchValue);
    },
  );

  ipcMain.on(
    "realm-name-changed",
    (_event: IpcMainEvent, serverURL: string, realmName: string) => {
      send(page, "update-realm-name", serverURL, realmName);
    },
  );

  ipcMain.on(
    "realm-icon-changed",
    (_event: IpcMainEvent, serverURL: string, iconURL: string) => {
      send(page, "update-realm-icon", serverURL, iconURL);
    },
  );

  ipcMain.on("save-last-tab", (_event: IpcMainEvent, index: number) => {
    ConfigUtil.setConfigItem("lastActiveTab", index);
  });

  ipcMain.on("focus-this-webview", (event: IpcMainEvent) => {
    send(page, "focus-webview-with-id", event.sender.id);
    mainWindow.show();
  });

  // Update user idle status for each realm after every 15s
  const idleCheckInterval = 15 * 1000; // 15 seconds
  setInterval(() => {
    // Set user idle if no activity in 1 second (idleThresholdSeconds)
    const idleThresholdSeconds = 1; // 1 second
    const idleState = powerMonitor.getSystemIdleState(idleThresholdSeconds);
    if (idleState === "active") {
      send(page, "set-active");
    } else {
      send(page, "set-idle");
    }
  }, idleCheckInterval);
})();

app.on("before-quit", () => {
  isQuitting = true;
});

// Send crash reports
process.on("uncaughtException", (error) => {
  console.error(error);
  console.error(error.stack);
});
