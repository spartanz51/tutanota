import { OfflineStoragePersistence } from "./OfflineStoragePersistence"
import { MailIndexer } from "./MailIndexer"
import { FULL_INDEXED_TIMESTAMP, NOTHING_INDEXED_TIMESTAMP } from "@tutao/app-env"
import { User } from "../../../typerefs/entities/sys/TypeRefs"
import { EntityUpdateData } from "../../../typerefs/EntityUpdateUtils"
import { BlobFacade } from "../../../common/api/worker/facades/lazy/BlobFacade"
import { lazyAsync } from "@tutao/utils"
import { EntityClient } from "../../../common/api/common/EntityClient"

/**
 * Mail indexer that efficiently indexes the entire user (i.e. all mailboxes they have access to)
 */
export class OfflineMailIndexer implements MailIndexer {
	constructor(
		private readonly offlineStoragePersistence: OfflineStoragePersistence,
		private readonly blobs: lazyAsync<BlobFacade>,
		private readonly entityRestClient: EntityClient,
	) {}

	private fullyIndexed: boolean = false

	get currentIndexTimestamp(): number {
		return this.fullyIndexed ? FULL_INDEXED_TIMESTAMP : NOTHING_INDEXED_TIMESTAMP
	}

	async init(user: User): Promise<void> {
		// FIXME
	}

	get mailIndexingEnabled(): boolean {
		return true
	}

	async afterMailCreated(mailid: IdTuple): Promise<void> {
		// FIXME
	}

	async afterMailDeleted(mailid: IdTuple): Promise<void> {
		// FIXME
	}

	async afterMailUpdated(mailid: IdTuple): Promise<void> {
		// FIXME
	}

	async beforeMailDeleted(mailid: IdTuple): Promise<void> {
		// FIXME
	}

	async processEntityEvents(events: readonly EntityUpdateData[]): Promise<void> {
		// FIXME
	}

	async rebuildIndex(user: User): Promise<void> {
		// FIXME
	}

	async extendMailIndex(): Promise<void> {
		// FIXME: This should catch any new mailboxes
	}
}
