import { entityUpdateUtils, sysTypeRefs } from "@tutao/typerefs"

export interface MailIndexer {
	readonly currentIndexTimestamp: number
	readonly mailIndexingEnabled: boolean

	init(user: sysTypeRefs.User): Promise<void>
	processEntityEvents(events: readonly entityUpdateUtils.EntityUpdateData[], groupId: Id, batchId: Id): Promise<void>
	beforeMailDeleted(mailid: IdTuple): Promise<void>
	afterMailDeleted(mailid: IdTuple): Promise<void>
	afterMailCreated(mailid: IdTuple): Promise<void>
	afterMailUpdated(mailid: IdTuple): Promise<void>
	rebuildIndex(user: sysTypeRefs.User): Promise<void>
	extendMailIndex(): Promise<void>
}
