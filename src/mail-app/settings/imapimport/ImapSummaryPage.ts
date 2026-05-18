import m, { Children, Vnode, VnodeDOM } from "mithril"
import { assertMainOrNode, MailSetKind } from "@tutao/app-env"
import { getElementId, tutanotaTypeRefs } from "@tutao/typerefs"
import { assertNotNull, noOp } from "@tutao/utils"
import { ImportResult, InitializeImapImportParams } from "../../workerUtils/imapimport/ImapImporter.js"
import { emitWizardEvent, WizardEventType, WizardPageAttrs, WizardPageN } from "../../../common/gui/base/WizardDialog"
import { TextField } from "../../../common/gui/base/TextField"
import { lang, TranslationKey } from "../../../common/misc/LanguageViewModel"
import { Dialog } from "../../../common/gui/base/Dialog"
import { showProgressDialog } from "../../../common/gui/dialogs/ProgressDialog"
import {
	DEFAULT_IMAP_IMPORT_MAX_QUOTA,
	ImportState,
	tokenEndpointResponseToTutadbTokenEndpointResponse,
} from "../../../common/api/common/utils/imapImportUtils/ImapImportUtils"
import { ImapImportData } from "./AddImapImportWizard"
import { ImapImportController } from "../../native/main/ImapImportController"
import { ImapErrorCause } from "../../../common/desktop/imapimport/adsync/imapmail/ImapError"
import { Icons } from "../../../common/gui/base/icons/Icons"
import { theme } from "../../../common/gui/theme"
import { mailLocator } from "../../mailLocator"
import { ImapMailbox } from "../../../common/api/common/utils/imapImportUtils/ImapMailbox"
import { getFolderIconByType } from "../../mail/view/MailGuiUtils"
import { Icon, IconSize } from "../../../common/gui/base/Icon"
import { IconButton } from "../../../common/gui/base/IconButton"
import { DropDownSelectorNew, DropDownSelectorNewAttrs } from "../../../common/gui/base/DropDownSelectorNew"
import { getFolderName } from "../../mail/model/MailUtils"
import { showEditFolderDialog } from "../../mail/view/EditFolderDialog"
import { MenuTitle } from "../../../common/gui/titles/MenuTitle"
import { Card } from "../../../common/gui/base/Card"
import { getMailboxName } from "../../../common/mailFunctionality/SharedMailUtils"
import { ColorOptionButton } from "../../../common/gui/base/colorPicker/ColorOptionButton"
import { PrimaryButton } from "../../../common/gui/base/buttons/VariantButtons"
import { showImapEditLabelDialog } from "../../mail/view/EditLabelDialog"
import { isValidCSSHexColor } from "../../../common/gui/base/Color"

assertMainOrNode()

export class ImapSummaryPage implements WizardPageN<ImapImportData> {
	private dom: HTMLElement | null = null
	private controller: ImapImportController | null = null
	private enableParentFolderEdit: boolean = false
	private enableFolderMappingEdit: boolean = false

	oncreate(vnode: VnodeDOM<WizardPageAttrs<ImapImportData>>) {
		this.dom = vnode.dom as HTMLElement
	}

	async oninit() {
		this.controller = await mailLocator.imapImportController()
		m.redraw()
	}

	view(vnode: Vnode<WizardPageAttrs<ImapImportData>>): Children {
		const data = vnode.attrs.data

		return m(".mt-24", { style: { maxHeight: "65vh" } }, [
			this.renderExportInformation(data),
			this.renderImportInformation(data),
			data.matchImportFoldersToTutanotaFolders ? this.renderFolderMapping(data) : null,
			this.renderContinueButton(data),
		])
	}

	private renderContinueButton(data: ImapImportData) {
		const isLabelCorrectlySet =
			!data.addLabelToImportedMails ||
			(data.imapSyncLabelData !== null && data.imapSyncLabelData.name !== "" && isValidCSSHexColor(data.imapSyncLabelData.color))
		const isParentFolderCorrectlySet = data.rootImportMailFolderName !== "" || data.matchImportFoldersToTutanotaFolders
		const shouldAllowContinuing = isLabelCorrectlySet && isParentFolderCorrectlySet

		return m(
			".flex-end.full-width.pt-32.mb-32",
			m(
				"",
				{
					style: {
						width: "260px",
					},
				},
				m(PrimaryButton, {
					label: "startImapImport_action",
					class: "wizard-next-button",
					onclick: (_, dom) => {
						emitWizardEvent(dom, WizardEventType.SHOW_NEXT_PAGE)
					},
					disabled: !shouldAllowContinuing,
				}),
			),
		)
	}

	private renderFolderMapping(data: ImapImportData) {
		const imapMailboxToTutaFolderRows = data.imapMailboxes.map((imapMailbox) => {
			const tutaMailSetElementId = assertNotNull(data.imapMailboxesToTutaFolders?.get(imapMailbox.path))
			const tutaMailSet = assertNotNull(data.folderSystem.getFolderById(tutaMailSetElementId))
			return { imapMailbox, tutaMailSet }
		})

		return m(Card, { classes: this.enableFolderMappingEdit ? ["mt-16", "alternate-background"] : ["mt-16", "surface-background"] }, [
			m(".flex.justify-between.items-center", [
				m(MenuTitle, { content: lang.getTranslationText("imapSyncFolderMapping_title") }),
				this.enableFolderMappingEdit
					? m(
							"",
							{
								style: {
									minWidth: "100px",
								},
							},
							m(PrimaryButton, {
								label: "imapSyncFolderMappingEditConfirmButton_label",
								onclick: () => {
									this.enableFolderMappingEdit = false
								},
							}),
						)
					: m(IconButton, {
							title: "imapSyncFolderMapping_title",
							icon: Icons.PenFilled,
							click: () => {
								this.enableFolderMappingEdit = !this.enableFolderMappingEdit
							},
						}),
			]),
			this.enableFolderMappingEdit
				? this.renderFolderMappingEditMode(imapMailboxToTutaFolderRows, data)
				: this.renderFolderMappingReadonlyMode(imapMailboxToTutaFolderRows),
		])
	}

	private renderFolderMappingEditMode(
		imapMailboxToTutaFolderRows: {
			imapMailbox: ImapMailbox
			tutaMailSet: tutanotaTypeRefs.MailSet | null
		}[],
		data: ImapImportData,
	) {
		return m(
			"",
			imapMailboxToTutaFolderRows.map((mailboxToRow) => {
				return m(".flex.gap-8.items-center.mt-8", [
					m(TextField, {
						class: "",
						value: mailboxToRow.imapMailbox.name ?? "",
						disabled: true,
					}),
					m(Icon, {
						icon: Icons.SimpleArrowRight,
						size: IconSize.PX24,
						class: "pr-4 flex items-center",
						style: {
							fill: theme.on_surface,
						},
					}),
					m(DropDownSelectorNew, {
						selectedValue: mailboxToRow.tutaMailSet,
						selectedValueDisplay: mailboxToRow.tutaMailSet
							? getFolderName(mailboxToRow.tutaMailSet)
							: lang.getTranslationText("imapChooseFolder_msg"),
						items: data.folderSystem.getIndentedList(null).map((indentedFolder) => ({
							name: getFolderName(indentedFolder.folder),
							value: indentedFolder.folder,
						})),
						icon: {
							icon: !mailboxToRow.tutaMailSet ? Icons.FolderFilled : getFolderIconByType(mailboxToRow.tutaMailSet.folderType as MailSetKind),
							color: theme.on_surface_variant,
						},
						selectionChangedHandler: (selectedMailSet) => {
							data.imapMailboxesToTutaFolders?.set(mailboxToRow.imapMailbox.path, getElementId(selectedMailSet))
						},
					} satisfies DropDownSelectorNewAttrs<tutanotaTypeRefs.MailSet>),
					m(IconButton, {
						icon: Icons.Plus,
						title: "selectMultiple_action",
						click: async () => {
							if (this.controller) {
								await showEditFolderDialog(assertNotNull(this.controller.selectedMailBoxDetail), null, null, mailboxToRow.imapMailbox.name)
									.then(() => (data.folderSystem = assertNotNull(this.controller).getFolderSystemForSelectedMailbox()))
									.then(() => {
										const newlyAddedFolder = data.folderSystem.getFolderByName(assertNotNull(mailboxToRow.imapMailbox.name))
										if (newlyAddedFolder) {
											data.imapMailboxesToTutaFolders?.set(mailboxToRow.imapMailbox.path, getElementId(newlyAddedFolder))
										}
									})
									.then(() => m.redraw())
							}
						},
					}),
				])
			}),
		)
	}

	private renderFolderMappingReadonlyMode(
		imapMailboxToTutaFolderRows: {
			imapMailbox: ImapMailbox
			tutaMailSet: tutanotaTypeRefs.MailSet
		}[],
	) {
		return m(
			"",
			imapMailboxToTutaFolderRows.map((mailboxToRow) => {
				return m(".flex.gap-8.items-center.mt-8", [
					m(TextField, {
						value: mailboxToRow.imapMailbox.name ?? "",
						isReadOnly: true,
						class: "surface-background",
					}),
					m(Icon, {
						icon: Icons.SimpleArrowRight,
						size: IconSize.PX24,
						class: "pr-4 flex items-center",
						style: {
							fill: theme.on_surface,
						},
					}),
					m(TextField, {
						value: getFolderName(mailboxToRow.tutaMailSet),
						isReadOnly: true,
						class: "surface-background",
						leadingIcon: {
							icon: getFolderIconByType(mailboxToRow.tutaMailSet.folderType as MailSetKind),
							color: theme.on_surface_variant,
						},
					}),
				])
			}),
		)
	}

	private renderExportInformation(data: ImapImportData) {
		return m(Card, { classes: ["mt-16"] }, [
			m(MenuTitle, { content: lang.getTranslationText("imapImportSummaryExportInformation_label") }),
			m(TextField, {
				label: "imapImportSummaryAccount_label",
				value: data.imapAccountUsername,
				isReadOnly: true,
				class: "surface-background mt-16",
				leadingIcon: { icon: Icons.MailFilled, color: theme.on_surface_variant },
			}),
			m(".flex", [
				m(TextField, {
					label: "imapImportSummaryHost_label",
					value: data.imapAccountHost,
					isReadOnly: true,
					class: "surface-background",
					leadingIcon: { icon: Icons.ServerFilled, color: theme.on_surface_variant },
				}),
				m(TextField, {
					label: "imapAccountPort_label",
					value: data.imapAccountPort.toString(),
					isReadOnly: true,
					class: "surface-background",
					leadingIcon: { icon: Icons.KeyFilled, color: theme.on_surface_variant },
				}),
			]),
		])
	}

	private renderImportInformation(data: ImapImportData) {
		return this.controller && this.controller.selectedMailBoxDetail
			? m(Card, { classes: ["mt-16"] }, [
					m(MenuTitle, { content: lang.getTranslationText("imapImportSummaryImportInformation_label") }),

					data.matchImportFoldersToTutanotaFolders
						? m(".flex.mt-16", [this.renderMailboxSummary(), this.renderLabel(data)])
						: m(".mt-16", [this.renderMailboxSummary(), m(".flex", [this.renderParentFolderSummary(data), this.renderLabel(data)])]),
				])
			: null
	}
	private renderMailboxSummary() {
		return this.controller && this.controller.selectedMailBoxDetail
			? m(TextField, {
					label: "mailbox_label",
					value: getMailboxName(mailLocator.logins, this.controller.selectedMailBoxDetail),
					isReadOnly: true,
					class: "surface-background",
					leadingIcon: { icon: Icons.MailFilled, color: theme.on_surface_variant },
				})
			: null
	}

	private renderParentFolderSummary(data: ImapImportData) {
		return this.controller && this.controller.selectedMailBoxDetail
			? m(TextField, {
					label: "imapImportSummaryParentFolder_label",
					value: data.rootImportMailFolderName,
					isReadOnly: !this.enableParentFolderEdit,
					oninput: (value) => (data.rootImportMailFolderName = value),
					class: this.enableParentFolderEdit ? "" : "surface-background",
					leadingIcon: { icon: Icons.FolderFilled, color: theme.on_surface_variant },
					injectionsRight: () => {
						return m(IconButton, {
							title: "label_label",
							icon: Icons.PenFilled,
							click: () => {
								this.enableParentFolderEdit = !this.enableParentFolderEdit
							},
						})
					},
				})
			: null
	}

	private renderLabel(data: ImapImportData) {
		return m(TextField, {
			label: "label_label",
			value: data.imapSyncLabelData?.name ?? "-",
			isReadOnly: true,
			class: "surface-background",
			leadingIcon: { icon: Icons.LabelFilled, color: theme.on_surface_variant },
			injectionsRight: () => {
				return m(".flex.items-center", [
					data.imapSyncLabelData
						? m(ColorOptionButton, {
								color: data.imapSyncLabelData.color,
								onClick: noOp,
							})
						: null,
					m(IconButton, {
						title: "label_label",
						icon: Icons.PenFilled,
						click: () => {
							if (!data.imapSyncLabelData) {
								data.imapSyncLabelData = tutanotaTypeRefs.createManageLabelServiceLabelData({ name: "", color: "" })
								data.addLabelToImportedMails = true
							}
							const labelData = data.imapSyncLabelData
							showImapEditLabelDialog(
								labelData,
								(value) => {
									if (labelData) {
										labelData.name = value
									} else {
										data.imapSyncLabelData = tutanotaTypeRefs.createManageLabelServiceLabelData({
											name: value,
											color: "",
										})
									}
								},
								(newColor: string) => {
									labelData.color = newColor
								},
							)
						},
					}),
				])
			},
		})
	}
}

export class ImapSummaryPageAttrs implements WizardPageAttrs<ImapImportData> {
	data: ImapImportData

	constructor(imapImportData: ImapImportData) {
		this.data = imapImportData
	}

	headerTitle(): TranslationKey {
		return "imapImportSetup_title"
	}

	stepTitle = "imapSyncFolderMapping_title" as TranslationKey

	hideAllPagingButtons = true
	hidePagingButtonForPage = true

	async nextAction(showErrorDialog: boolean = true): Promise<boolean> {
		// fixme add validation here
		const imapImportController = await mailLocator.imapImportController()
		const importImapAccount = tutanotaTypeRefs.createImportImapAccount({
			host: this.data.imapAccountHost,
			port: this.data.imapAccountPort.toString(),
			userName: this.data.imapAccountUsername,
			password: this.data.imapAccountPassword,
			tokenEndpointResponse:
				this.data.imapAccountOAuthToken !== undefined ? tokenEndpointResponseToTutadbTokenEndpointResponse(this.data.imapAccountOAuthToken) : null,
		})
		const commonImapImportParams = {
			maxQuota: DEFAULT_IMAP_IMPORT_MAX_QUOTA,
			isModifyingExistingImport: this.data.isModifyingExistingImport,
			mailGroupId: imapImportController.selectedMailBoxDetail!.mailGroup._id,
			imapSyncLabelData: this.data.imapSyncLabelData,
			provider: this.data.imapProvider,
		}
		const initializeImapImportParams: InitializeImapImportParams = this.data.matchImportFoldersToTutanotaFolders
			? {
					importImapAccount,
					...commonImapImportParams,

					matchImportFoldersToTutanotaFolders: true,
					imapMailboxesToTutaFolders: assertNotNull(this.data.imapMailboxesToTutaFolders),
				}
			: {
					importImapAccount,
					...commonImapImportParams,

					matchImportFoldersToTutanotaFolders: false,
					rootImportMailFolderName: this.data.rootImportMailFolderName,
				}

		const initializeResult = await initializeAndContinueImapImport(imapImportController, initializeImapImportParams)
		if (initializeResult.error) {
			// When isModifyingExistingImport is not set but post has successfully created the import state, then
			// we were not updating the data(password) with a patch. This covers the case that the auth failed but
			// not the post
			if (initializeResult.error.cause === ImapErrorCause.AUTH_FAILED) {
				this.data.isModifyingExistingImport = true
			}
			if (initializeResult.result && initializeResult.result.remoteStateId) {
				this.data.imapImportState = await imapImportController.loadImapImportState(initializeResult.result.remoteStateId)
			}

			if (initializeResult.error.cause === ImapErrorCause.AUTH_FAILED_REFRESH_TOKEN) {
				Dialog.message("imapImportAuthFailed_msg" as TranslationKey).then(() => false)
				return Promise.resolve(false)
			}

			return showErrorDialog ? Dialog.message("imapImportAuthFailed_msg" as TranslationKey).then(() => false) : Promise.resolve(false)
		} else if (initializeResult.result.state) {
			this.data.imapImportState = initializeResult.result.state

			if (this.data.imapImportState.state === ImportState.POSTPONED) {
				let postponedErrorMsg = "imapImportStartedPostponed_msg" as TranslationKey
				return showErrorDialog ? Dialog.message(postponedErrorMsg).then(() => true) : Promise.resolve(true)
			}
		}

		return Promise.resolve(true)
	}

	isSkipAvailable(): boolean {
		return false
	}

	isEnabled(): boolean {
		return true
	}
}

async function initializeAndContinueImapImport(
	imapImportController: ImapImportController,
	initializeImportParams: InitializeImapImportParams,
): Promise<ImportResult> {
	return await showProgressDialog(
		"startingImapImport_msg",
		imapImportController
			.initializeImport(initializeImportParams)
			.then(async (activeImport) => await imapImportController.continueImport(assertNotNull(activeImport.remoteStateId))),
	)
}
