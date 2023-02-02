import { tutanotaTypeRefs } from "@tutao/typerefs"
import { ImapImportState, ImportState } from "../../../common/api/common/utils/imapImportUtils/ImapImportUtils"
import { MaybePromise } from "rollup"

export class ImapImportSession {
	imapImportState: ImapImportState
	importImapAccountSyncState: tutanotaTypeRefs.ImportImapAccountSyncState
	importImapFolderSyncStates: tutanotaTypeRefs.ImportImapFolderSyncState[] = []
	importedMessageIds: Set<string> = new Set()
	deduplicatedImportedAttachmentHashToFileId: Map<string, MaybePromise<IdTuple | undefined>> = new Map()
	imapMailboxesToTutaFolders: Map<string, Id> = new Map()

	constructor(accountSyncState: tutanotaTypeRefs.ImportImapAccountSyncState) {
		this.importImapAccountSyncState = accountSyncState
		this.imapImportState = new ImapImportState(ImportState.PAUSED)
	}
}
