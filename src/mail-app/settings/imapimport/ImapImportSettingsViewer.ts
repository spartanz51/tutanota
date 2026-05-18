import m, { Children } from "mithril"
import { ImapImportData, showAddImapImportWizard } from "./AddImapImportWizard.js"
import { assertMainOrNode } from "@tutao/app-env"
import { UpdatableSettingsViewer } from "../../../common/settings/Interfaces"
import { entityUpdateUtils, tutanotaTypeRefs } from "@tutao/typerefs"
import { lang } from "../../../common/misc/LanguageViewModel"
import { IconButton } from "../../../common/gui/base/IconButton"
import { Icons } from "../../../common/gui/base/icons/Icons"
import { ButtonSize } from "../../../common/gui/base/ButtonSize"
import { theme } from "../../../common/gui/theme"
import { ImapImportState, ImportState } from "../../../common/api/common/utils/imapImportUtils/ImapImportUtils"
import { ImapImportController } from "../../native/main/ImapImportController"
import { BannerType, InfoBanner } from "../../../common/gui/base/InfoBanner"
import { TitleSection } from "../../../common/gui/base/TitleSection"
import { PrimaryButton } from "../../../common/gui/base/buttons/VariantButtons"
import { mailLocator } from "../../mailLocator"
import { FolderSystem } from "../../../common/api/common/mail/FolderSystem"
import { Icon, IconSize } from "../../../common/gui/base/Icon"
import { getMailboxName } from "../../../common/mailFunctionality/SharedMailUtils"
import { assertNotNull } from "@tutao/utils"
import { MenuTitle } from "../../../common/gui/titles/MenuTitle"
import { ImapErrorCause } from "../../../common/desktop/imapimport/adsync/imapmail/ImapError"
import { ImapProvider } from "../../../common/api/common/utils/imapImportUtils/ImapKnownConfigs"

assertMainOrNode()

class ImapImportSettingsViewer implements UpdatableSettingsViewer {
	private imapImportStates: Map<string, ImapImportState> = new Map()
	private imapImportController: ImapImportController | null = null

	constructor() {}

	async oninit() {
		await this.updateUiState()
		this.imapImportController = await mailLocator.imapImportController()
		this.imapImportStates = await this.imapImportController.initImapAccountSyncStates()
		m.redraw()
	}

	view(): Children {
		const hasActiveSync = this.imapImportStates.size > 0
		return this.imapImportController !== null
			? [
					m(
						".fill-absolute.scroll.plr-24.pb-48",
						{
							style: {
								backgroundColor: theme.surface_container,
								gap: "16px",
								display: "flex",
								flexDirection: "column",
							},
						},
						[
							this.renderTitleSection(),
							hasActiveSync ? this.renderActiveSyncTitle() : this.renderInfo(),
							this.renderSyncProgress(this.imapImportController),
							this.renderButton(this.getImapImportData()),
						],
					),
				]
			: []
	}

	private getImapImportData() {
		// FIXME:Delete these default credentials
		const imapImportData: ImapImportData = {
			imapAccountHost: "localhost",
			imapAccountPort: parseInt("143"),
			imapAccountUsername: "user@test.com",
			imapAccountPassword: "password",
			rootImportMailFolderName: "root",
			imapImportState: new ImapImportState(ImportState.NOT_INITIALIZED),
			matchImportFoldersToTutanotaFolders: false,
			isModifyingExistingImport: false,
			isImapServerSupportingOAuth: false,
			revealImapAccountPassword: false,
			addLabelToImportedMails: false,
			imapSyncLabelData: null,
			imapMailboxes: [],
			folderSystem: new FolderSystem([]),
			imapProvider: ImapProvider.Other,
		}

		return imapImportData
	}

	private renderTitleSection(): Children {
		return m("", [
			m(TitleSection, {
				icon: Icons.DownloadOutline,
				title: lang.get("imapSync_title"),
				subTitle: lang.get("imapSyncInfo_msg"),
			}),
		])
	}

	private renderInfo(): Children {
		return m(InfoBanner, {
			message: "imapNoSyncActive_msg",
			icon: Icons.InfoFilled,
			type: BannerType.SettingsInfo,
			buttons: [],
		})
	}

	private renderActiveSyncTitle(): Children {
		return m(MenuTitle, { content: lang.getTranslationText("imapImportActiveSync_label") })
	}

	private renderSyncProgress(imapImportController: ImapImportController) {
		return Array.from(imapImportController.getActiveImports().entries()).map(([accountSyncStateIdString, activeImport]) => {
			const accountSyncStateId = assertNotNull(activeImport.remoteStateId)
			if (!imapImportController.shouldRenderCancelButton(accountSyncStateId)) {
				return null
			}

			const buttons: any[] = []
			if (imapImportController.shouldRenderPauseButton(accountSyncStateId)) {
				buttons.push(
					m(IconButton, {
						title: "pauseImapImport_action",
						icon: Icons.PauseOutline,
						size: ButtonSize.Normal,
						click: () => {
							imapImportController.pauseImport(accountSyncStateId).then(() => this.updateUiState())
						},
					}),
				)
			}
			if (imapImportController.shouldRenderResumeButton(accountSyncStateId)) {
				buttons.push(
					m(IconButton, {
						title: "resumeMailImport_action",
						icon: Icons.PlayOutline,
						size: ButtonSize.Normal,
						click: () => {
							imapImportController.continueImport(accountSyncStateId).then((result) => {
								if (result.error?.cause === ImapErrorCause.AUTH_FAILED_REFRESH_TOKEN) {
								}
								this.updateUiState()
							})
						},
					}),
				)
			}
			if (imapImportController.shouldRenderCancelButton(accountSyncStateId)) {
				buttons.push(
					m(IconButton, {
						title: "cancel_action",
						icon: Icons.X,
						size: ButtonSize.Normal,
						click: () => {
							imapImportController.deleteImport(accountSyncStateId).then(() => this.updateUiState())
						},
					}),
				)
			}

			let syncMessage = lang.getTranslation("imapSyncInProgressInfo_msg")
			const imapImportState = this.imapImportStates.get(accountSyncStateIdString)
			if (imapImportState && imapImportState.state === ImportState.POSTPONED) {
				syncMessage = lang.getTranslation("imapSyncPostponed_msg", { "{postponedUntil}": imapImportState.postponedUntil.toLocaleTimeString() })
			}
			const mailboxDetail = assertNotNull(this.imapImportController?.getActiveImportMailboxDetail(accountSyncStateId))
			const destinationTutaMailbox = getMailboxName(mailLocator.logins, mailboxDetail)
			const syncSourceAndDestinationMessage = lang.getTranslation("imapSyncInProgressAccounts_msg", {
				"{sourceAddress}": activeImport.remoteMailAddress,
				"{tutaMailbox}": destinationTutaMailbox,
			})
			return m(".nav-bg.border-radius.flex.items-center.justify-between.p-16.surface-background", [
				m(".flex.items-center.gap-16", [
					m(Icon, {
						icon: Icons.Sync,
						size: IconSize.PX24,
						style: {
							fill: theme.on_surface,
						},
					}),
					m(".pl-4.pr-32.flex.items-base.flex-column", [m("", syncSourceAndDestinationMessage.text), m(".small", syncMessage.text)]),
				]),
				m(".flex.items-center.gap-16", [...buttons]),
			])
		})
	}

	private renderButton(imapImportData: ImapImportData): Children {
		return m(
			".flex-end.mt-8",
			m(PrimaryButton, {
				width: "flex",
				label: "imapSyncStart_action",
				onclick: () => showAddImapImportWizard(imapImportData).then(() => m.redraw()),
			}),
		)
	}

	private async updateUiState() {
		this.imapImportStates = await (await mailLocator.imapImportController()).loadImapImportStates()
		await (await mailLocator.imapImportController()).updateFolderSyncProgressForActiveImports()
		m.redraw()
	}

	async entityEventsReceived(updates: ReadonlyArray<entityUpdateUtils.EntityUpdateData>): Promise<void> {
		for (const update of updates) {
			if (
				entityUpdateUtils.isUpdateForTypeRef(tutanotaTypeRefs.ImportImapAccountSyncStateTypeRef, update) ||
				entityUpdateUtils.isUpdateForTypeRef(tutanotaTypeRefs.ImportImapFolderSyncStateTypeRef, update)
			) {
				await this.updateUiState()
				m.redraw()
			}
		}
	}
}

export default ImapImportSettingsViewer
