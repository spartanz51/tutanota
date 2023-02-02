import { OauthFacade } from "../native/common/generatedipc/OauthFacade"
import { app, BrowserWindow } from "electron"
import { register } from "./electron-localshortcut/LocalShortcut"
import path from "node:path"

export class DesktopOauthWindowFacade implements OauthFacade {
	constructor() {
		this.win = null
	}
	private win: BrowserWindow | null

	async openOauthWindow(url: string, redirectUrl: string): Promise<string | null> {
		this.destroyAuthWin()

		return new Promise((resolve) => {
			this.win = new BrowserWindow({
				width: 600,
				height: 600,
				webPreferences: {
					nodeIntegration: false,
					nodeIntegrationInWorker: false,
					nodeIntegrationInSubFrames: false,
					sandbox: true,
					contextIsolation: true,
					webSecurity: true,
					// @ts-ignore see: https://github.com/electron/electron/issues/30789
					enableRemoteModule: false,
					allowRunningInsecureContent: false,
					preload: path.join(app.getAppPath(), "./desktop/preload-webdialog.js"),
					webgl: false,
					plugins: false,
					experimentalFeatures: false,
					webviewTag: false,
					disableDialogs: true,
					navigateOnDragDrop: false,
					autoplayPolicy: "user-gesture-required",
					enableWebSQL: false,
					spellcheck: false,
					partition: "oauthdialog",
				},
			})
			register(this.win, "F12", () => {
				this.win?.webContents.openDevTools()
			})

			const {
				session: { webRequest },
			} = this.win.webContents

			const filter = {
				urls: [`${redirectUrl}*`],
			}

			webRequest.onBeforeRequest(filter, async ({ url }) => {
				if (url.startsWith(redirectUrl)) {
					this.destroyAuthWin()
					console.log("### This may or may not be an error thing apparently, ", url)
					resolve(url)
					return this.destroyAuthWin()
				}
			})

			this.win.on("closed", () => {
				console.log("### we know window was closed!")
				this.win = null
				resolve(null)
			})

			this.win.loadURL(url)
		})
	}

	async loadTokens(callbackURL: any) {
		console.log("loading things for callback", callbackURL)
		return callbackURL
	}

	destroyAuthWin() {
		if (!this.win) return
		this.win.close()
		this.win = null
	}
}
