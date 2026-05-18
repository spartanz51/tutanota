/**
 * The ImportImapFacade is responsible for initializing (and terminating) an IMAP import process on the Tutanota server.
 * The ImportImapFacade is also responsible for initializing the ImportImapFolderSyncState for a single Tutanota folder.
 * The ImportImapFolderSyncState is needed to store relevant IMAP synchronization information for a single folder, most importantly the UID to TutanotaID map.
 * The facade communicates directly with the ImportImapService and the ImportImapFolderService.
 */
import { aes256RandomKey, encryptKey } from "@tutao/crypto"
import { MailFacade } from "./MailFacade.js"
import { IServiceExecutor } from "../../../common/ServiceRequest.js"
import { EntityClient } from "../../../common/EntityClient.js"
import { tutanotaServices, tutanotaTypeRefs } from "@tutao/typerefs"
import { ImportImapFolderSyncStatus } from "@tutao/app-env"
import { InitializeImapImportParams } from "../../../../../mail-app/workerUtils/imapimport/ImapImporter"
import { ImapMailbox, ImapMailboxStatus } from "../../../common/utils/imapImportUtils/ImapMailbox"
import { KeyLoaderFacade } from "../KeyLoaderFacade"
import { assertNotNull } from "@tutao/utils"

export class ImportImapFacade {
	constructor(
		private readonly mailFacade: MailFacade,
		private readonly serviceExecutor: IServiceExecutor,
		private readonly entityClient: EntityClient,
		private readonly keyLoader: KeyLoaderFacade,
	) {}

	async initializeImapImport(initializeParams: InitializeImapImportParams): Promise<tutanotaTypeRefs.ImportImapAccountSyncState> {
		const mailGroupId = initializeParams.mailGroupId

		if (initializeParams.rootImportMailFolderName === "" && !initializeParams.matchImportFoldersToTutanotaFolders) {
			throw new Error("Either rootImportMailFolderName or matchImportFoldersToTutanotaFolders must be set")
		}
		let rootImportMailFolderId: IdTuple | null = null
		if (initializeParams.rootImportMailFolderName) {
			rootImportMailFolderId = await this.mailFacade.createMailFolder(initializeParams.rootImportMailFolderName, null, mailGroupId)
		}

		const importImapAccount = tutanotaTypeRefs.createImportImapAccount({
			host: initializeParams.importImapAccount.host,
			port: initializeParams.importImapAccount.port.toString(),
			userName: initializeParams.importImapAccount.userName,
			password: initializeParams.importImapAccount.password,
			tokenEndpointResponse: initializeParams.importImapAccount.tokenEndpointResponse,
		})

		const mailGroupKey = await this.keyLoader.getCurrentSymGroupKey(mailGroupId)
		const sk = aes256RandomKey()
		const importImapPostIn = tutanotaTypeRefs.createImportImapPostIn({
			ownerEncSessionKey: encryptKey(mailGroupKey.object, sk),
			ownerGroup: mailGroupId,
			imapAccount: importImapAccount,
			maxQuota: initializeParams.maxQuota,
			postponedUntil: Date.now().toString(),
			rootImportMailFolder: rootImportMailFolderId,
			labelData: initializeParams.imapSyncLabelData,
			provider: initializeParams.provider.toString(),
		})

		const importImapPostOut = await this.serviceExecutor.post(tutanotaServices.ImportImapService, importImapPostIn, { sessionKey: sk })
		return this.entityClient.load(tutanotaTypeRefs.ImportImapAccountSyncStateTypeRef, importImapPostOut.imapAccountSyncState)
	}

	async updateImapImport(
		initializeParams: InitializeImapImportParams,
		importImapAccountSyncState: tutanotaTypeRefs.ImportImapAccountSyncState,
	): Promise<tutanotaTypeRefs.ImportImapAccountSyncState> {
		const mailGroupId = initializeParams.mailGroupId

		const newRootImportMailFolderName = initializeParams.rootImportMailFolderName
		if (importImapAccountSyncState.rootImportMailFolder != null) {
			const rootImportMailFolder = await this.getRootImportFolder(importImapAccountSyncState.rootImportMailFolder)
			if (newRootImportMailFolderName !== null && newRootImportMailFolderName !== rootImportMailFolder?.name) {
				importImapAccountSyncState.rootImportMailFolder = await this.mailFacade.createMailFolder(
					assertNotNull(newRootImportMailFolderName),
					null,
					mailGroupId,
				)
			}
		}

		importImapAccountSyncState.imapAccount.host = initializeParams.importImapAccount.host
		importImapAccountSyncState.imapAccount.port = initializeParams.importImapAccount.port.toString()
		importImapAccountSyncState.imapAccount.userName = initializeParams.importImapAccount.userName
		importImapAccountSyncState.imapAccount.password = initializeParams.importImapAccount.password

		await this.entityClient.update(importImapAccountSyncState)
		return await this.entityClient.load(tutanotaTypeRefs.ImportImapAccountSyncStateTypeRef, importImapAccountSyncState._id)
	}

	async postponeImapImport(postponedUntil: Date, importImapAccountSyncStateId: IdTuple): Promise<tutanotaTypeRefs.ImportImapAccountSyncState> {
		const importImapAccountSyncState = await this.entityClient.load(tutanotaTypeRefs.ImportImapAccountSyncStateTypeRef, importImapAccountSyncStateId)
		importImapAccountSyncState.postponedUntil = postponedUntil.getTime().toString()

		await this.entityClient.update(importImapAccountSyncState)
		return importImapAccountSyncState
	}

	async pauseImapImport(importImapAccountSyncStateId: IdTuple): Promise<tutanotaTypeRefs.ImportImapAccountSyncState> {
		const importImapAccountSyncState = await this.entityClient.load(tutanotaTypeRefs.ImportImapAccountSyncStateTypeRef, importImapAccountSyncStateId)
		const imapFolderSyncStates = await this.getAllImportImapFolderSyncStates(importImapAccountSyncState.imapFolderSyncStateList)
		for (const imapFolderSyncState of imapFolderSyncStates) {
			imapFolderSyncState.status = ImportImapFolderSyncStatus.Paused
			await this.entityClient.update(imapFolderSyncState)
		}
		return importImapAccountSyncState
	}

	async setAllImportImapFolderSyncStatesToFinished(importImapAccountSyncStateId: IdTuple): Promise<tutanotaTypeRefs.ImportImapAccountSyncState> {
		const importImapAccountSyncState = await this.entityClient.load(tutanotaTypeRefs.ImportImapAccountSyncStateTypeRef, importImapAccountSyncStateId)
		const imapFolderSyncStates = await this.getAllImportImapFolderSyncStates(importImapAccountSyncState.imapFolderSyncStateList)
		for (const imapFolderSyncState of imapFolderSyncStates) {
			imapFolderSyncState.status = ImportImapFolderSyncStatus.Finished
			await this.entityClient.update(imapFolderSyncState)
		}
		return importImapAccountSyncState
	}

	async deleteImapImport(importImapAccountSyncStateId: IdTuple): Promise<void> {
		const importImapDeleteIn = tutanotaTypeRefs.createImportImapDeleteIn({ imapAccountSyncState: importImapAccountSyncStateId })
		await this.serviceExecutor.delete(tutanotaServices.ImportImapService, importImapDeleteIn, { sessionKey: aes256RandomKey() })
	}

	async createImportMailFolder(
		imapMailbox: ImapMailbox,
		importImapAccountSyncState: tutanotaTypeRefs.ImportImapAccountSyncState,
		parentFolderId: IdTuple | null,
		imapMailboxesToTutaFolders?: Map<string, Id>,
	): Promise<tutanotaTypeRefs.ImportImapFolderSyncState | undefined> {
		if (imapMailbox.name) {
			const mailGroupId = assertNotNull(importImapAccountSyncState._ownerGroup)
			// if a root folder is not set on importImapAccountSyncState, we try to match the folder to a Tutanota folder, if that fails, we create a new folder
			let mailFolderId: IdTuple
			if (importImapAccountSyncState.rootImportMailFolder == null && imapMailboxesToTutaFolders && imapMailboxesToTutaFolders.has(imapMailbox.path)) {
				mailFolderId = await this.findTutaFolderForImapMailbox(imapMailbox, mailGroupId, imapMailboxesToTutaFolders)
			} else {
				mailFolderId = await this.mailFacade.createMailFolder(imapMailbox.name, parentFolderId, mailGroupId)
			}

			const mailGroupKey = await this.keyLoader.getCurrentSymGroupKey(mailGroupId)
			const sk = aes256RandomKey()
			const importImapFolderPostIn = tutanotaTypeRefs.createImportImapFolderPostIn({
				ownerEncSessionKey: encryptKey(mailGroupKey.object, sk),
				ownerGroup: mailGroupId,
				path: imapMailbox.path,
				imapAccountSyncState: importImapAccountSyncState._id,
				mailFolder: mailFolderId,
			})

			const importImapFolderPostOut = await this.serviceExecutor.post(tutanotaServices.ImportImapFolderService, importImapFolderPostIn, {
				sessionKey: sk,
			})
			return this.entityClient.load(tutanotaTypeRefs.ImportImapFolderSyncStateTypeRef, importImapFolderPostOut.imapFolderSyncState)
		}
	}

	async updateImportImapFolderSyncState(
		imapMailboxStatus: ImapMailboxStatus,
		folderSyncState: tutanotaTypeRefs.ImportImapFolderSyncState,
	): Promise<tutanotaTypeRefs.ImportImapFolderSyncState> {
		folderSyncState.uidnext = imapMailboxStatus.uidNext.toString()
		folderSyncState.uidvalidity = imapMailboxStatus.uidValidity.toString()
		folderSyncState.highestmodseq = imapMailboxStatus.highestModSeq?.toString() ?? null // value null denotes that the mailbox doesn't support IMAP QRESYNC feature
		folderSyncState.status = imapMailboxStatus.syncStatus.toString()
		await this.entityClient.update(folderSyncState)
		return this.entityClient.load(tutanotaTypeRefs.ImportImapFolderSyncStateTypeRef, folderSyncState._id)
	}

	async getRootImportFolder(rootImportFolderId: IdTuple): Promise<tutanotaTypeRefs.MailSet | null> {
		return this.entityClient.load(tutanotaTypeRefs.MailSetTypeRef, rootImportFolderId)
	}

	async getImportImapAccountSyncStatesForMailGroup(mailGroupId: Id): Promise<tutanotaTypeRefs.ImportImapAccountSyncState[]> {
		const mailboxGroupRoot = await this.entityClient.load(tutanotaTypeRefs.MailboxGroupRootTypeRef, mailGroupId)
		const mailbox = await this.entityClient.load(tutanotaTypeRefs.MailBoxTypeRef, mailboxGroupRoot.mailbox)
		if (mailbox.imapAccountSyncStates == null) {
			return []
		}
		return await this.entityClient.loadAll(tutanotaTypeRefs.ImportImapAccountSyncStateTypeRef, mailbox.imapAccountSyncStates)
	}

	async getImportImapAccountSyncStateById(importImapAccountSyncStateId: IdTuple): Promise<tutanotaTypeRefs.ImportImapAccountSyncState> {
		return await this.entityClient.load(tutanotaTypeRefs.ImportImapAccountSyncStateTypeRef, importImapAccountSyncStateId)
	}

	async getAllImportImapFolderSyncStates(importImapFolderSyncStateListId: Id): Promise<tutanotaTypeRefs.ImportImapFolderSyncState[]> {
		return this.entityClient.loadAll(tutanotaTypeRefs.ImportImapFolderSyncStateTypeRef, importImapFolderSyncStateListId)
	}

	async getImportedMails(importedMailListId: Id): Promise<tutanotaTypeRefs.ImportedImapMail[]> {
		return this.entityClient.loadAll(tutanotaTypeRefs.ImportedImapMailTypeRef, importedMailListId)
	}

	async getDeduplicatedImportedAttachment(deduplicatedImportedAttachmentId: IdTuple): Promise<tutanotaTypeRefs.DeduplicatedImportedAttachment> {
		return this.entityClient.load(tutanotaTypeRefs.DeduplicatedImportedAttachmentTypeRef, deduplicatedImportedAttachmentId)
	}

	async getDeduplicatedImportedAttachmentsList(mailGroupId: Id): Promise<tutanotaTypeRefs.DeduplicatedImportedAttachment[]> {
		const mailBoxGroupRoot = await this.entityClient.load(tutanotaTypeRefs.MailboxGroupRootTypeRef, mailGroupId)
		const mailBox = await this.entityClient.load(tutanotaTypeRefs.MailBoxTypeRef, mailBoxGroupRoot.mailbox)
		return this.entityClient.loadAll(tutanotaTypeRefs.DeduplicatedImportedAttachmentTypeRef, assertNotNull(mailBox.deduplicatedImportedAttachments))
	}

	private async findTutaFolderForImapMailbox(imapMailbox: ImapMailbox, mailGroupId: Id, imapMailboxesToTutaFolders: Map<string, Id>): Promise<IdTuple> {
		const mailBoxGroupRoot = await this.entityClient.load(tutanotaTypeRefs.MailboxGroupRootTypeRef, mailGroupId)
		const mailBox = await this.entityClient.load(tutanotaTypeRefs.MailBoxTypeRef, mailBoxGroupRoot.mailbox)
		const mailSetElementId = assertNotNull(imapMailboxesToTutaFolders.get(imapMailbox.path), JSON.stringify(imapMailboxesToTutaFolders))
		return [mailBox.mailSets.mailSets, mailSetElementId]
	}
}
