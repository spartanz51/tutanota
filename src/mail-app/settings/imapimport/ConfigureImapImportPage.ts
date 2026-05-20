import m, { Children, Vnode, VnodeDOM } from "mithril"
import { assertMainOrNode, MailSetKind } from "@tutao/app-env"
import { elementIdPart, getElementId, tutanotaTypeRefs } from "@tutao/typerefs"
import { assertNotNull } from "@tutao/utils"
import { emitWizardEvent, WizardEventType, WizardPageAttrs, WizardPageN } from "../../../common/gui/base/WizardDialog"
import { TextField } from "../../../common/gui/base/TextField"
import { lang, MaybeTranslation, TranslationKey } from "../../../common/misc/LanguageViewModel"
import {
	importImapAccountToImapAccount,
	tokenEndpointResponseToTutadbTokenEndpointResponse,
} from "../../../common/api/common/utils/imapImportUtils/ImapImportUtils"
import { Switch } from "../../../common/gui/base/Switch"
import { ImapImportData } from "./AddImapImportWizard"
import { ImapImportController } from "../../native/main/ImapImportController"
import { ImapErrorCause } from "../../../common/desktop/imapimport/adsync/imapmail/ImapError"
import { TitleSection } from "../../../common/gui/base/TitleSection"
import { Icons } from "../../../common/gui/base/icons/Icons"
import { px, size } from "../../../common/gui/size"
import { theme } from "../../../common/gui/theme"
import { PrimaryButton } from "../../../common/gui/base/buttons/VariantButtons"
import { mailLocator } from "../../mailLocator"
import { createImportImapAccount } from "../../../typerefs/entities/tutanota/TypeRefs"
import { ImapMailbox } from "../../../common/api/common/utils/imapImportUtils/ImapMailbox"
import { ImapAccount } from "../../../common/desktop/imapimport/adsync/ImapSyncState"
import { FolderSystem } from "../../../common/api/common/mail/FolderSystem"
import { getFolderIconByType } from "../../mail/view/MailGuiUtils"
import { Icon, IconSize } from "../../../common/gui/base/Icon"
import { IconButton } from "../../../common/gui/base/IconButton"
import { DropDownSelectorNew, DropDownSelectorNewAttrs } from "../../../common/gui/base/DropDownSelectorNew"
import { getFolderName } from "../../mail/model/MailUtils"
import { showEditFolderDialog } from "../../mail/view/EditFolderDialog"
import { ColorOptionButton } from "../../../common/gui/base/colorPicker/ColorOptionButton"
import { isValidCSSHexColor } from "../../../common/gui/base/Color"
import { showImapEditLabelDialog } from "../../mail/view/EditLabelDialog"
import { Card } from "../../../common/gui/base/Card"

assertMainOrNode()

export class ConfigureImapImportPage implements WizardPageN<ImapImportData> {
	private dom: HTMLElement | null = null
	private shouldDisplayFolderTextField: boolean = true
	private shouldDisplayLabelField: boolean = false
	private imapAccount: ImapAccount | null = null
	private controller: ImapImportController | null = null
	private imapMailboxes: ImapMailbox[] = []
	private imapMailboxesToTutaFolders: Map<string, Id> | null = null
	private folderSystem: FolderSystem = new FolderSystem([])
	private titleSectionParams = {
		icon: Icons.GearWheelFilled,
		iconOptions: { color: theme.on_surface_variant, class: "icon-progress" },
		subTitle: lang.getTranslationText("imapSyncConfigInfo_msg"),
	}
	private shouldDisplayHover: boolean = false
	private successfullyLoadedMailboxes: boolean = false
	private hoverPosition: { left: number; top: number } = { left: 0, top: 0 }
	//Whichever translation this starts with will be changed by the appropriate methods, so initial vaklue isn't visible.
	private hoverInfo: MaybeTranslation = "imapConfigurationLinkFoldersInfo_msg"

	oncreate(vnode: VnodeDOM<WizardPageAttrs<ImapImportData>>) {
		this.dom = vnode.dom as HTMLElement
		this.shouldDisplayFolderTextField = !vnode.attrs.data.matchImportFoldersToTutanotaFolders
		this.shouldDisplayLabelField = vnode.attrs.data.addLabelToImportedMails
		const imapAccountOAuthToken = vnode.attrs.data.imapAccountOAuthToken
		this.imapAccount = importImapAccountToImapAccount(
			createImportImapAccount({
				host: vnode.attrs.data.imapAccountHost,
				port: vnode.attrs.data.imapAccountPort.toString(),
				userName: vnode.attrs.data.imapAccountUsername,
				password: vnode.attrs.data.imapAccountPassword,
				tokenEndpointResponse: imapAccountOAuthToken !== undefined ? tokenEndpointResponseToTutadbTokenEndpointResponse(imapAccountOAuthToken) : null,
			}),
		)
	}

	async oninit() {
		this.controller = await mailLocator.imapImportController()
		const imapMailboxResult = await this.controller.getImapMailboxesFromServer(assertNotNull(this.imapAccount))
		this.folderSystem = this.controller.getFolderSystemForSelectedMailbox()
		if (imapMailboxResult.result) {
			this.imapMailboxes.push(...imapMailboxResult.result)
			this.imapMailboxesToTutaFolders = await this.controller.constructImapMailboxesToTutaFoldersMap(imapMailboxResult.result)
			this.successfullyLoadedMailboxes = true
			this.titleSectionParams.iconOptions.class = ""
			m.redraw()
		} else if (imapMailboxResult.error) {
			// TODO: Perhaps we can remove this
			if (imapMailboxResult.error.cause !== ImapErrorCause.LIST_MAILBOX_FAILED) {
				console.error("Unknown cause....", imapMailboxResult.error)
			}
			this.titleSectionParams = {
				icon: Icons.FailureFilled,
				iconOptions: { color: theme.error, class: "" },
				subTitle: lang.getTranslation("imapImportMailBoxListFailure_msg", {
					"{error}": imapMailboxResult.error.error,
				}).text,
			}
		}
	}

	view(vnode: Vnode<WizardPageAttrs<ImapImportData>>): Children {
		const obj = this
		const data = vnode.attrs.data
		data.imapMailboxesToTutaFolders = this.imapMailboxesToTutaFolders ?? undefined
		data.imapMailboxes = this.imapMailboxes
		data.folderSystem = this.folderSystem
		const isFolderMappingCompleted =
			data.rootImportMailFolderName !== "" ||
			(data.matchImportFoldersToTutanotaFolders && obj.imapMailboxes.length === data.imapMailboxesToTutaFolders?.size)
		const isLabelCorrectlySet =
			!data.addLabelToImportedMails ||
			(data.imapSyncLabelData !== null && data.imapSyncLabelData.name !== "" && isValidCSSHexColor(data.imapSyncLabelData.color))
		const shouldAllowContinuing = isFolderMappingCompleted && isLabelCorrectlySet && this.successfullyLoadedMailboxes

		return m(".mt-24", { style: { maxHeight: "65vh" } }, [
			this.shouldDisplayHover ? this.renderHoverInfo(this.hoverPosition.left, this.hoverPosition.top, lang.getTranslationText(this.hoverInfo)) : null,
			m(
				".mt-16",
				m(TitleSection, {
					...this.titleSectionParams,
					title: "",
					style: {
						borderRadius: px(size.radius_16),
					},
				}),
			),
			m(".tutaui-switch.mt-16", [
				m(Switch, {
					ariaLabel: "imapAddLabelToImportedMails_label",
					checked: data.addLabelToImportedMails,
					onclick(checked: boolean) {
						obj.shouldDisplayLabelField = checked
						data.addLabelToImportedMails = checked
						if (!checked) {
							data.imapSyncLabelData = null
						}
					},
					disabled: data.isModifyingExistingImport,
				}),
				m("", lang.getTranslationText("imapAddLabelToImportedMails_label")),
				m(IconButton, {
					icon: Icons.QuestionmarkFilled,
					title: "imapSyncFolderMapping_title",
					click: this.updateHoverMessage("imapConfigurationAddLabelInfo_msg"),
				}),
			]),
			this.shouldDisplayLabelField
				? m(TextField, {
						label: "labelInput_label",
						value: data.imapSyncLabelData?.name ?? "",
						oninput: (value) => {
							if (data.imapSyncLabelData) {
								data.imapSyncLabelData.name = value
							} else {
								data.imapSyncLabelData = tutanotaTypeRefs.createManageLabelServiceLabelData({ name: value, color: "" })
							}
						},
						leadingIcon: {
							icon: Icons.LabelFilled,
							color: theme.on_surface_variant,
						},
						injectionsRight: () => {
							return m(ColorOptionButton, {
								color: data.imapSyncLabelData?.color ?? "",
								onClick: () => {
									if (!data.imapSyncLabelData) {
										data.imapSyncLabelData = tutanotaTypeRefs.createManageLabelServiceLabelData({ name: "", color: "" })
									}
									const labelData = data.imapSyncLabelData
									showImapEditLabelDialog(
										labelData,
										(value) => {
											if (data.imapSyncLabelData) {
												data.imapSyncLabelData.name = value
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
							})
						},
						helpLabel: () => lang.getTranslationText("imapLabelInput_helpLabel"),
						disabled: data.isModifyingExistingImport,
					})
				: null,
			m(".tutaui-switch.mt-16", [
				m(Switch, {
					ariaLabel: "matchImportFoldersToTutanotaFolders_label",
					checked: data.matchImportFoldersToTutanotaFolders,
					onclick: (checked: boolean) => {
						obj.shouldDisplayFolderTextField = !checked
						data.matchImportFoldersToTutanotaFolders = checked
						if (checked) {
							data.rootImportMailFolderName = ""
						}
						m.redraw()
					},
					disabled: data.isModifyingExistingImport,
				}),
				m("", lang.getTranslationText("matchImportFoldersToTutanotaFolders_label")),
				m(IconButton, {
					icon: Icons.QuestionmarkFilled,
					title: "imapSyncFolderMapping_title",
					click: this.updateHoverMessage("imapConfigurationLinkFoldersInfo_msg"),
				}),
			]),
			this.shouldDisplayFolderTextField
				? m(TextField, {
						label: "imapImportRootMailFolderName_label",
						value: data.rootImportMailFolderName,
						oninput: (value) => (data.rootImportMailFolderName = value),
						helpLabel: () => lang.getTranslationText("imapImportRootMailFolderName_helpLabel"),
						disabled: data.isModifyingExistingImport,
						leadingIcon: {
							icon: Icons.FolderFilled,
							color: theme.on_surface_variant,
						},
					})
				: null,
			!this.shouldDisplayFolderTextField && this.controller ? this.renderFolderMapping(data) : null,
			m(
				".flex-center.full-width.justify-end.pt-32.mb-32",
				m(
					"",
					{
						style: {
							width: "260px",
						},
					},
					m(PrimaryButton, {
						label: "continue_action",
						class: "wizard-next-button",
						onclick: (_, dom) => {
							emitWizardEvent(dom, WizardEventType.SHOW_NEXT_PAGE)
						},
						disabled: !shouldAllowContinuing,
					}),
				),
			),
		])
	}

	private updateHoverMessage(textMessage: MaybeTranslation) {
		return (event: MouseEvent) => {
			const isDisplayingHoverForPressedButton = this.shouldDisplayHover && this.hoverInfo === textMessage
			if (isDisplayingHoverForPressedButton) {
				this.shouldDisplayHover = false
				return
			}
			const target = event.target as Element
			const button = target.closest(".icon-button")
			const dialogWindow = target.closest('[role="dialog"]')

			if (button && dialogWindow) {
				const targetRect = button.getBoundingClientRect()
				const dialogRect = dialogWindow.getBoundingClientRect()

				const shiftDistance = 45
				// When calculating the left distance, it is being considered against the actual left side of screen
				const hoverWindowLeft = targetRect.left + shiftDistance
				//This top however is considering the dialog rect as it's start, then we need to do the calculation
				const hoverWindowTop = targetRect.top - dialogRect.top - shiftDistance
				this.hoverInfo = textMessage
				this.hoverPosition = {
					left: hoverWindowLeft,
					top: hoverWindowTop,
				}

				this.shouldDisplayHover = true
			}
		}
	}

	private renderFolderMapping(data: ImapImportData) {
		const imapMailboxToTutaFolderRows = this.imapMailboxes.map((imapMailbox) => {
			const tutaMailSetElementId = data.imapMailboxesToTutaFolders?.get(imapMailbox.path)
			let tutaMailSet: tutanotaTypeRefs.MailSet | null = null
			if (tutaMailSetElementId) {
				tutaMailSet = this.folderSystem.getFolderById(tutaMailSetElementId)
			}
			return { imapMailbox, tutaMailSet }
		})
		const obj = this
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
							//"background-color": "initial",
							//minHeight: px(bubbleButtonHeight()),
						},
					}),
					m(DropDownSelectorNew, {
						selectedValue: mailboxToRow.tutaMailSet,
						selectedValueDisplay: mailboxToRow.tutaMailSet
							? getFolderName(mailboxToRow.tutaMailSet)
							: lang.getTranslationText("imapChooseFolder_msg"),
						items: obj.folderSystem
							.getIndentedList(null)
							.map((indentedFolder) => ({ name: getFolderName(indentedFolder.folder), value: indentedFolder.folder })),
						style: mailboxToRow.tutaMailSet
							? {}
							: {
									background: theme.warning_container,
									color: theme.on_warning_container,
								},
						icon: {
							icon: !mailboxToRow.tutaMailSet ? Icons.FolderFilled : getFolderIconByType(mailboxToRow.tutaMailSet.folderType as MailSetKind),
							color: theme.on_surface_variant,
						},
						selectionChangedHandler: (selectedMailSet) => {
							this.imapMailboxesToTutaFolders?.set(mailboxToRow.imapMailbox.path, getElementId(selectedMailSet))
						},
					} satisfies DropDownSelectorNewAttrs<tutanotaTypeRefs.MailSet>),
					m(IconButton, {
						icon: Icons.Plus,
						title: "selectMultiple_action",
						click: async () => {
							if (this.controller) {
								let newFolderElementId: Id | null = null
								await showEditFolderDialog(
									assertNotNull(this.controller.selectedMailBoxDetail),
									null,
									null,
									mailboxToRow.imapMailbox.name,
									(folderId) => (newFolderElementId = elementIdPart(folderId)),
								)
								obj.folderSystem = assertNotNull(this.controller).getFolderSystemForSelectedMailbox()
								if (newFolderElementId !== null) {
									data.imapMailboxesToTutaFolders?.set(mailboxToRow.imapMailbox.path, newFolderElementId)
								}
							}
						},
					}),
				])
			}),
		)
	}

	private renderHoverInfo(left: number, top: number, message: string): Children {
		return m(
			".hover-panel.border.border-radius",
			{
				style: {
					left: px(left),
					top: px(top),
				},
			},
			[
				m(Card, {}, [
					m(
						".flex.items-center.justify-center",
						m(Icon, {
							icon: Icons.InfoFilled,
							size: IconSize.PX32,
							style: {
								fill: theme.on_surface_variant,
							},
						}),
					),
					m("", message),
				]),
			],
		)
	}
}

export class ConfigureImapImportPageAttrs implements WizardPageAttrs<ImapImportData> {
	data: ImapImportData

	constructor(imapImportData: ImapImportData) {
		this.data = imapImportData
	}

	headerTitle(): TranslationKey {
		return "imapImportSetup_title"
	}

	stepTitle = "imapSyncConfig_title" as TranslationKey

	async nextAction(showErrorDialog: boolean = true): Promise<boolean> {
		return Promise.resolve(true)
	}

	isSkipAvailable(): boolean {
		return false
	}

	isEnabled(): boolean {
		return true
	}
}
