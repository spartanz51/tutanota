import { EnterImapCredentialsPage, EnterImapCredentialsPageAttrs } from "./EnterImapCredentialsPage.js"
import { ConfigureImapImportPage, ConfigureImapImportPageAttrs } from "./ConfigureImapImportPage.js"
import { assertMainOrNode } from "@tutao/app-env"
import { createWizardDialog, wizardPageWrapper } from "../../../common/gui/base/WizardDialog"
import { Dialog, DialogType } from "../../../common/gui/base/Dialog"
import { ImapImportState, ImportState } from "../../../common/api/common/utils/imapImportUtils/ImapImportUtils"
import { ImapMigrationIntroductionPage, ImapMigrationIntroductionPageAttrs } from "./ImapMigrationIntroductionPage"
import { ImapProvider, OauthConfigParams } from "../../../common/api/common/utils/imapImportUtils/ImapKnownConfigs"
import type { TokenEndpointResponse } from "oauth4webapi"
import { tutanotaTypeRefs } from "@tutao/typerefs"
import { ImapSummaryPage, ImapSummaryPageAttrs } from "./ImapSummaryPage"
import { ImapMailbox } from "../../../common/api/common/utils/imapImportUtils/ImapMailbox"
import { FolderSystem } from "../../../common/api/common/mail/FolderSystem"
import { ImapProviderSelectionPage, ImapProviderSelectionPageAttrs } from "./ImapProviderSelectionPage"

assertMainOrNode()

export type ImapImportData = {
	oauthConfig?: OauthConfigParams
	imapAccountOAuthToken?: TokenEndpointResponse
	imapProvider: ImapProvider
	imapAccountHost: string
	imapAccountPort: number
	imapAccountUsername: string
	imapAccountPassword: string
	rootImportMailFolderName: string
	revealImapAccountPassword: boolean
	imapImportState: ImapImportState
	matchImportFoldersToTutanotaFolders: boolean
	imapMailboxes: ImapMailbox[]
	folderSystem: FolderSystem
	imapMailboxesToTutaFolders?: Map<string, Id>
	isModifyingExistingImport: boolean
	addLabelToImportedMails: boolean
	isImapServerSupportingOAuth: boolean
	imapSyncLabelData: tutanotaTypeRefs.ManageLabelServiceLabelData | null
}

/** Shows a wizard for adding an IMAP import. */
export function showAddImapImportWizard(imapImportData: ImapImportData): Promise<void> {
	const wizardPages = [
		wizardPageWrapper(ImapProviderSelectionPage, new ImapProviderSelectionPageAttrs(imapImportData)),
		wizardPageWrapper(ImapMigrationIntroductionPage, new ImapMigrationIntroductionPageAttrs(imapImportData)),
		wizardPageWrapper(EnterImapCredentialsPage, new EnterImapCredentialsPageAttrs(imapImportData)),
		wizardPageWrapper(ConfigureImapImportPage, new ConfigureImapImportPageAttrs(imapImportData)),
		wizardPageWrapper(ImapSummaryPage, new ImapSummaryPageAttrs(imapImportData)),
	]

	return new Promise((resolve) => {
		const wizardBuilder = createWizardDialog({
			data: imapImportData,
			pages: wizardPages,
			closeAction: () => {
				resolve()
				if (imapImportData.imapImportState.state === ImportState.RUNNING) {
					Dialog.showImapInitializationSuccessfulDialog()
				}
				return Promise.resolve()
			},
			dialogType: DialogType.ImapWizard,
		})
		const wizard = wizardBuilder.dialog
		const wizardAttrs = wizardBuilder.attrs
		wizard.show()
	})
}
