import { ImapSyncSessionMailbox } from "./ImapSyncSessionMailbox.js"
import { AdSyncEventListener, AdSyncEventType } from "./AdSyncEventListener.js"
import { ImapAccount, ImapMailId } from "./ImapSyncState.js"
import { ImapMail } from "../../../api/common/utils/imapImportUtils/ImapMail.js"
import { AdSyncDownloadBatchSizeOptimizer } from "./optimizer/AdSyncDownloadBatchSizeOptimizer.js"
import { ImapError } from "./imapmail/ImapError.js"
import { ImapMailbox, ImapMailboxStatus } from "../../../api/common/utils/imapImportUtils/ImapMailbox.js"
import { AdSyncConfig } from "./ImapAdSync.js"
import { AdSyncProcessesOptimizerEventListener } from "./optimizer/processesoptimizer/AdSyncProcessesOptimizer.js"
import { DifferentialUidLoader, UID_FETCH_REQUEST_WAIT_TIME, UidFetchRequestType } from "./DifferentialUidLoader.js"
import { setTimeout } from "node:timers/promises"
import { assertNotNull, isEmpty, isNotEmpty, splitInChunks } from "@tutao/utils"
import { ImportImapFolderSyncStatus, MAX_NBR_OF_MAILS_SYNC_OPERATION } from "@tutao/app-env"
import { imapMailFromImapFlowFetchMessageObject } from "./imapmail/ImapImportUtils"
import { ImapFlow } from "./imapflow-custom.js"

export enum SyncSessionProcessState {
	NOT_STARTED,
	STOPPED,
	RUNNING,
	CONNECTION_FAILED_UNKNOWN,
	CONNECTION_FAILED_REJECTED,
}

export class ImapSyncSessionProcess {
	processId: number

	private state: SyncSessionProcessState = SyncSessionProcessState.NOT_STARTED
	private adSyncOptimizer: AdSyncDownloadBatchSizeOptimizer
	private adSyncProcessesOptimizerEventListener: AdSyncProcessesOptimizerEventListener
	private adSyncConfig: AdSyncConfig

	constructor(
		processId: number,
		adSyncOptimizer: AdSyncDownloadBatchSizeOptimizer,
		adSyncProcessesOptimizerEventListener: AdSyncProcessesOptimizerEventListener,
		adSyncConfig: AdSyncConfig,
	) {
		this.processId = processId
		this.adSyncOptimizer = adSyncOptimizer
		this.adSyncProcessesOptimizerEventListener = adSyncProcessesOptimizerEventListener
		this.adSyncConfig = adSyncConfig
	}

	async startSyncSessionProcess(imapAccount: ImapAccount, adSyncEventListener: AdSyncEventListener): Promise<SyncSessionProcessState> {
		const imapClient = new ImapFlow({
			host: imapAccount.host,
			port: imapAccount.port,
			secure: imapAccount.port === 993,
			auth: {
				user: imapAccount.username,
				pass: imapAccount.password,
				accessToken: imapAccount.tokenEndpointResponse?.access_token,
			},
			qresync: this.adSyncConfig.isEnableImapQresync,
		})

		this.setupImapFlowErrorHandler(imapClient, adSyncEventListener)

		try {
			await imapClient.connect()
			if (this.state === SyncSessionProcessState.NOT_STARTED) {
				this.runSyncSessionProcess(imapClient, adSyncEventListener)
				this.state = SyncSessionProcessState.RUNNING
			}
		} catch (error) {
			if (error.responseStatus !== undefined && error.responseStatus.match("(NO|BAD)")) {
				this.state = SyncSessionProcessState.CONNECTION_FAILED_REJECTED
			} else {
				this.state = SyncSessionProcessState.CONNECTION_FAILED_UNKNOWN
			}
		}
		return this.state
	}

	async stopSyncSessionProcess(): Promise<ImapSyncSessionMailbox> {
		this.state = SyncSessionProcessState.STOPPED
		this.adSyncOptimizer.stopAdSyncOptimizer()
		return this.adSyncOptimizer.optimizedSyncSessionMailbox
	}

	private async runSyncSessionProcess(imapClient: ImapFlow, adSyncEventListener: AdSyncEventListener) {
		let isMailboxFinished = false

		try {
			const imapQresyncImapMails: ImapMail[] = []
			const highestModSeq = this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState.highestModSeq

			// open mailbox readonly
			const mailboxObject = await imapClient.mailboxOpen(this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState.path, { readOnly: true })

			// emit ImapMailboxStatus and update SyncSessionMailbox
			const imapMailboxStatus = ImapMailboxStatus.fromImapFlowMailboxObject(mailboxObject)
			await adSyncEventListener.onMailboxStatus(imapMailboxStatus)
			this.updateSyncSessionMailbox(imapMailboxStatus)

			const openedImapMailbox = ImapMailbox.fromSyncSessionMailbox(this.adSyncOptimizer.optimizedSyncSessionMailbox)
			const isEnableImapQresync = this.adSyncConfig.isEnableImapQresync && highestModSeq != null

			if (isEnableImapQresync) {
				this.setupImapFlowExpungeHandler(imapClient, openedImapMailbox, adSyncEventListener)
			}

			// calculate UID differences
			const differentialUidLoader = new DifferentialUidLoader(
				imapClient,
				this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState.importedUidToMailIdsMap,
				isEnableImapQresync,
				this.adSyncConfig.emitAdSyncEventTypes,
			)

			differentialUidLoader
				.calculateUidDiff(
					this.adSyncOptimizer.optimizedSyncSessionMailbox.lastFetchedMailSeq,
					this.adSyncOptimizer.optimizedSyncSessionMailbox.downloadBatchSize,
					this.adSyncOptimizer.optimizedSyncSessionMailbox.mailCount,
				)
				.then((deletedUids) => {
					this.handleDeletedUids(deletedUids, openedImapMailbox, adSyncEventListener)
				})

			const fetchOptions = this.initFetchOptions(isEnableImapQresync)
			let nextUidFetchRequest = await differentialUidLoader.getNextUidFetchRequest(this.adSyncOptimizer.optimizedSyncSessionMailbox.downloadBatchSize)

			while (nextUidFetchRequest) {
				// wait for the differentialUidLoader to calculate more IMAP UID differences
				if (nextUidFetchRequest.fetchRequestType === UidFetchRequestType.WAIT) {
					await setTimeout(UID_FETCH_REQUEST_WAIT_TIME)
					nextUidFetchRequest = await differentialUidLoader.getNextUidFetchRequest(this.adSyncOptimizer.optimizedSyncSessionMailbox.downloadBatchSize)
					continue
				}

				this.adSyncOptimizer.optimizedSyncSessionMailbox.reportDownloadBatchSizeUsage(nextUidFetchRequest.usedDownloadBatchSize)

				const mails = imapClient.fetch(
					nextUidFetchRequest.uidFetchSequenceString,
					{
						uid: true,
						// @ts-ignore
						source: true,
						labels: true,
						size: true,
						flags: true,
						internalDate: true,
						headers: true,
					},
					fetchOptions,
				)

				let mailFetchStartTime = Date.now()
				const imapMailsCreate: ImapMail[] = []
				const imapMailsUpdate: ImapMail[] = []
				for await (const mail of mails) {
					if (this.state === SyncSessionProcessState.STOPPED) {
						await this.logout(imapClient, isMailboxFinished, mail.seq - 1)
						return
					}

					const mailFetchEndTime = Date.now()
					const mailFetchTime = mailFetchEndTime - mailFetchStartTime

					if (mail.source) {
						const mailSize = mail.source.length
						const mailDownloadTime = mailFetchTime !== 0 ? mailFetchTime : 0.5 // we approximate the mailFetchTime to minimum 0.5 millisecond
						const currenThroughput = mailSize / mailDownloadTime
						this.adSyncOptimizer.optimizedSyncSessionMailbox.reportCurrentThroughput(currenThroughput)

						this.adSyncProcessesOptimizerEventListener.onDownloadUpdate(this.processId, this.adSyncOptimizer.optimizedSyncSessionMailbox, mailSize)

						const imapMail = await imapMailFromImapFlowFetchMessageObject(
							mail,
							openedImapMailbox,
							this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState.importedUidToMailIdsMap.get(mail.uid),
						)

						switch (nextUidFetchRequest.fetchRequestType) {
							case UidFetchRequestType.CREATE:
								this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState.importedUidToMailIdsMap.set(
									imapMail.uid,
									new ImapMailId(imapMail.uid),
								)
								if (this.adSyncConfig.emitAdSyncEventTypes.has(AdSyncEventType.CREATE)) {
									imapMailsCreate.push(imapMail)
								}
								break
							case UidFetchRequestType.UPDATE:
								if (this.adSyncConfig.emitAdSyncEventTypes.has(AdSyncEventType.UPDATE)) {
									imapMailsUpdate.push(imapMail)
								}
								break
							case UidFetchRequestType.QRESYNC:
								imapQresyncImapMails.push(imapMail)
								break
						}
					} else {
						adSyncEventListener.onError(new ImapError(`No IMAP mail source available for IMAP mail with UID ${mail.uid}.`))
					}

					mailFetchStartTime = Date.now()
				}

				const createChunks = splitInChunks(MAX_NBR_OF_MAILS_SYNC_OPERATION, imapMailsCreate)
				const updateChunks = splitInChunks(MAX_NBR_OF_MAILS_SYNC_OPERATION, imapMailsUpdate)
				for (const chunk of createChunks) {
					if (isNotEmpty(chunk)) {
						adSyncEventListener.onMultipleMails(chunk, AdSyncEventType.CREATE)
					}
				}
				for (const chunk of updateChunks) {
					if (isNotEmpty(chunk)) {
						adSyncEventListener.onMultipleMails(chunk, AdSyncEventType.UPDATE)
					}
				}
				nextUidFetchRequest = await differentialUidLoader.getNextUidFetchRequest(this.adSyncOptimizer.optimizedSyncSessionMailbox.downloadBatchSize)
			}

			if (isEnableImapQresync) {
				this.handleQresyncFetchResult(imapQresyncImapMails, adSyncEventListener)
			}

			isMailboxFinished = true
			imapMailboxStatus.setSyncStatus(ImportImapFolderSyncStatus.Finished)
			await adSyncEventListener.onMailboxStatus(imapMailboxStatus)
		} catch (error: any) {
			adSyncEventListener.onError(new ImapError(error))
		} finally {
			await this.logout(imapClient, isMailboxFinished)
		}
	}

	private async logout(imapClient: ImapFlow, isMailboxFinished: boolean, lastFetchedMailSeq: number = 0) {
		await imapClient.logout()

		if (isMailboxFinished) {
			this.adSyncProcessesOptimizerEventListener.onMailboxFinish(this.processId, this.adSyncOptimizer.optimizedSyncSessionMailbox)
		} else {
			this.adSyncOptimizer.optimizedSyncSessionMailbox.lastFetchedMailSeq = lastFetchedMailSeq
			this.adSyncProcessesOptimizerEventListener.onMailboxInterrupted(this.processId, this.adSyncOptimizer.optimizedSyncSessionMailbox)
		}
	}

	private initFetchOptions(isEnableImapQresync: boolean) {
		let fetchOptions
		if (isEnableImapQresync) {
			const highestModSeq = [...this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState.importedUidToMailIdsMap.values()].reduce<bigint>(
				(acc, imapMailIds) => (imapMailIds.modSeq && imapMailIds.modSeq > acc ? imapMailIds.modSeq : acc),
				BigInt(0),
			)
			fetchOptions = {
				uid: true,
				changedSince: highestModSeq,
			}
		} else {
			fetchOptions = {
				uid: true,
			}
		}
		return fetchOptions
	}

	private handleQresyncFetchResult(imapMails: ImapMail[], adSyncEventListener: AdSyncEventListener) {
		const mailUpdates = imapMails.filter((imapMail) =>
			this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState.importedUidToMailIdsMap.has(imapMail.uid),
		)

		const mailCreates = imapMails.filter(
			(imapMail) => !this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState.importedUidToMailIdsMap.has(imapMail.uid),
		)

		if (!isEmpty(mailUpdates) && this.adSyncConfig.emitAdSyncEventTypes.has(AdSyncEventType.UPDATE)) {
			const chunks = splitInChunks(MAX_NBR_OF_MAILS_SYNC_OPERATION, mailUpdates)
			for (const chunk of chunks) {
				adSyncEventListener.onMultipleMails(chunk, AdSyncEventType.UPDATE)
			}
		} else if (!isEmpty(mailCreates) && this.adSyncConfig.emitAdSyncEventTypes.has(AdSyncEventType.CREATE)) {
			for (const imapMail of imapMails) {
				this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState.importedUidToMailIdsMap.set(imapMail.uid, new ImapMailId(imapMail.uid))
			}
			const chunks = splitInChunks(MAX_NBR_OF_MAILS_SYNC_OPERATION, mailCreates)
			for (const chunk of chunks) {
				adSyncEventListener.onMultipleMails(chunk, AdSyncEventType.CREATE)
			}
		}
	}

	private updateSyncSessionMailbox(imapMailboxStatus: ImapMailboxStatus) {
		const mailboxState = this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState
		mailboxState.uidValidity = imapMailboxStatus.uidValidity
		mailboxState.uidNext = imapMailboxStatus.uidNext
		mailboxState.highestModSeq = imapMailboxStatus.highestModSeq

		this.adSyncOptimizer.optimizedSyncSessionMailbox.mailCount = imapMailboxStatus.messageCount ?? null
	}

	private async handleDeletedUids(deletedUids: number[], openedImapMailbox: ImapMailbox, adSyncEventListener: AdSyncEventListener) {
		for (const deletedUid of deletedUids) {
			this.emitImapMailDeleteEvent(deletedUid, openedImapMailbox, adSyncEventListener)
		}
	}

	private setupImapFlowErrorHandler(imapClient: ImapFlow, adSyncEventListener: AdSyncEventListener) {
		imapClient.on("error", (error) => {
			adSyncEventListener.onError(new ImapError(error))
			this.logout(imapClient, false)
		})
	}

	// emit DELETE events when IMAP QRESYNC is enabled and supported
	private setupImapFlowExpungeHandler(imapClient: ImapFlow, openedImapMailbox: ImapMailbox, adSyncEventListener: AdSyncEventListener) {
		imapClient.on("expunge", (deletedMail) => {
			this.emitImapMailDeleteEvent(assertNotNull(deletedMail.uid), openedImapMailbox, adSyncEventListener)
		})
	}

	private emitImapMailDeleteEvent(deletedUid: number, openedImapMailbox: ImapMailbox, adSyncEventListener: AdSyncEventListener) {
		if (this.adSyncConfig.emitAdSyncEventTypes.has(AdSyncEventType.DELETE)) {
			const imapMail = new ImapMail(deletedUid, openedImapMailbox)
			this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState.importedUidToMailIdsMap.delete(deletedUid)
			adSyncEventListener.onMultipleMails([imapMail], AdSyncEventType.DELETE)
		}
	}
}
