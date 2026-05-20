import m, { Children, Vnode, VnodeDOM } from "mithril"
import { ImapImportData } from "./AddImapImportWizard.js"
import { assertMainOrNode } from "@tutao/app-env"
import { emitWizardEvent, WizardEventType, WizardPageAttrs, WizardPageN } from "../../../common/gui/base/WizardDialog"
import { lang, TranslationKey } from "../../../common/misc/LanguageViewModel"
import { GmailLogo, Icons, OutlookLogo } from "../../../common/gui/base/icons/Icons"
import { TitleSection, TitleSectionAttrs } from "../../../common/gui/base/TitleSection"
import { px, size } from "../../../common/gui/size"
import { ImapImportController } from "../../native/main/ImapImportController"
import { getMailboxName } from "../../../common/mailFunctionality/SharedMailUtils"
import { mailLocator } from "../../mailLocator"
import { MailboxDetail } from "../../../common/mailFunctionality/MailboxModel"
import { theme } from "../../../common/gui/theme"
import { DropDownSelectorNew, DropDownSelectorNewAttrs } from "../../../common/gui/base/DropDownSelectorNew"
import { TextField } from "../../../common/gui/base/TextField"
import { PrimaryButton } from "../../../common/gui/base/buttons/VariantButtons"
import { ImapProvider } from "../../../common/api/common/utils/imapImportUtils/ImapKnownConfigs"
import { guessServerImapConfigFromEmail } from "../../../common/api/common/utils/imapImportUtils/ImapImportUtils"

assertMainOrNode()

export class ImapMigrationIntroductionPage implements WizardPageN<ImapImportData> {
	private dom: HTMLElement | null = null
	private controller: ImapImportController | null = null

	oncreate(vnode: VnodeDOM<WizardPageAttrs<ImapImportData>>) {
		this.dom = vnode.dom as HTMLElement
	}

	async oninit() {
		this.controller = await mailLocator.imapImportController()
	}

	view(vnode: Vnode<WizardPageAttrs<ImapImportData>>): Children {
		const imapProvider = vnode.attrs.data.imapProvider
		let titleSectionParams: Partial<TitleSectionAttrs>
		switch (imapProvider) {
			case ImapProvider.Google:
				titleSectionParams = {
					customIcon: m.trust(GmailLogo),
				}
				break
			case ImapProvider.Microsoft:
				titleSectionParams = {
					customIcon: m.trust(OutlookLogo),
				}
				break
			default:
				titleSectionParams = {
					icon: Icons.MailFilled,
					iconOptions: { color: theme.on_surface_variant },
				}
		}
		return m(".mt-24", [
			m(TitleSection, {
				...titleSectionParams,
				title: "",
				subTitle: lang.getTranslationText("imapSyncIntroductionInfo_msg"),
				style: {
					marginTop: px(size.spacing_16),
					borderRadius: px(size.radius_16),
				},
			}),
			m(".flex.row.gap-16.mt-16", [
				m(TextField, {
					label: "imapAccountUsername_label",
					class: "",
					value: vnode.attrs.data.imapAccountUsername,
					oninput: (value) => (vnode.attrs.data.imapAccountUsername = value),
					leadingIcon: {
						icon: Icons.MailFilled,
						color: theme.on_surface_variant,
					},
					disabled: vnode.attrs.data.isModifyingExistingImport,
				}),
				this.controller !== null ? this.renderMailboxSelectionControls(this.controller) : null,
			]),
			m(
				".flex-end.full-width.pt-32.mb-32",
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
						onclick: async (_, dom) => {
							if (vnode.attrs.data.imapProvider === ImapProvider.Other) {
								//Get settings if user is not using IMAP and if none exist, allow the user
								//to set it up.
								const imapConfig = guessServerImapConfigFromEmail(vnode.attrs.data.imapAccountUsername)
								if (imapConfig) {
									vnode.attrs.data.imapAccountHost = imapConfig.host
									vnode.attrs.data.imapAccountPort = Number.parseInt(imapConfig.port)
								}
							}
							emitWizardEvent(dom, WizardEventType.SHOW_NEXT_PAGE)
						},
					}),
				),
			),
		])
	}

	private renderMailboxSelectionControls(imapImportController: ImapImportController) {
		const mailboxesDetails = imapImportController.mailboxDetails
		return mailboxesDetails.length > 1
			? m(DropDownSelectorNew, {
					label: "ImapImportDestination_label",
					items: mailboxesDetails.map((mailboxDetail) => {
						return { name: getMailboxName(mailLocator.logins, mailboxDetail), value: mailboxDetail }
					}),
					selectedValue: imapImportController.selectedMailBoxDetail,
					selectionChangedHandler: (selectedMailboxDetail) => {
						imapImportController.onNewMailboxSelected(selectedMailboxDetail)
					},
					dropdownWidth: 300,
					helpLabel: () => null,
					icon: {
						icon: Icons.InboxFilled,
						color: theme.on_surface_variant,
					},
				} satisfies DropDownSelectorNewAttrs<MailboxDetail>)
			: null
	}
}

export class ImapMigrationIntroductionPageAttrs implements WizardPageAttrs<ImapImportData> {
	data: ImapImportData

	constructor(imapImportData: ImapImportData) {
		this.data = imapImportData
	}

	headerTitle(): TranslationKey {
		return "imapImportSetup_title"
	}

	stepTitle = "imapSyncCredentials_title" as TranslationKey

	nextAction(showErrorDialog: boolean = true): Promise<boolean> {
		// fixme add validation here
		return Promise.resolve(true)
	}

	isSkipAvailable(): boolean {
		return false
	}

	isEnabled(): boolean {
		return true
	}
}
