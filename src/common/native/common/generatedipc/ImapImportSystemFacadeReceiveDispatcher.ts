/* generated file, don't edit. */

import { ImapSyncState } from "./ImapSyncState.js"
import { ImapAccount } from "./ImapAccount.js"
import { ImapImportSystemFacade } from "./ImapImportSystemFacade.js"

export class ImapImportSystemFacadeReceiveDispatcher {
	constructor(private readonly facade: ImapImportSystemFacade) {}
	async dispatch(method: string, arg: Array<any>): Promise<any> {
		switch (method) {
			case "startImport": {
				const accountSyncId: IdTuple = arg[0]
				const imapSyncState: ImapSyncState = arg[1]
				return this.facade.startImport(accountSyncId, imapSyncState)
			}
			case "getImapMailboxesFromServer": {
				const imapAccount: ImapAccount = arg[0]
				return this.facade.getImapMailboxesFromServer(imapAccount)
			}
			case "stopImport": {
				const accountSyncId: IdTuple = arg[0]
				return this.facade.stopImport(accountSyncId)
			}
		}
	}
}
