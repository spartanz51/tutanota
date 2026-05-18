import m, { Children, Vnode, VnodeDOM } from "mithril"
import { ImapImportData } from "./AddImapImportWizard.js"
import { assertMainOrNode } from "@tutao/app-env"
import { emitWizardEvent, WizardEventType, WizardPageAttrs, WizardPageN } from "../../../common/gui/base/WizardDialog"
import { lang, TranslationKey } from "../../../common/misc/LanguageViewModel"
import { Icons } from "../../../common/gui/base/icons/Icons"
import { TitleSection } from "../../../common/gui/base/TitleSection"
import { px, size } from "../../../common/gui/size"
import { ImapImportController } from "../../native/main/ImapImportController"
import { mailLocator } from "../../mailLocator"
import { theme } from "../../../common/gui/theme"
import { getConfigForProvider, ImapAuthType, ImapProvider } from "../../../common/api/common/utils/imapImportUtils/ImapKnownConfigs"
import { PrimaryButton } from "../../../common/gui/base/buttons/VariantButtons"
import { Button, ButtonType } from "../../../common/gui/base/Button"
import { Icon } from "../../../common/gui/base/Icon"

assertMainOrNode()

const initialTitleSectionParams = {
	icon: Icons.MailFilled,
	iconOptions: { color: theme.on_surface_variant },
	subTitle: lang.getTranslationText("imapSyncChooseProvider_msg"),
}

export class ImapProviderSelectionPage implements WizardPageN<ImapImportData> {
	private dom: HTMLElement | null = null
	private selectedProvider: ImapProvider = ImapProvider.Other
	private titleSectionParams = initialTitleSectionParams

	oncreate(vnode: VnodeDOM<WizardPageAttrs<ImapImportData>>) {
		this.dom = vnode.dom as HTMLElement
	}

	view(vnode: Vnode<WizardPageAttrs<ImapImportData>>): Children {
		return m(".mt-24", [
			m(TitleSection, {
				title: "",
				style: {
					marginTop: px(size.spacing_16),
					borderRadius: px(size.radius_16),
				},
				...this.titleSectionParams,
			}),
			this.renderOptionButtons(vnode.attrs.data),
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
							const imapConfig = getConfigForProvider(this.selectedProvider)
							if (imapConfig.authType === ImapAuthType.Oauth2) {
								vnode.attrs.data.isImapServerSupportingOAuth = true
								vnode.attrs.data.oauthConfig = imapConfig.oauthConfig
							}
							vnode.attrs.data.imapAccountHost = imapConfig.host
							vnode.attrs.data.imapAccountPort = Number.parseInt(imapConfig.port)
							vnode.attrs.data.imapProvider = this.selectedProvider
							emitWizardEvent(dom, WizardEventType.SHOW_NEXT_PAGE)
						},
						disabled: this.selectedProvider === null || this.selectedProvider === ImapProvider.Yahoo,
					}),
				),
			),
		])
	}

	private renderOptionButtons(data: ImapImportData): Children {
		const selectedItemClasses = ".border.border-radius.provider-selector"
		return m(".flex.row.gap-16.mt-16.justify-center", [
			m(
				`${this.selectedProvider === ImapProvider.Google ? selectedItemClasses : ""}.provider-selector`,
				m(Button, {
					label: "imapProviderGoogle_label",
					click: () => {
						this.titleSectionParams = initialTitleSectionParams
						this.selectedProvider = ImapProvider.Google
						data.imapAccountUsername = "@gmail.com"
					},
					icon: m(Icon, {
						icon: Icons.FolderFilled,
						class: "pr-4 flex items-center",
					}),
					class: ["content-fg"],
					type: ButtonType.Secondary,
				}),
			),
			m(
				`${this.selectedProvider === ImapProvider.Microsoft ? selectedItemClasses : ""}.provider-selector`,
				m(Button, {
					label: "imapProviderOutlook_label",
					click: () => {
						this.titleSectionParams = initialTitleSectionParams
						this.selectedProvider = ImapProvider.Microsoft
						data.imapAccountUsername = "@outlook.com"
					},
					icon: m(Icon, {
						icon: Icons.KeyFilled,
						class: "pr-4 flex items-center",
					}),
					type: ButtonType.Secondary,
				}),
			),
			m(
				`${this.selectedProvider === ImapProvider.Yahoo ? selectedItemClasses : ""}.provider-selector`,
				m(Button, {
					label: "imapProviderYahoo_label",
					click: () => {
						this.selectedProvider = ImapProvider.Yahoo
						this.titleSectionParams = {
							icon: Icons.InfoFilled,
							iconOptions: { color: theme.warning },
							subTitle: lang.getTranslationText("imapSyncYahooWarning_msg"),
						}
					},
					icon: m(Icon, {
						icon: Icons.Paperclip,
						class: "pr-4 flex items-center",
					}),
					type: ButtonType.Secondary,
				}),
			),
			m(
				`${this.selectedProvider === ImapProvider.Other ? selectedItemClasses : ""}.provider-selector`,
				m(Button, {
					label: "other_label",
					click: () => {
						this.titleSectionParams = initialTitleSectionParams
						this.selectedProvider = ImapProvider.Other
						data.imapAccountUsername = ""
					},
					type: ButtonType.Secondary,
				}),
			),
		])
	}
}

export class ImapProviderSelectionPageAttrs implements WizardPageAttrs<ImapImportData> {
	data: ImapImportData

	stepTitle = "imapSyncFolderMapping_title" as TranslationKey
	hideAllPagingButtons = true
	hidePagingButtonForPage = true

	constructor(imapImportData: ImapImportData) {
		this.data = imapImportData
	}

	headerTitle(): TranslationKey {
		return "imapImportSetup_title"
	}

	nextAction(_: boolean = true): Promise<boolean> {
		return Promise.resolve(true)
	}

	isSkipAvailable(): boolean {
		return false
	}

	isEnabled(): boolean {
		return true
	}
}
