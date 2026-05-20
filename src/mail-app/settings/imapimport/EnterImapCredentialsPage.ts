import m, { Children, Vnode, VnodeDOM } from "mithril"
import { ImapImportData } from "./AddImapImportWizard.js"
import { assertMainOrNode, ProgrammingError } from "@tutao/app-env"
import { emitWizardEvent, WizardEventType, WizardPageAttrs, WizardPageN } from "../../../common/gui/base/WizardDialog"
import { lang, TranslationKey } from "../../../common/misc/LanguageViewModel"
import { ToggleButton } from "../../../common/gui/base/buttons/ToggleButton"
import { GmailLogo, Icons, OutlookLogo } from "../../../common/gui/base/icons/Icons"
import { ButtonSize } from "../../../common/gui/base/ButtonSize"
import { TitleSectionAttrs, TitleSection } from "../../../common/gui/base/TitleSection"
import { px, size } from "../../../common/gui/size"
import { theme } from "../../../common/gui/theme"
import { TextField } from "../../../common/gui/base/TextField"
import { PrimaryButton } from "../../../common/gui/base/buttons/VariantButtons"
import { LegacyTextFieldType } from "../../../common/gui/base/LegacyTextField"
import { OauthHandler } from "../../../common/api/common/utils/imapImportUtils/OauthHandler"
import { mailLocator } from "../../mailLocator"
import { ImapProvider } from "../../../common/api/common/utils/imapImportUtils/ImapKnownConfigs"

assertMainOrNode()

export class EnterImapCredentialsPage implements WizardPageN<ImapImportData> {
	private dom: HTMLElement | null = null
	private shouldDisplayServerConfigFields: boolean = false
	private titleSectionParams: Partial<TitleSectionAttrs> = {
		icon: Icons.MailFilled,
		iconOptions: { color: theme.on_surface_variant },
		subTitle: lang.getTranslationText("imapSyncCredentialsInfo_msg"),
	}
	oncreate(vnode: VnodeDOM<WizardPageAttrs<ImapImportData>>) {
		this.dom = vnode.dom as HTMLElement
		// fixme modify this check when removing default values
		const provider = vnode.attrs.data.imapProvider
		switch (provider) {
			case ImapProvider.Google:
				this.titleSectionParams.icon = undefined
				this.titleSectionParams.iconOptions = undefined
				this.titleSectionParams.customIcon = m.trust(GmailLogo)
				break
			case ImapProvider.Microsoft:
				this.titleSectionParams.icon = undefined
				this.titleSectionParams.iconOptions = undefined
				this.titleSectionParams.customIcon = m.trust(OutlookLogo)
				break
		}
		this.shouldDisplayServerConfigFields = !vnode.attrs.data.isImapServerSupportingOAuth
	}

	view(vnode: Vnode<WizardPageAttrs<ImapImportData>>): Children {
		return m(".mt-24", [
			m(TitleSection, {
				...this.titleSectionParams,
				title: "",
				style: {
					marginTop: px(size.spacing_16),
					borderRadius: px(size.radius_16),
				},
			} as TitleSectionAttrs),
			m(".mt-16"),
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
			this.shouldDisplayServerConfigFields
				? m(
						".flex.row.gap-16.mt-16",
						m(TextField, {
							label: "imapAccountPassword_label",
							value: vnode.attrs.data.imapAccountPassword,
							oninput: (value) => (vnode.attrs.data.imapAccountPassword = value),
							type: vnode.attrs.data.revealImapAccountPassword ? LegacyTextFieldType.Text : LegacyTextFieldType.Password,
							injectionsRight: () => this.renderRevealIcon(vnode.attrs.data),
							class: "",
							leadingIcon: {
								icon: Icons.GenericLockFilled,
								color: theme.on_surface_variant,
							},
							disabled: vnode.attrs.data.isModifyingExistingImport,
						}),
					)
				: null,
			this.shouldDisplayServerConfigFields
				? m(".flex.row.gap-16.mt-16", [
						m(TextField, {
							label: "imapAccountHost_label",
							class: "",
							value: vnode.attrs.data.imapAccountHost,
							oninput: (value) => (vnode.attrs.data.imapAccountHost = value),
							leadingIcon: {
								icon: Icons.ServerFilled,
								color: theme.on_surface_variant,
							},
							disabled: vnode.attrs.data.isModifyingExistingImport,
						}),
						m(TextField, {
							label: "imapAccountPort_label",
							class: "",
							value: vnode.attrs.data.imapAccountPort.toString(),
							oninput: (value) => {
								const typedNumber = Number.parseInt(value)
								vnode.attrs.data.imapAccountPort = Number.isNaN(typedNumber) ? 0 : typedNumber
							},
							leadingIcon: {
								icon: Icons.KeyFilled,
								color: theme.on_surface_variant,
							},
							disabled: vnode.attrs.data.isModifyingExistingImport,
						}),
					])
				: null,
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
							if (vnode.attrs.data.isImapServerSupportingOAuth) {
								const config = vnode.attrs.data.oauthConfig
								if (config === undefined) {
									throw new ProgrammingError("The provider set to support OAuth without having configs, please review ImapKnownConfigs.ts")
								}
								const oauthHandler = new OauthHandler(config)
								await oauthHandler.setupOauthLoginParams()
								const controller = await mailLocator.imapImportController()
								const responseUrl = await controller.openOauthAuthenticationWindow(oauthHandler.buildAuthorizationUrl(), config.redirectUri)
								if (responseUrl) {
									vnode.attrs.data.imapAccountOAuthToken = await oauthHandler.getAuthTokens(responseUrl)
									//Only go forward if we have a token
									emitWizardEvent(dom, WizardEventType.SHOW_NEXT_PAGE)
								} else {
									this.titleSectionParams = {
										icon: Icons.FailureFilled,
										iconOptions: { color: theme.error },
										subTitle: lang.getTranslationText("imapImportWindowClosedFailure_msg"),
									}
								}
							} else {
								emitWizardEvent(dom, WizardEventType.SHOW_NEXT_PAGE)
							}
						},
					}),
				),
			),
		])
	}

	private renderRevealIcon(model: ImapImportData): Children {
		return m(ToggleButton, {
			title: model ? "concealPassword_action" : "revealPassword_action",
			toggled: model.revealImapAccountPassword,
			onToggled: (_, e) => {
				model.revealImapAccountPassword = !model.revealImapAccountPassword
				e.stopPropagation()
			},
			icon: model.revealImapAccountPassword ? Icons.EyeCrossedFilled : Icons.EyeFilled,
			size: ButtonSize.Compact,
		})
	}
}

export class EnterImapCredentialsPageAttrs implements WizardPageAttrs<ImapImportData> {
	data: ImapImportData

	constructor(imapImportData: ImapImportData) {
		this.data = imapImportData
	}

	headerTitle(): TranslationKey {
		return "imapImportSetup_title"
	}

	stepTitle = "imapSyncImap_title" as TranslationKey

	async nextAction(showErrorDialog: boolean = true): Promise<boolean> {
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
