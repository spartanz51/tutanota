import * as client from "./openid-client-custom"
import { Configuration, refreshTokenGrant } from "openid-client"
import { OauthConfigParams } from "./ImapKnownConfigs"
import { ProgrammingError } from "@tutao/app-env"

const CODE_CHALLENGE_METHOD = "S256"

export class OauthHandler {
	private config: Configuration | null
	private readonly OauthConfig: OauthConfigParams
	private state: any
	private parameters: any
	private code_verifier: string

	constructor(config: OauthConfigParams) {
		this.OauthConfig = config
		this.code_verifier = ""
		this.config = null
	}

	/**
	 * Initialise OpenID Client using Microsoft discovery
	 */
	async setupOauthLoginParams(): Promise<void> {
		const { server, clientId } = this.OauthConfig

		if (this.OauthConfig.clientSecret) {
			// Required to have the secret by google, see: https://discuss.google.dev/t/is-it-ok-to-put-a-client-secret-in-a-desktop-app/296820/6
			const auth = client.ClientSecretPost(this.OauthConfig.clientSecret)
			this.config = await client.discovery(new URL(server), clientId, undefined, auth)
		} else {
			this.config = await client.discovery(new URL(server), clientId)
		}

		this.code_verifier = client.randomPKCECodeVerifier()
		const code_challenge = await client.calculatePKCECodeChallenge(this.code_verifier)

		this.state = client.randomState()

		this.parameters = {
			code_challenge,
			code_challenge_method: CODE_CHALLENGE_METHOD,
			redirect_uri: this.OauthConfig.redirectUri,
			scope: this.OauthConfig.scope,
			state: this.state,
			...this.OauthConfig.additionalAuthParams,
		}
	}

	buildAuthorizationUrl(): string {
		if (this.config == null) {
			throw new ProgrammingError("Cannot get url out of null config settings!")
		}
		const url = client.buildAuthorizationUrl(this.config, this.parameters)
		return url.href
	}

	async getAuthTokens(responseUrl: string) {
		if (this.config == null) {
			throw new ProgrammingError("Cannot get url out of null config settings!")
		}
		const currentUrl = new URL(responseUrl)

		return await client.authorizationCodeGrant(this.config, currentUrl, {
			pkceCodeVerifier: this.code_verifier,
			expectedState: this.state,
		})
	}

	async refreshTokens(refreshToken: string) {
		if (this.config == null) {
			throw new ProgrammingError("Cannot get url out of null config settings!")
		}

		return await client.refreshTokenGrant(this.config, refreshToken)
	}
}
