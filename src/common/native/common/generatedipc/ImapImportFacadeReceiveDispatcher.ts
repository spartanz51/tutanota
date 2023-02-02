/* generated file, don't edit. */

import { ImapMailbox } from "./ImapMailbox.js"
import { AdSyncEventType } from "./AdSyncEventType.js"
import { ImapMailboxStatus } from "./ImapMailboxStatus.js"
import { ImapMail } from "./ImapMail.js"
import { ImapError } from "./ImapError.js"
import { ImapImportFacade } from "./ImapImportFacade.js"

export class ImapImportFacadeReceiveDispatcher {
	constructor(private readonly facade: ImapImportFacade) {}
	async dispatch(method: string, arg: Array<any>): Promise<any> {
		switch (method) {
			case "onMailbox": {
				const accountSyncId: IdTuple = arg[0]
				const imapMailbox: ImapMailbox = arg[1]
				const eventType: AdSyncEventType = arg[2]
				return this.facade.onMailbox(accountSyncId, imapMailbox, eventType)
			}
			case "onMailboxStatus": {
				const accountSyncId: IdTuple = arg[0]
				const imapMailboxStatus: ImapMailboxStatus = arg[1]
				return this.facade.onMailboxStatus(accountSyncId, imapMailboxStatus)
			}
			case "onMultipleMails": {
				const accountSyncId: IdTuple = arg[0]
				const imapMails: ReadonlyArray<ImapMail> = arg[1]
				const eventType: AdSyncEventType = arg[2]
				return this.facade.onMultipleMails(accountSyncId, imapMails, eventType)
			}
			case "onPostpone": {
				const accountSyncId: IdTuple = arg[0]
				const postponedUntil: number = arg[1]
				return this.facade.onPostpone(accountSyncId, postponedUntil)
			}
			case "onFinish": {
				const accountSyncId: IdTuple = arg[0]
				const downloadedQuota: number = arg[1]
				return this.facade.onFinish(accountSyncId, downloadedQuota)
			}
			case "onError": {
				const accountSyncId: IdTuple = arg[0]
				const imapError: ImapError = arg[1]
				return this.facade.onError(accountSyncId, imapError)
			}
		}
	}
}
