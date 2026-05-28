//! Integration test for `CryptoEntityClient::decrypt_inline_and_parse`.
//!
//! The realtime event bus delivers a still-encrypted JSON of the affected
//! entity inside `EntityUpdate.instance`. A client should be able to
//! decrypt it locally instead of spending a REST round-trip to load the
//! same data. This test reuses the existing `download_mail_test` fixture
//! (a real captured server response for a Mail load) as the inline JSON
//! payload — the wire shape is identical.

use std::collections::HashMap;
use std::sync::Arc;

use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use tutasdk::bindings::rest_client::{HttpMethod, RestClient};
use tutasdk::bindings::test_file_client::TestFileClient;
use tutasdk::bindings::test_rest_client::TestRestClient;
use tutasdk::entities::generated::tutanota::Mail;
use tutasdk::login::{CredentialType, Credentials};
use tutasdk::{GeneratedId, Sdk};

fn make_rest_client_for_login() -> Arc<dyn RestClient> {
	let mut client = TestRestClient::new("http://localhost:9000");
	client.insert_response(
		"http://localhost:9000/rest/sys/Session/O1qC702-1J-0/3u3i8Lr9_7TnDDdAVw7w3TypTD2k1L00vIUTMF0SIPY",
		HttpMethod::GET,
		200,
		HashMap::default(),
		Some(include_bytes!("download_mail_test/session.json")),
	);
	client.insert_response(
		"http://localhost:9000/rest/sys/User/O1qC700----0",
		HttpMethod::GET,
		200,
		HashMap::default(),
		Some(include_bytes!("download_mail_test/user.json")),
	);
	Arc::new(client)
}

async fn login_for_test() -> Arc<tutasdk::LoggedInSdk> {
	let rest_client = make_rest_client_for_login();
	let file_client = Arc::new(TestFileClient::default());
	// Same credentials as `download_mail_test.rs` — the fixture's session is
	// keyed against them.
	let encrypted_passphrase_key = BASE64_STANDARD
		.decode("AZWEA/KTrHu0bW52CsctsBTTV4U3jrU51TadSxf6Nqs3xbEs3WfoOpPtxUDCNjHNppt6LHCfgTioejjGUJ2cCsXosZAysUiau5Nvyi8mtjLz")
		.unwrap();
	let credentials = Credentials {
		login: "bed-free@tutanota.de".to_string(),
		user_id: GeneratedId("O1qC700----0".to_owned()),
		access_token: "ZC2NIBDACUABAdJhibIwclzaPU3fEu-NzQ".to_string(),
		encrypted_passphrase_key,
		credential_type: CredentialType::Internal,
	};
	let sdk = Sdk::new(
		"http://localhost:9000".to_string(),
		rest_client,
		file_client,
	);
	sdk.login(credentials).await.unwrap()
}

#[tokio::test]
async fn decrypts_an_inline_mail_payload_without_rest() {
	// The fixture is the same encrypted Mail JSON the server returned for
	// the REST `load_mail_test` — it is the exact shape an event-bus
	// `EntityUpdate.instance` carries on Mail CREATE/UPDATE.
	let logged_in = login_for_test().await;
	let mail_json = include_str!("download_mail_test/mail.json");

	let mail: Option<Mail> = logged_in
		.mail_facade()
		.get_crypto_entity_client()
		.decrypt_inline_and_parse::<Mail>(mail_json)
		.await
		.expect("decrypt_inline must succeed on a valid fixture");

	let mail = mail.expect("session key is resolvable for this fixture");
	// Subject is the same one asserted by `download_mail_test.rs`, so
	// passing here proves the inline pipeline yields the same Mail as a
	// full REST load.
	assert_eq!(mail.subject, "Html email features");
	assert_eq!(mail.recipientCount, 1);
}

#[tokio::test]
async fn rejects_malformed_inline_json() {
	let logged_in = login_for_test().await;
	let err = logged_in
		.mail_facade()
		.get_crypto_entity_client()
		.decrypt_inline_and_parse::<Mail>("{ not json at all")
		.await
		.expect_err("malformed JSON must surface as an error, not a silent None");
	assert!(
		format!("{err:?}").contains("malformed JSON"),
		"unexpected error shape: {err:?}",
	);
}

#[tokio::test]
async fn empty_inline_json_object_is_a_session_key_miss() {
	// A well-formed JSON with no encryption metadata cannot resolve a
	// session key — the inline contract is to return `Ok(None)` so the
	// caller can fall back (e.g. to a REST load) rather than panic.
	let logged_in = login_for_test().await;
	let outcome = logged_in
		.mail_facade()
		.get_crypto_entity_client()
		.decrypt_inline_and_parse::<Mail>("{}")
		.await;
	// Either Err on parse (no required fields) OR Ok(None) on missing key
	// is acceptable — but never Ok(Some(mail)) and never a panic.
	match outcome {
		Ok(None) => {},
		Err(_) => {},
		Ok(Some(_)) => panic!("must not synthesise a Mail from an empty payload"),
	}
}
