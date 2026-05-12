import { entityUpdateUtils, sysTypeRefs } from "@tutao/typerefs"

export interface MailIndexer {
	readonly currentIndexTimestamp: number
	readonly mailIndexingEnabled: boolean
	readonly mailboxIndexingPromise: Promise<void>

	init(user: sysTypeRefs.User): Promise<void>
	enableMailIndexing(): Promise<boolean>
	cancelMailIndexing(): void
	doInitialMailIndexing(user: sysTypeRefs.User): Promise<void>
	indexMailboxes(user: sysTypeRefs.User, oldestTimestamp: number): Promise<void>
	extendIndexIfNeeded(user: sysTypeRefs.User, newOldestTimestamp: number): Promise<void>
	resizeMailIndex(user: sysTypeRefs.User, newTimestamp: number): Promise<void>
	updateCurrentIndexTimestamp(user: sysTypeRefs.User): Promise<void>
	processEntityEvents(events: readonly entityUpdateUtils.EntityUpdateData[], groupId: Id, batchId: Id): Promise<void>
	beforeMailDeleted(mailid: IdTuple): Promise<void>
	afterMailDeleted(mailid: IdTuple): Promise<void>
	afterMailCreated(mailid: IdTuple): Promise<void>
	afterMailUpdated(mailid: IdTuple): Promise<void>
	rebuildIndex(user: sysTypeRefs.User): Promise<void>
}
