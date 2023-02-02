import { ImapImportSystemFacade } from "../../native/common/generatedipc/ImapImportSystemFacade.js"
import { ImapAccount, ImapSyncState } from "./adsync/ImapSyncState.js"
import { ImapAdSync } from "./adsync/ImapAdSync.js"
import { AdSyncEventListener } from "./adsync/AdSyncEventListener.js"
import { ImapError, ImapErrorCause } from "./adsync/imapmail/ImapError.js"
import { ApplicationWindow } from "../ApplicationWindow.js"
import { ImapGetMailboxResult } from "./adsync/imapmail/ImapGetMailboxResult"

export class DesktopImapImportSystemFacade implements ImapImportSystemFacade {
	private activeSyncs = new Map<string, ImapAdSync>()
	constructor(private readonly win: ApplicationWindow) {}

	async startImport(accountSyncId: IdTuple, imapSyncState: ImapSyncState): Promise<ImapError | null> {
		const idKey = accountSyncId.join("/")

		const listener: AdSyncEventListener = {
			onMultipleMails: (mails, type) => this.win.imapImportFacade.onMultipleMails(accountSyncId, mails, type),
			onMailbox: (mb, type) => this.win.imapImportFacade.onMailbox(accountSyncId, mb, type),
			onMailboxStatus: (stat) => this.win.imapImportFacade.onMailboxStatus(accountSyncId, stat),
			onPostpone: (until) => this.win.imapImportFacade.onPostpone(accountSyncId, until),
			onFinish: (quota) => {
				this.activeSyncs.delete(idKey)
				return this.win.imapImportFacade.onFinish(accountSyncId, quota)
			},
			onError: (err) => {
				return this.win.imapImportFacade.onError(accountSyncId, err)
			},
		}

		const adSync = new ImapAdSync(listener)
		this.activeSyncs.set(idKey, adSync)
		return adSync.startAdSync(imapSyncState)
	}

	async getImapMailboxesFromServer(imapAccount: ImapAccount): Promise<ImapGetMailboxResult> {
		/**
		 * Since this is called before startImport, we create a temporary
		 * instance of ImapAdSync. We use a no-op listener because at this
		 * stage we only care about the return value of the folder list,
		 * not background events like mail sync.
		 */
		const transientAdSync = new ImapAdSync({
			onMultipleMails: async () => {},
			onMailbox: async () => {},
			onMailboxStatus: async () => {},
			onPostpone: async () => {},
			onFinish: async () => {},
			onError: async () => {},
		})

		try {
			const mailboxes = await transientAdSync.getImapMailboxesFromServer(imapAccount)
			return new ImapGetMailboxResult(mailboxes)
		} catch (e) {
			return new ImapGetMailboxResult(undefined, new ImapError(e, ImapErrorCause.LIST_MAILBOX_FAILED))
		}
	}
	async stopImport(accountSyncId: IdTuple): Promise<void> {
		const idKey = accountSyncId.join("/")
		const adSync = this.activeSyncs.get(idKey)

		if (adSync) {
			await adSync.stopAdSync()
			this.activeSyncs.delete(idKey)
		}
	}
}
