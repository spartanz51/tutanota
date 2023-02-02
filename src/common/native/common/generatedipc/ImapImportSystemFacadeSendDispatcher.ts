/* generated file, don't edit. */

import { ImapImportSystemFacade } from "./ImapImportSystemFacade.js"

interface NativeInterface {
	invokeNative(requestType: string, args: unknown[]): Promise<any>
}
export class ImapImportSystemFacadeSendDispatcher implements ImapImportSystemFacade {
	constructor(private readonly transport: NativeInterface) {}
	async startImport(...args: Parameters<ImapImportSystemFacade["startImport"]>) {
		return this.transport.invokeNative("ipc", ["ImapImportSystemFacade", "startImport", ...args])
	}
	async getImapMailboxesFromServer(...args: Parameters<ImapImportSystemFacade["getImapMailboxesFromServer"]>) {
		return this.transport.invokeNative("ipc", ["ImapImportSystemFacade", "getImapMailboxesFromServer", ...args])
	}
	async stopImport(...args: Parameters<ImapImportSystemFacade["stopImport"]>) {
		return this.transport.invokeNative("ipc", ["ImapImportSystemFacade", "stopImport", ...args])
	}
}
