import { LoggedInEvent, PostLoginAction } from "../../../common/api/main/LoginController"
import { filterMailMemberships } from "../../../common/api/common/utils/IndexUtils"
import { assertNotNull, Nullable } from "@tutao/utils"
import { isInternalUser } from "../../../common/api/common/utils/UserUtils"
import { EntityClient } from "../../../common/api/common/EntityClient"
import { elementIdPart, tutanotaTypeRefs } from "@tutao/typerefs"
import { CustomerFacade } from "../../../common/api/worker/facades/lazy/CustomerFacade"
import { InitializeImapImportParams } from "../../workerUtils/imapimport/ImapImporter"
import { SyncDonePriority, SyncTracker } from "../../../common/api/main/SyncTracker"
import { DEFAULT_IMAP_IMPORT_MAX_QUOTA } from "../../../common/api/common/utils/imapImportUtils/ImapImportUtils"
import { createManageLabelServiceLabelData } from "../../../typerefs/entities/tutanota/TypeRefs"
import { ImapImportController } from "../../native/main/ImapImportController"
import { ImapProvider } from "../../../common/api/common/utils/imapImportUtils/ImapKnownConfigs"
import { ImapErrorCause } from "../../../common/desktop/imapimport/adsync/imapmail/ImapError"
import { Dialog } from "../../../common/gui/base/Dialog"
import { TranslationKey } from "../../../common/misc/LanguageViewModel"

/**
 * continue an IMAP import after login if there is one.
 */
export class ImapImportPostLoginAction implements PostLoginAction {
	constructor(
		private readonly imapImportController: ImapImportController,
		private readonly customerFacade: CustomerFacade,
		private readonly entityClient: EntityClient,
		private readonly syncTracker: SyncTracker,
	) {}

	async onPartialLoginSuccess(_: LoggedInEvent): Promise<void> {
		// do nothing
	}

	async onFullLoginSuccess(_: LoggedInEvent): Promise<void> {
		await this.customerFacade.loadCustomizations()
		const user = assertNotNull(await this.customerFacade.getUser())
		if (isInternalUser(user)) {
			const ownerGroups = filterMailMemberships(user)
			for (const ownerGroup of ownerGroups) {
				const mailboxGroupRoot = await this.entityClient.load(tutanotaTypeRefs.MailboxGroupRootTypeRef, ownerGroup.group)
				const mailbox = await this.entityClient.load(tutanotaTypeRefs.MailBoxTypeRef, mailboxGroupRoot.mailbox)
				if (mailbox.imapAccountSyncStates) {
					const imapAccountSyncStatesForMailbox = await this.entityClient.loadAll(
						tutanotaTypeRefs.ImportImapAccountSyncStateTypeRef,
						mailbox.imapAccountSyncStates,
					)
					for (const imapAccountSyncState of imapAccountSyncStatesForMailbox) {
						this.syncTracker.addSyncDoneListener({
							onSyncDone: async () => {
								let rootImportMailFolderName: string = ""
								if (imapAccountSyncState.rootImportMailFolder !== null) {
									const rootMailFolder = await this.entityClient.load(
										tutanotaTypeRefs.MailSetTypeRef,
										imapAccountSyncState.rootImportMailFolder,
									)
									rootImportMailFolderName = rootMailFolder.name
								}
								let imapSyncLabelData: Nullable<tutanotaTypeRefs.ManageLabelServiceLabelData> = null
								if (imapAccountSyncState.imapSyncLabel) {
									const imapSyncLabel = await this.entityClient.load(tutanotaTypeRefs.MailSetTypeRef, imapAccountSyncState.imapSyncLabel)
									imapSyncLabelData = createManageLabelServiceLabelData({
										color: assertNotNull(imapSyncLabel.color),
										name: imapSyncLabel.name,
									})
								}

								const matchImportFoldersToTutanotaFolders = imapAccountSyncState.rootImportMailFolder === null
								let imapMailboxesToTutaFolders
								if (matchImportFoldersToTutanotaFolders) {
									const imapFolderSyncStates = await this.entityClient.loadAll(
										tutanotaTypeRefs.ImportImapFolderSyncStateTypeRef,
										imapAccountSyncState.imapFolderSyncStateList,
									)
									imapMailboxesToTutaFolders = new Map(
										imapFolderSyncStates.map((folderSyncState) => {
											return [folderSyncState.path, elementIdPart(folderSyncState.mailFolder)]
										}),
									)
								}
								const initializeImapImportParams: InitializeImapImportParams = matchImportFoldersToTutanotaFolders
									? {
											importImapAccount: imapAccountSyncState.imapAccount,
											maxQuota: DEFAULT_IMAP_IMPORT_MAX_QUOTA,
											provider: parseInt(imapAccountSyncState.provider) as ImapProvider,

											matchImportFoldersToTutanotaFolders: true,
											imapMailboxesToTutaFolders: assertNotNull(imapMailboxesToTutaFolders),
											isModifyingExistingImport: false,
											mailGroupId: ownerGroup.group,
											imapSyncLabelData: imapSyncLabelData,
										}
									: {
											importImapAccount: imapAccountSyncState.imapAccount,
											maxQuota: DEFAULT_IMAP_IMPORT_MAX_QUOTA,
											provider: parseInt(imapAccountSyncState.provider) as ImapProvider,

											matchImportFoldersToTutanotaFolders: false,
											rootImportMailFolderName: rootImportMailFolderName,
											isModifyingExistingImport: false,
											mailGroupId: ownerGroup.group,
											imapSyncLabelData: imapSyncLabelData,
										}
								try {
									const activeImport = await this.imapImportController.initializeImport(initializeImapImportParams)
									if (activeImport.remoteStateId) {
										const importResult = await this.imapImportController.continueImport(activeImport.remoteStateId)
										if (importResult.error?.cause === ImapErrorCause.AUTH_FAILED_REFRESH_TOKEN) {
											Dialog.message("imapImportAuthFailed_msg" as TranslationKey).then(() => false)
										}
									}
								} catch (e) {
									console.log(
										`failed to continue imap import for group: ${ownerGroup.group}, imapAccountSyncState: ${imapAccountSyncState._id}`,
										e,
									)
								}
							},
							priority: SyncDonePriority.LOW,
						})
					}
				}
			}
		}
	}
}
