use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex};
use tutasdk::bindings::rest_client::{
	HttpMethod, RestClient, RestClientError, RestClientOptions, RestResponse,
};
use tutasdk::bindings::test_file_client::TestFileClient;
use tutasdk::bindings::test_rest_client::TestRestClient;
use tutasdk::login::LoginError;
use tutasdk::net::native_rest_client::NativeRestClient;
use tutasdk::Sdk;

#[cfg_attr(
	not(feature = "test-with-local-http-server"),
	ignore = "require local http server."
)]
#[tokio::test]
async fn sdk_can_create_new_session() -> Result<(), Box<dyn Error>> {
	let rest_client = Arc::new(NativeRestClient::try_new().unwrap());
	let file_client = Arc::new(TestFileClient::default());

	// this test expect local server with matching model versions to be live at: http://localhost:9000
	let sdk = Sdk::new(
		"http://localhost:9000".to_string(),
		rest_client.clone(),
		file_client,
	);

	sdk.create_session("map-free@tutanota.de", "map")
		.await
		.map(|_| ())?;

	Ok(())
}

/// Answers the salt request with a Bcrypt account and records every request.
struct BcryptSaltServer {
	model: TestRestClient,
	requests: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl RestClient for BcryptSaltServer {
	async fn request_binary(
		&self,
		url: String,
		method: HttpMethod,
		options: RestClientOptions,
	) -> Result<RestResponse, RestClientError> {
		if !url.contains("/saltservice") {
			self.requests.lock().unwrap().push(url.clone());
			return self.model.request_binary(url, method, options).await;
		}
		self.requests.lock().unwrap().push(url.replace("%40", "@"));
		let salt = serde_json::json!({"421": "0", "422": "BwcHBwcHBwcHBwcHBwcHBw==", "2133": "0"});
		Ok(RestResponse {
			status: 200,
			headers: HashMap::new(),
			body: Some(serde_json::to_vec(&salt).unwrap()),
		})
	}
}

#[tokio::test]
async fn create_session_refuses_a_bcrypt_account_before_creating_a_session() {
	let server = Arc::new(BcryptSaltServer {
		model: TestRestClient::new("http://test"),
		requests: Mutex::new(vec![]),
	});
	let sdk = Sdk::new(
		"http://test".to_string(),
		server.clone(),
		Arc::new(TestFileClient::default()),
	);

	let result = sdk.create_session(" Map-Free@Tutanota.de ", "map").await;

	assert!(matches!(result, Err(LoginError::InvalidKey { .. })));
	let requests = server.requests.lock().unwrap();
	assert!(requests
		.iter()
		.any(|url| url.contains("map-free@tutanota.de")));
	assert!(!requests.iter().any(|url| url.contains("/sessionservice")));
}
