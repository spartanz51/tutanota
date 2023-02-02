/* generated file, don't edit. */

import { ImapSyncState } from "./ImapSyncState.js"
import { ImapError } from "./ImapError.js"
import { ImapAccount } from "./ImapAccount.js"
import { ImapGetMailboxResult } from "./ImapGetMailboxResult.js"
/**
 * Facade implemented by the native desktop client starting and stopping an IMAP import.
 */
export interface ImapImportSystemFacade {
	/**
	 * Start the IMAP import for a specific account.
	 */
	startImport(accountSyncId: IdTuple, imapSyncState: ImapSyncState): Promise<ImapError | null>

	/**
	 * Fetches the folders from the IMAP server, to be used for the folder mapping step
	 */
	getImapMailboxesFromServer(imapAccount: ImapAccount): Promise<ImapGetMailboxResult>

	/**
	 * Stop a specific running IMAP import.
	 */
	stopImport(accountSyncId: IdTuple): Promise<void>
}
