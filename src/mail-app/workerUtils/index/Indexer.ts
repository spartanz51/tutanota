import { entityUpdateUtils, sysTypeRefs } from "@tutao/typerefs"

export interface IndexerInitParams {
	user: sysTypeRefs.User
	retryOnError?: boolean
}

export interface Indexer {
	/** Init upon partial login */
	partialLoginInit(): Promise<void>

	/** Init upon full login */
	fullLoginInit(params: IndexerInitParams): Promise<void>

	enableMailIndexing(): Promise<void>

	disableMailIndexing(): Promise<void>

	processEntityEvents(updates: readonly entityUpdateUtils.EntityUpdateData[], batchId: Id, groupId: Id, isInitialSyncDone: boolean): Promise<void>

	/**
	 * Extends the mail index to the given timestamp.
	 *
	 * Does nothing if it is already at least as far back as the timestamp.
	 *
	 * @param time timestamp
	 */
	extendMailIndex(time: number): Promise<void>

	deleteIndex(userId: string): Promise<void>

	rebuildMailIndex(): Promise<void>

	cancelMailIndexing(): void
}
