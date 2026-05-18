import { AdSyncEventType } from "../../../common/desktop/imapimport/adsync/AdSyncEventListener"
import {
	getFolderSyncStateForMailboxPath,
	ImapImportState,
	imapMailToImportMailParams,
	importImapAccountToImapAccount,
	ImportState,
} from "../../../common/api/common/utils/imapImportUtils/ImapImportUtils.js"
import { ImapAccount, ImapMailboxState, ImapMailId, ImapSyncState } from "../../../common/desktop/imapimport/adsync/ImapSyncState.js"
import { ImapMailbox, ImapMailboxStatus } from "../../../common/api/common/utils/imapImportUtils/ImapMailbox.js"
import { ImapMail, ImapMailAttachment } from "../../../common/api/common/utils/imapImportUtils/ImapMail.js"
import { ImapError } from "../../../common/desktop/imapimport/adsync/imapmail/ImapError.js"

import { assertNotNull, first, getFirstOrThrow, isEmpty, uint8ArrayToString } from "@tutao/utils"
import { sha256Hash } from "@tutao/crypto"
import { MaybePromise } from "rollup"
import { elementIdPart, tutanotaTypeRefs } from "@tutao/typerefs"
import { ProgrammingError } from "@tutao/app-env"
import { ImapImportDataFile, ImapImportTutanotaFileId, ImportMailFacade, ImportMailParams } from "../../../common/api/worker/facades/lazy/ImportMailFacade"
import { SuspensionError } from "../../../common/api/common/error/SuspensionError"
import { ImapImportFacade } from "../../../common/native/common/generatedipc/ImapImportFacade"
import { ImapImportSystemFacade } from "../../../common/native/common/generatedipc/ImapImportSystemFacade"
import { ImportImapFacade } from "../../../common/api/worker/facades/lazy/ImportImapFacade"
import { ImapGetMailboxResult } from "../../../common/desktop/imapimport/adsync/imapmail/ImapGetMailboxResult"
import { ImapImportSession } from "./ImapImportSession"
import { ImapProvider } from "../../../common/api/common/utils/imapImportUtils/ImapKnownConfigs"

const DEFAULT_TUTANOTA_SERVER_POSTPONE_TIME = 120 * 1000 // 120 seconds

type BaseInitializeImapImportParams = {
	importImapAccount: tutanotaTypeRefs.ImportImapAccount
	maxQuota: string
	isModifyingExistingImport: boolean
	imapSyncLabelData: tutanotaTypeRefs.ManageLabelServiceLabelData | null
	mailGroupId: Id
	provider: ImapProvider
}

export type InitializeImapImportParams =
	| (BaseInitializeImapImportParams & {
			matchImportFoldersToTutanotaFolders: true
			imapMailboxesToTutaFolders: Map<string, Id>
			rootImportMailFolderName?: never
	  })
	| (BaseInitializeImapImportParams & {
			matchImportFoldersToTutanotaFolders: false

			rootImportMailFolderName: string

			imapMailboxesToTutaFolders?: never
	  })

export type ImapOk = { state: ImapImportState; remoteStateId?: IdTuple }

// fixme can we type it in a way that remote state id is always there for "successful" states?
export type ImportResult = {
	result: ImapOk
	error?: ImapError
}

// fixme since this class is so stateful, it is difficult to refactor it to make multiple simultaneous imports work
export class ImapImporter implements ImapImportFacade {
	private sessions: Map<string, ImapImportSession> = new Map()

	constructor(
		private readonly imapImportSystemFacade: ImapImportSystemFacade,
		private readonly importImapFacade: ImportImapFacade,
		private readonly importMailFacade: ImportMailFacade,
	) {}

	/**
		TODO: This function has side effects *AND* returns data, perhaps do only one of those?
	 */
	async initializeImport(initializeParams: InitializeImapImportParams): Promise<ImportResult> {
		const syncState = await this.getImportImapAccountSyncState(initializeParams)
		let accountSyncState: tutanotaTypeRefs.ImportImapAccountSyncState

		if (syncState == null) {
			accountSyncState = await this.importImapFacade.initializeImapImport(initializeParams)
		} else {
			accountSyncState = await this.importImapFacade.updateImapImport(initializeParams, syncState)
		}

		// Create the session object immediately
		const session = new ImapImportSession(accountSyncState)
		session.imapMailboxesToTutaFolders = initializeParams.imapMailboxesToTutaFolders ?? new Map()

		if (accountSyncState.postponedUntil) {
			session.imapImportState = new ImapImportState(ImportState.PAUSED, new Date(parseInt(accountSyncState.postponedUntil)))
		}

		this.sessions.set(this.getSessionsMapKey(accountSyncState._id), session)

		return { result: { state: session.imapImportState, remoteStateId: accountSyncState._id } }
	}

	private async getImportImapAccountSyncState(initializeParams: InitializeImapImportParams) {
		return first(
			(await this.getImportImapAccountSyncStatesForMailGroup(initializeParams.mailGroupId)).filter(
				(accountSyncState) => accountSyncState.imapAccount.userName === initializeParams.importImapAccount.userName,
			),
		)
	}

	/**
	 * Attempts to continue an import from existing state, may return errors in case of failure.
	 */
	async continueImport(imapAccountSyncStateId: IdTuple): Promise<ImportResult> {
		const session = assertNotNull(this.getSessionOrNull(imapAccountSyncStateId))
		if (session.imapImportState.state === ImportState.RUNNING) {
			return { result: { state: session.imapImportState, remoteStateId: session.importImapAccountSyncState._id } }
		}

		if (session.imapImportState.state === ImportState.POSTPONED && session.imapImportState.postponedUntil.getTime() > Date.now()) {
			session.imapImportState.state = ImportState.POSTPONED
			return { result: { state: session.imapImportState, remoteStateId: session.importImapAccountSyncState._id } }
		}

		session.importImapAccountSyncState = await this.loadImportImapAccountSyncStateById(imapAccountSyncStateId)

		const postponedUntil = session.importImapAccountSyncState.postponedUntil
		if (postponedUntil) {
			session.imapImportState.postponedUntil = new Date(Number.parseInt(postponedUntil))
		}

		if (session.imapImportState.postponedUntil.getTime() > Date.now()) {
			session.imapImportState.state = ImportState.POSTPONED
			return { result: { state: session.imapImportState, remoteStateId: session.importImapAccountSyncState._id } }
		}

		const imapAccount = importImapAccountToImapAccount(session.importImapAccountSyncState.imapAccount)
		const maxQuota = parseInt(session.importImapAccountSyncState.maxQuota)
		const imapMailboxStates = await this.getAllImapMailboxStates(session)
		const imapSyncState = new ImapSyncState(imapAccount, maxQuota, imapMailboxStates)

		session.deduplicatedImportedAttachmentHashToFileId = await this.getImportedImapAttachmentHashToIdMap(session)

		const startImportResult = await this.imapImportSystemFacade.startImport(imapAccountSyncStateId, imapSyncState)

		if (startImportResult !== null) {
			session.imapImportState = new ImapImportState(ImportState.PAUSED)
			return Promise.resolve({ error: startImportResult, result: { state: session.imapImportState } })
		} else {
			session.imapImportState = new ImapImportState(ImportState.RUNNING)
			return Promise.resolve({ result: { state: session.imapImportState, remoteStateId: session.importImapAccountSyncState._id } })
		}
	}

	async pauseImport(accountSyncStateId: IdTuple): Promise<ImapImportState> {
		const session = this.getSessionOrNull(accountSyncStateId)
		if (session !== null) {
			await this.imapImportSystemFacade.stopImport(session.importImapAccountSyncState._id)
			await this.importImapFacade.pauseImapImport(session.importImapAccountSyncState._id)
			session.imapImportState = new ImapImportState(ImportState.PAUSED)
		}
		return Promise.resolve(new ImapImportState(ImportState.PAUSED))
	}

	async postponeImport(accountSyncStateId: IdTuple, postponedUntil: Date): Promise<ImapImportState> {
		const session = this.getSessionOrNull(accountSyncStateId)
		if (session !== null) {
			await this.imapImportSystemFacade.stopImport(session.importImapAccountSyncState._id)
			await this.importImapFacade.postponeImapImport(postponedUntil, session.importImapAccountSyncState?._id)
			session.imapImportState = new ImapImportState(ImportState.POSTPONED, postponedUntil)
			return session.imapImportState
		} else {
			return new ImapImportState(ImportState.NOT_INITIALIZED)
		}
	}

	async deleteImport(importImapAccountSyncStateId: IdTuple): Promise<boolean> {
		await this.importImapFacade.deleteImapImport(importImapAccountSyncStateId)
		await this.imapImportSystemFacade.stopImport(importImapAccountSyncStateId)
		this.sessions.delete(this.getSessionsMapKey(importImapAccountSyncStateId))
		return Promise.resolve(true)
	}

	async getImapMailboxesFromServer(imapAccount: ImapAccount): Promise<ImapGetMailboxResult> {
		return await this.imapImportSystemFacade.getImapMailboxesFromServer(imapAccount)
	}

	async getImportImapAccountSyncStatesForMailGroup(mailGroupId: Id): Promise<tutanotaTypeRefs.ImportImapAccountSyncState[]> {
		return Promise.resolve(this.importImapFacade.getImportImapAccountSyncStatesForMailGroup(mailGroupId))
	}

	async loadImportImapAccountSyncStateById(importImapAccountSyncStateId: IdTuple): Promise<tutanotaTypeRefs.ImportImapAccountSyncState> {
		return Promise.resolve(this.importImapFacade.getImportImapAccountSyncStateById(importImapAccountSyncStateId))
	}

	loadImapImportState(accountSyncStateId: IdTuple): Promise<ImapImportState> {
		const session = this.getSessionOrNull(accountSyncStateId)
		return Promise.resolve(session?.imapImportState ?? new ImapImportState(ImportState.NOT_INITIALIZED))
	}

	async loadAllImportImapFolderSyncStates(importImapFolderSyncStateListId: Id): Promise<tutanotaTypeRefs.ImportImapFolderSyncState[]> {
		return this.importImapFacade.getAllImportImapFolderSyncStates(importImapFolderSyncStateListId)
	}

	private async getAllImapMailboxStates(session: ImapImportSession): Promise<ImapMailboxState[]> {
		const imapMailboxStates: ImapMailboxState[] = []
		session.importImapFolderSyncStates = await this.loadAllImportImapFolderSyncStates(session.importImapAccountSyncState.imapFolderSyncStateList)

		for (const folderSyncState of session.importImapFolderSyncStates) {
			const importedImapUidToImapMailId = new Map<number, ImapMailId>()
			const importedImapMails = await this.importImapFacade.getImportedMails(folderSyncState.importedMails)
			for (const importedImapMail of importedImapMails) {
				const imapUid = parseInt(importedImapMail.imapUid)
				const importedImapMailId = new ImapMailId(imapUid)
				if (importedImapMail.imapModSeq !== null) {
					importedImapMailId.modSeq = BigInt(importedImapMail.imapModSeq)
				}
				importedImapMailId.messageId = importedImapMail.messageId
				session.importedMessageIds.add(importedImapMail.messageId)

				importedImapUidToImapMailId.set(imapUid, importedImapMailId)
			}

			const imapMailboxState = new ImapMailboxState(folderSyncState.path, importedImapUidToImapMailId)
			imapMailboxState.uidNext = folderSyncState.uidnext ? parseInt(folderSyncState.uidnext) : undefined
			imapMailboxState.uidValidity = folderSyncState.uidvalidity ? BigInt(folderSyncState.uidvalidity) : undefined
			imapMailboxState.highestModSeq = folderSyncState.highestmodseq ? BigInt(folderSyncState.highestmodseq) : null

			imapMailboxStates.push(imapMailboxState)
		}

		return imapMailboxStates
	}

	private async getImportedImapAttachmentHashToIdMap(session: ImapImportSession): Promise<Map<string, MaybePromise<IdTuple>>> {
		const importedImapAttachmentHashToIdMap = new Map<string, MaybePromise<IdTuple>>()
		const importedImapAttachmentHashToIdMapList = await this.importImapFacade.getDeduplicatedImportedAttachmentsList(
			assertNotNull(session.importImapAccountSyncState._ownerGroup),
		)

		for (const importedImapAttachmentHashToId of importedImapAttachmentHashToIdMapList) {
			const imapAttachmentHash = importedImapAttachmentHashToId.attachmentHash
			const attachmentId = importedImapAttachmentHashToId.attachment
			importedImapAttachmentHashToIdMap.set(imapAttachmentHash, attachmentId)
		}

		return importedImapAttachmentHashToIdMap
	}

	private async performAttachmentDeduplication(session: ImapImportSession, imapMailAttachments: ImapMailAttachment[]) {
		const deduplicatedAttachments = imapMailAttachments.map(async (imapMailAttachment) => {
			// calculate fileHash to perform IMAP import attachment de-duplication
			const fileHash = uint8ArrayToString("utf-8", sha256Hash(imapMailAttachment.content))

			if (session.deduplicatedImportedAttachmentHashToFileId?.has(fileHash)) {
				const attachmentId = await session.deduplicatedImportedAttachmentHashToFileId.get(fileHash)
				if (attachmentId) {
					const imapImportTutanotaFileId: ImapImportTutanotaFileId = {
						_type: "ImapImportTutanotaFileId",
						_id: attachmentId,
					}
					return imapImportTutanotaFileId
				}
			}

			// eslint-disable-next-line no-async-promise-executor
			const deferredAttachmentId: Promise<IdTuple | undefined> = new Promise(async (resolve) => {
				session.deduplicatedImportedAttachmentHashToFileId = await this.getImportedImapAttachmentHashToIdMap(session)
				resolve(session.deduplicatedImportedAttachmentHashToFileId.get(fileHash))
			})

			session.deduplicatedImportedAttachmentHashToFileId?.set(fileHash, deferredAttachmentId)
			const importDataFile: ImapImportDataFile = {
				_type: "DataFile",
				name: imapMailAttachment.filename ?? fileHash,
				data: imapMailAttachment.content,
				size: imapMailAttachment.size,
				mimeType: imapMailAttachment.contentType,
				cid: imapMailAttachment.cid,
				fileHash: fileHash,
			}
			return importDataFile
		})

		return Promise.all(deduplicatedAttachments)
	}

	async onMailbox(accountSyncStateId: IdTuple, imapMailbox: ImapMailbox, eventType: AdSyncEventType): Promise<void> {
		const session = assertNotNull(this.getSessionOrNull(accountSyncStateId))

		switch (eventType) {
			case AdSyncEventType.CREATE: {
				let parentFolderId = session.importImapAccountSyncState.rootImportMailFolder
				if (imapMailbox.parentFolder) {
					const parentFolderSyncState = getFolderSyncStateForMailboxPath(imapMailbox.parentFolder.path, session.importImapFolderSyncStates ?? [])
					parentFolderId = parentFolderSyncState?.mailFolder ? parentFolderSyncState.mailFolder : null
				}

				const newFolderSyncState = await this.importImapFacade.createImportMailFolder(
					imapMailbox,
					session.importImapAccountSyncState,
					parentFolderId,
					session.imapMailboxesToTutaFolders ?? undefined,
				)

				if (newFolderSyncState) {
					session.importImapFolderSyncStates?.push(newFolderSyncState)
					if (session.imapMailboxesToTutaFolders && !session.imapMailboxesToTutaFolders.has(imapMailbox.path)) {
						session.imapMailboxesToTutaFolders.set(imapMailbox.path, elementIdPart(newFolderSyncState.mailFolder))
					}
				}
				break
			}
			case AdSyncEventType.UPDATE:
				// TODO update mail folder through existing Tutanota API's
				break
			case AdSyncEventType.DELETE:
				// TODO delete mail folder through existing Tutanota API's
				break
		}

		return Promise.resolve()
	}

	async onMailboxStatus(accountSyncStateId: IdTuple, imapMailboxStatus: ImapMailboxStatus): Promise<void> {
		const session = assertNotNull(this.getSessionOrNull(accountSyncStateId))
		if (session.importImapFolderSyncStates === undefined) {
			throw new ProgrammingError("onMailboxStatus event received but importImapFolderSyncStates not initialized!")
		}

		const folderSyncState = getFolderSyncStateForMailboxPath(imapMailboxStatus.path, session.importImapFolderSyncStates)
		if (folderSyncState) {
			const newFolderSyncState = await this.importImapFacade.updateImportImapFolderSyncState(imapMailboxStatus, folderSyncState)

			const index = session.importImapFolderSyncStates.findIndex((folderSyncState) => folderSyncState.path === newFolderSyncState.path)
			session.importImapFolderSyncStates[index] = newFolderSyncState
		}

		return Promise.resolve()
	}

	async onMultipleMails(accountSyncStateId: IdTuple, imapMails: ImapMail[], eventType: AdSyncEventType) {
		const session = assertNotNull(this.getSessionOrNull(accountSyncStateId))
		if (isEmpty(imapMails)) {
			return Promise.resolve()
		}

		const folderSyncState = getFolderSyncStateForMailboxPath(getFirstOrThrow(imapMails).belongsToMailbox.path, session.importImapFolderSyncStates)
		const importMailParamsList: ImportMailParams[] = []
		for (const imapMail of imapMails) {
			if (folderSyncState) {
				const deduplicatedAttachments = imapMail.attachments ? await this.performAttachmentDeduplication(session, imapMail.attachments) : []
				const importMailParams = imapMailToImportMailParams(imapMail, folderSyncState._id, deduplicatedAttachments)
				// we don't want to import mails that are already imported
				// CREATE events are also triggered if the mail has been moved or copied
				const messageId = imapMail.envelope?.messageId
				if (messageId && !session.importedMessageIds.has(messageId)) {
					importMailParamsList.push(importMailParams)
				}
			}
		}
		switch (eventType) {
			case AdSyncEventType.CREATE: {
				this.importMailFacade.importMails(importMailParamsList, assertNotNull(folderSyncState?._ownerGroup)).catch((error: Error) => {
					if (error instanceof SuspensionError) {
						this.postponeImport(
							accountSyncStateId,
							new Date(Date.now() + (error.data ? parseInt(error.data) : DEFAULT_TUTANOTA_SERVER_POSTPONE_TIME)),
						)
					} else {
						//FIXME: Keep this for now as there was no other error warning when failing.
						console.log("There was some other error while importing...", error)
					}
				})
				break
			}
			case AdSyncEventType.UPDATE:
				// TODO update mail properties through existing Tutanota API's (unread / read, etc.)
				break
			case AdSyncEventType.DELETE:
				// TODO delete mail through existing Tutanota API's
				break
		}

		return Promise.resolve()
	}

	async onPostpone(accountSyncStateId: IdTuple, postponedUntil: number): Promise<void> {
		await this.postponeImport(accountSyncStateId, new Date(postponedUntil))
		return Promise.resolve()
	}

	async onFinish(accountSyncStateId: IdTuple, downloadedQuota: number): Promise<void> {
		const session = assertNotNull(this.getSessionOrNull(accountSyncStateId))
		session.imapImportState = new ImapImportState(ImportState.FINISHED)
		if (session.importImapAccountSyncState) {
			await this.importImapFacade.setAllImportImapFolderSyncStatesToFinished(accountSyncStateId)
		}
		return Promise.resolve()
	}

	onError(accountSyncStateId: IdTuple, imapError: ImapError): Promise<void> {
		const session = this.getSessionOrNull(accountSyncStateId)
		if (session) {
			session.imapImportState = new ImapImportState(ImportState.NOT_INITIALIZED)
		}
		console.error("IMAP error:", accountSyncStateId, imapError)
		return Promise.resolve()
	}

	private getSessionsMapKey(id: IdTuple): string {
		return id.join("/")
	}

	private getSessionOrNull(accountSyncId: IdTuple): ImapImportSession | null {
		const session = this.sessions.get(this.getSessionsMapKey(accountSyncId))
		return session ?? null
	}
}
