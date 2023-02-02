import { ImapMailAttachment, ImapMailBody, ImapMailEnvelope } from "../../../../api/common/utils/imapImportUtils/ImapMail.js"

import { promiseMap } from "@tutao/utils"
import { PostalMime } from "./postalmime-custom.js"

export type MailParserAddress = {
	name: string
	address: string
	group: MailParserAddress[]
}

export type MailParserAddressObject = {
	value: MailParserAddress[]
	text: string
	html: string
}

export interface ParsedImapRFC822 {
	parsedEnvelope?: ImapMailEnvelope
	parsedBody?: ImapMailBody
	parsedAttachments?: ImapMailAttachment[]
}

// TODO perform security HTML, etc. cleansing / sanitization
// TODO DOMPurify only works on the main thread, how should we handle this?
export class ImapMailRFC822Parser {
	constructor() {}

	async parseSource(source: Buffer): Promise<ParsedImapRFC822> {
		const parsedImapRFC822: ParsedImapRFC822 = {}

		const email = await PostalMime.parse(source, {
			attachmentEncoding: "arraybuffer",
		})

		parsedImapRFC822.parsedEnvelope = ImapMailEnvelope.fromPostalMimeEmail(email)

		parsedImapRFC822.parsedBody = new ImapMailBody(email.html ?? "", email.text ?? "")

		parsedImapRFC822.parsedAttachments = await promiseMap(email.attachments, async (attachment) => {
			//when parsing, the encoding is set to arrayBuffer, so this will always be an arrayBuffer.
			const content = attachment.content as ArrayBuffer
			const size = content.byteLength
			return (
				new ImapMailAttachment(size, attachment.mimeType, Buffer.from(new Uint8Array(content)), attachment.related ?? false)
					//FIXME: If filename is unknown, use the mimeType to determine the extension.
					.setFilename(attachment.filename ?? attachment.description ?? attachment.mimeType ?? "unknown")
					.setCid(attachment.contentId)
			)
		})

		return parsedImapRFC822
	}
}
