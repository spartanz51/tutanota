/* generated file, don't edit. */

import { ImapMailbox } from "./ImapMailbox.js"
import { AdSyncEventType } from "./AdSyncEventType.js"
import { ImapMailboxStatus } from "./ImapMailboxStatus.js"
import { ImapMail } from "./ImapMail.js"
import { ImapError } from "./ImapError.js"
/**
 * Facade implemented by the web worker, receiving IMAP import events.
 */
export interface ImapImportFacade {
	/**
	 * onMailbox IMAP import event.
	 */
	onMailbox(accountSyncId: IdTuple, imapMailbox: ImapMailbox, eventType: AdSyncEventType): Promise<void>

	/**
	 * onMailboxStatus IMAP import event.
	 */
	onMailboxStatus(accountSyncId: IdTuple, imapMailboxStatus: ImapMailboxStatus): Promise<void>

	/**
	 * onMultipleMails IMAP import event.
	 */
	onMultipleMails(accountSyncId: IdTuple, imapMails: ReadonlyArray<ImapMail>, eventType: AdSyncEventType): Promise<void>

	/**
	 * onPostpone IMAP import event.
	 */
	onPostpone(accountSyncId: IdTuple, postponedUntil: number): Promise<void>

	/**
	 * onFinish IMAP import event.
	 */
	onFinish(accountSyncId: IdTuple, downloadedQuota: number): Promise<void>

	/**
	 * onError IMAP import event.
	 */
	onError(accountSyncId: IdTuple, imapError: ImapError): Promise<void>
}
