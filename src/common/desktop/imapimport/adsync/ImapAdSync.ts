import { AdSyncEventListener, AdSyncEventType } from "./AdSyncEventListener.js"
import { ImapSyncSession } from "./ImapSyncSession.js"
import { ImapAccount, ImapSyncState } from "./ImapSyncState.js"
import { ImapError } from "./imapmail/ImapError"
import { ImapMailbox } from "../../../api/common/utils/imapImportUtils/ImapMailbox"

const defaultAdSyncConfig: AdSyncConfig = {
	isEnableParallelProcessesOptimizer: false,
	parallelProcessesOptimizationDifference: 2,
	processesTimeToLive: 15,
	isEnableDownloadBatchSizeOptimizer: false,
	downloadBatchSizeOptimizationDifference: 100,
	defaultDownloadBatchSize: 50,
	optimizationInterval: 10,
	emitAdSyncEventTypes: new Set<AdSyncEventType>([AdSyncEventType.CREATE]),
	isEnableImapQresync: true,
}

export interface AdSyncConfig {
	isEnableParallelProcessesOptimizer: boolean
	parallelProcessesOptimizationDifference: number
	processesTimeToLive: number
	isEnableDownloadBatchSizeOptimizer: boolean
	downloadBatchSizeOptimizationDifference: number
	defaultDownloadBatchSize: number
	optimizationInterval: number
	emitAdSyncEventTypes: Set<AdSyncEventType>
	isEnableImapQresync: boolean
}

export class ImapAdSync {
	private syncSession: ImapSyncSession

	constructor(adSyncEventListener: AdSyncEventListener, adSyncConfig: AdSyncConfig = defaultAdSyncConfig) {
		this.syncSession = new ImapSyncSession(adSyncEventListener, adSyncConfig)
	}

	async startAdSync(imapSyncState: ImapSyncState): Promise<ImapError | null> {
		return await this.syncSession.startSyncSession(imapSyncState)
	}

	async stopAdSync(): Promise<void> {
		return this.syncSession.stopSyncSession()
	}

	async getImapMailboxesFromServer(imapAccount: ImapAccount): Promise<ReadonlyArray<ImapMailbox>> {
		return await this.syncSession.getImapMailboxesFromServer(imapAccount)
	}
}
