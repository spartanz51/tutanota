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
import { ActiveImport, ImapImportController } from "../../native/main/ImapImportController"
import { BannerType, InfoBanner } from "../../../common/gui/base/InfoBanner"
import { TitleSection } from "../../../common/gui/base/TitleSection"
import { PrimaryButton } from "../../../common/gui/base/buttons/VariantButtons"
import { mailLocator } from "../../mailLocator"
import { FolderSystem } from "../../../common/api/common/mail/FolderSystem"
import { Icon, IconAttrs, IconSize } from "../../../common/gui/base/Icon"
import { getMailboxName } from "../../../common/mailFunctionality/SharedMailUtils"
import { assertNotNull } from "@tutao/utils"
import { MenuTitle } from "../../../common/gui/titles/MenuTitle"
import { ImapErrorCause } from "../../../common/desktop/imapimport/adsync/imapmail/ImapError"
import { ImapProvider } from "../../../common/api/common/utils/imapImportUtils/ImapKnownConfigs"
import { Card } from "../../../common/gui/base/Card"
import { Dialog } from "../../../common/gui/base/Dialog"
import { showProgressDialog } from "../../../common/gui/dialogs/ProgressDialog"

assertMainOrNode()

class ImapImportSettingsViewer implements UpdatableSettingsViewer {
	private imapImportStates: Map<string, ActiveImport> = new Map()
	private imapImportController: ImapImportController | null = null
	private disableButtons: boolean = false
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
			const accountSyncStateId = activeImport.remoteStateId
			if (accountSyncStateId === undefined) {
				return null
			}

			const buttons: Children[] = []
			if (imapImportController.shouldRenderPauseButton(accountSyncStateId)) {
				if (activeImport.syncProgress?.completed === activeImport.syncProgress?.total || activeImport.imapImportState.state === ImportState.POSTPONED) {
					buttons.push(
						m(IconButton, {
							title: "resumeMailImport_action",
							icon: Icons.Refresh,
							size: ButtonSize.Normal,
							disabled: this.disableButtons,
							click: () => {
								this.disableButtons = true
								imapImportController.continueImport(accountSyncStateId).then(async () => {
									await this.updateUiState()
									this.disableButtons = false
								})
							},
						}),
					)
				} else {
					buttons.push(
						m(IconButton, {
							title: "pauseImapImport_action",
							icon: Icons.PauseOutline,
							size: ButtonSize.Normal,
							disabled: this.disableButtons,
							click: () => {
								this.disableButtons = true
								imapImportController.pauseImport(accountSyncStateId).then(async () => {
									await this.updateUiState()
									this.disableButtons = false
								})
							},
						}),
					)
				}
			}
			if (imapImportController.shouldRenderResyncButton(accountSyncStateId)) {
				buttons.push(
					m(IconButton, {
						title: "resumeMailImport_action",
						icon: imapImportController.shouldRenderPauseIcon(accountSyncStateId) ? Icons.PlayOutline : Icons.Refresh,
						size: ButtonSize.Normal,
						disabled: this.disableButtons,
						click: () => {
							this.disableButtons = true
							imapImportController.continueImport(accountSyncStateId).then(async (result) => {
								if (result.error?.cause === ImapErrorCause.AUTH_FAILED_REFRESH_TOKEN) {
								}
								await this.updateUiState()
								this.disableButtons = false
							})
						},
					}),
				)
			}
			buttons.push(
				m(IconButton, {
					title: "cancel_action",
					icon: Icons.X,
					size: ButtonSize.Normal,
					disabled: this.disableButtons,
					click: () => {
						this.disableButtons = true
						return Dialog.confirm("imapImportCancelConfirm_msg").then((confirmed) => {
							if (confirmed) {
								showProgressDialog(
									"pleaseWait_msg",
									imapImportController.deleteImport(accountSyncStateId).then(async () => {
										await this.updateUiState()
									}),
								)
							}
							this.disableButtons = false
						})
					},
				}),
			)

			let syncMessage = lang.getTranslation("imapSyncInProgressInfo_msg", {
				"{completed}": activeImport.syncProgress?.completed.toString() ?? "-",
				"{total}": activeImport.syncProgress?.total.toString() ?? "-",
			})
			if (activeImport.imapImportState.state === ImportState.POSTPONED) {
				syncMessage = lang.getTranslation("imapSyncPostponed_msg", {
					"{postponedUntil}": activeImport.imapImportState.postponedUntil.toLocaleTimeString(),
				})
			}
			const mailboxDetail = assertNotNull(this.imapImportController?.getActiveImportMailboxDetail(accountSyncStateId))
			const destinationTutaMailbox = getMailboxName(mailLocator.logins, mailboxDetail)
			const syncSourceAndDestinationMessage = lang.getTranslation("imapSyncInProgressAccounts_msg", {
				"{sourceAddress}": activeImport.remoteMailAddress,
				"{tutaMailbox}": destinationTutaMailbox,
			})

			const statusIcon = imapImportController.shouldRenderPauseIcon(accountSyncStateId)
				? Icons.PauseOutline
				: imapImportController.shouldRenderClockIcon(accountSyncStateId)
					? Icons.ClockOutlines
					: activeImport.syncProgress?.completed === activeImport.syncProgress?.total
						? Icons.Checkmark
						: Icons.Sync
			const statusIconParameters: Partial<IconAttrs> = {
				icon: statusIcon,
				class: statusIcon === Icons.Sync ? "icon-progress" : "",
				style: {
					fill: statusIcon === Icons.Checkmark ? theme.success : statusIcon === Icons.PauseOutline ? theme.warning : theme.on_surface,
				},
			}
			return m(
				Card,
				m(".flex.items-center.justify-between", [
					m(".flex.items-center.gap-16", [
						m(Icon, {
							...statusIconParameters,
							size: IconSize.PX32,
						} as IconAttrs),
						m(".pl-4.pr-32.items-base.flex-column", [
							m(".text-preline.text-ellipsis", syncSourceAndDestinationMessage.text),
							m(".small", syncMessage.text),
						]),
					]),
					m(".flex-column.items-center", buttons),
				]),
			)
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
