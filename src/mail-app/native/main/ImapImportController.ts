import { assertMainOrNode, ImportImapFolderSyncStatus } from "@tutao/app-env"
import { MailModel } from "../../mail/model/MailModel"
import { MailboxDetail, MailboxModel } from "../../../common/mailFunctionality/MailboxModel"
import { ImapImporter, ImportResult, InitializeImapImportParams } from "../../workerUtils/imapimport/ImapImporter"
import { assertNotNull, first, promiseMap } from "@tutao/utils"
import { getElementId, tutanotaTypeRefs } from "@tutao/typerefs"
import { EntityClient } from "../../../common/api/common/EntityClient"
import {
	ImapImportState,
	ImportState,
	tokenEndpointResponseToTutadbTokenEndpointResponse,
} from "../../../common/api/common/utils/imapImportUtils/ImapImportUtils"
import { OauthFacade } from "../../../common/native/common/generatedipc/OauthFacade"
import { ImapAccount } from "../../../common/desktop/imapimport/adsync/ImapSyncState"
import { ImapMailbox } from "../../../common/api/common/utils/imapImportUtils/ImapMailbox"
import { ImapError, ImapErrorCause } from "../../../common/desktop/imapimport/adsync/imapmail/ImapError"
import { getConfigForProvider, ImapProvider } from "../../../common/api/common/utils/imapImportUtils/ImapKnownConfigs"
import { OauthHandler } from "../../../common/api/common/utils/imapImportUtils/OauthHandler"

assertMainOrNode()

export type ActiveImport = {
	mailGroupId: Id
	remoteStateId?: IdTuple
	remoteMailAddress: string
	imapImportState: ImapImportState
	syncProgress: { completed: number; total: number } | null
}

export class ImapImportController {
	public mailboxDetails: MailboxDetail[] = []
	public selectedMailBoxDetail: MailboxDetail | null = null
	private activeImports: Map<string, ActiveImport> = new Map()
	constructor(
		private readonly imapImporter: ImapImporter,
		private readonly mailModel: MailModel,
		private readonly mailboxModel: MailboxModel,
		private readonly entityClient: EntityClient,
		private readonly oauthFacade: OauthFacade,
	) {}

	async initializeImport(initializeImportParams: InitializeImapImportParams) {
		const { result } = await this.imapImporter.initializeImport(initializeImportParams)
		const remoteId = assertNotNull(result.remoteStateId)

		const newImport: ActiveImport = {
			mailGroupId: initializeImportParams.mailGroupId,
			imapImportState: result.state,
			remoteMailAddress: initializeImportParams.importImapAccount.userName,
			remoteStateId: remoteId,
			syncProgress: null,
		}

		this.activeImports.set(this.getMapKey(remoteId), newImport)
		return newImport
	}

	async continueImport(imapAccountSyncStateId: IdTuple, retryCount: number = 0): Promise<ImportResult> {
		if (retryCount > 1) {
			return { result: { state: new ImapImportState(ImportState.NOT_INITIALIZED) }, error: new ImapError({}, ImapErrorCause.AUTH_FAILED_REFRESH_TOKEN) }
		}
		const importResult = await this.imapImporter.continueImport(imapAccountSyncStateId)
		const activeImport = this.activeImports.get(this.getMapKey(imapAccountSyncStateId))
		if (activeImport) {
			activeImport.imapImportState = importResult.result.state
		}
		if (importResult.error && importResult.error.cause === ImapErrorCause.AUTH_FAILED) {
			const imapAccountSyncState = await this.entityClient.load(tutanotaTypeRefs.ImportImapAccountSyncStateTypeRef, imapAccountSyncStateId)
			const provider = parseInt(imapAccountSyncState.provider) as ImapProvider
			const config = getConfigForProvider(provider)?.oauthConfig
			if (config && imapAccountSyncState.imapAccount.tokenEndpointResponse?.refreshToken) {
				const oauthHandler = new OauthHandler(config)
				await oauthHandler.setupOauthLoginParams()
				const tokenEndpointResponse = await oauthHandler.refreshTokens(imapAccountSyncState.imapAccount.tokenEndpointResponse?.refreshToken)
				imapAccountSyncState.imapAccount.tokenEndpointResponse = tokenEndpointResponseToTutadbTokenEndpointResponse(tokenEndpointResponse)
				await this.entityClient.update(imapAccountSyncState)
				return await this.continueImport(imapAccountSyncStateId, 1)
			}
		}
		return importResult
	}

	async pauseImport(accountSyncStateId: IdTuple) {
		if (this.activeImports.has(this.getMapKey(accountSyncStateId))) {
			const activeImport = assertNotNull(this.activeImports.get(this.getMapKey(accountSyncStateId)))
			activeImport.imapImportState = await this.imapImporter.pauseImport(accountSyncStateId)
			return activeImport
		} else {
			await this.initImapAccountSyncStates()
			return assertNotNull(this.activeImports.get(this.getMapKey(accountSyncStateId)))
		}
	}

	async pauseImports() {
		await promiseMap(Array.from(this.activeImports.values()), async (session) => {
			if (session.remoteStateId) {
				session.imapImportState = await this.imapImporter.pauseImport(session.remoteStateId)
			}
		})
	}

	async deleteImport(accountSyncStateId: IdTuple) {
		const isRemoved = await this.imapImporter.deleteImport(accountSyncStateId)
		if (isRemoved) {
			this.activeImports.delete(this.getMapKey(accountSyncStateId))
		}
		return isRemoved
	}

	async openOauthAuthenticationWindow(url: string, redirectUrl: string) {
		return await this.oauthFacade.openOauthWindow(url, redirectUrl)
	}

	async loadImapImportStates(): Promise<Map<string, ActiveImport>> {
		return this.activeImports
	}

	async updateFolderSyncProgressForActiveImports() {
		await promiseMap(Array.from(this.activeImports.values()), async (session) => {
			const id = session.remoteStateId
			if (id) {
				session.imapImportState = await this.imapImporter.loadImapImportState(id)
				session.syncProgress = await this.calculateSyncProgressForAccountSyncState(id)
			}
		})
	}

	async calculateSyncProgressForAccountSyncState(imapAccountSyncStateId: IdTuple) {
		const imapAccountSyncState = await this.entityClient.load(tutanotaTypeRefs.ImportImapAccountSyncStateTypeRef, imapAccountSyncStateId)
		const imapFolderSyncStates = await this.entityClient.loadAll(
			tutanotaTypeRefs.ImportImapFolderSyncStateTypeRef,
			imapAccountSyncState.imapFolderSyncStateList,
		)
		const completedImapFolderSyncStates = imapFolderSyncStates.filter((syncState) => syncState.status === ImportImapFolderSyncStatus.Finished)
		return { completed: completedImapFolderSyncStates.length, total: imapFolderSyncStates.length }
	}

	shouldRenderPauseButton(accountSyncStateId: IdTuple) {
		const activeImport = this.activeImports.get(this.getMapKey(accountSyncStateId))
		return activeImport && (activeImport.imapImportState.state === ImportState.RUNNING || activeImport.imapImportState.state === ImportState.POSTPONED)
	}

	shouldRenderResyncButton(accountSyncStateId: IdTuple) {
		const activeImport = this.activeImports.get(this.getMapKey(accountSyncStateId))
		return activeImport && (activeImport.imapImportState.state === ImportState.PAUSED || activeImport.imapImportState.state === ImportState.FINISHED)
	}

	shouldRenderPauseIcon(accountSyncStateId: IdTuple) {
		const activeImport = this.activeImports.get(this.getMapKey(accountSyncStateId))
		return activeImport && activeImport.imapImportState.state === ImportState.PAUSED
	}

	shouldRenderClockIcon(accountSyncStateId: IdTuple) {
		const activeImport = this.activeImports.get(this.getMapKey(accountSyncStateId))
		return activeImport && activeImport.imapImportState.state === ImportState.POSTPONED
	}

	getActiveImports() {
		return this.activeImports
	}

	getActiveImportMailboxDetail(accountSyncStateId: IdTuple) {
		const activeImport = this.activeImports.get(this.getMapKey(accountSyncStateId))
		if (activeImport) {
			return this.mailboxDetails.find((mailboxDetail) => mailboxDetail.mailGroupInfo.group === activeImport.mailGroupId)
		}
	}

	async getImapMailboxesFromServer(imapAccount: ImapAccount) {
		return await this.imapImporter.getImapMailboxesFromServer(imapAccount)
	}

	async getFolderSystemForSelectedMailbox() {
		const selectedMailBoxDetail = assertNotNull(this.selectedMailBoxDetail)
		await this.mailModel.init()
		return assertNotNull(this.mailModel.getFolderSystemByGroupId(assertNotNull(selectedMailBoxDetail.mailbox._ownerGroup)))
	}

	async constructImapMailboxesToTutaFoldersMap(imapMailboxes: ReadonlyArray<ImapMailbox>): Promise<Map<string, Id>> {
		const imapMailboxesToTutaFolders = new Map<string, Id>()
		const folderSystem = await this.getFolderSystemForSelectedMailbox()
		for (const imapMailbox of imapMailboxes) {
			if (imapMailbox.specialUse) {
				const systemFolderType = ImapMailbox.getSpecialUseAsSystemFolderType(imapMailbox)
				if (systemFolderType !== null) {
					const systemFolder = assertNotNull(folderSystem.getSystemFolderByType(systemFolderType))
					imapMailboxesToTutaFolders.set(imapMailbox.path, getElementId(systemFolder))
				}
			}
			const customFolders = folderSystem.getCustomFoldersOfParent(null)
			const matchingFolder = customFolders.find((customFolder) => imapMailbox.name && customFolder.name === imapMailbox.name)
			if (imapMailbox.name && matchingFolder) {
				imapMailboxesToTutaFolders.set(imapMailbox.name, getElementId(matchingFolder))
			}
		}
		return imapMailboxesToTutaFolders
	}

	async initImapAccountSyncStates(): Promise<Map<string, ActiveImport>> {
		this.mailboxDetails = await this.mailboxModel.getMailboxDetails()
		this.selectedMailBoxDetail = first(this.mailboxDetails)
		for (const mailboxDetail of this.mailboxDetails) {
			const mailbox = mailboxDetail.mailbox

			if (mailbox.imapAccountSyncStates) {
				const importImapAccountSyncStates = await this.entityClient.loadAll(
					tutanotaTypeRefs.ImportImapAccountSyncStateTypeRef,
					mailbox.imapAccountSyncStates,
				)
				for (const imapAccountSyncState of importImapAccountSyncStates) {
					this.activeImports.set(this.getMapKey(imapAccountSyncState._id), {
						remoteStateId: imapAccountSyncState._id,
						imapImportState: await this.imapImporter.loadImapImportState(imapAccountSyncState._id),
						remoteMailAddress: imapAccountSyncState.imapAccount.userName,
						mailGroupId: assertNotNull(mailbox._ownerGroup),
						syncProgress: await this.calculateSyncProgressForAccountSyncState(imapAccountSyncState._id),
					})
				}
			}
		}

		return this.activeImports
	}

	private getMapKey(id: IdTuple): string {
		return id.join("/")
	}

	onNewMailboxSelected(newMailboxDetail: MailboxDetail) {
		this.selectedMailBoxDetail = newMailboxDetail
	}
}
