use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, KeyInit, Mac};
use pbkdf2::pbkdf2_hmac;
use sha2::{Digest, Sha256};

/// Upper bound on the server-chosen iteration count so a hostile server cannot stall the tab.
const MAX_ITERATIONS: u32 = 1_000_000;

fn hmac(key: &[u8], message: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(message);
    mac.finalize().into_bytes().to_vec()
}

/// The `client-first-message-bare` part; the wire message is `n,,` followed by this.
pub fn client_first_bare(user: &str, nonce: &str) -> String {
    format!("n={},r={}", user.replace('=', "=3D").replace(',', "=2C"), nonce)
}

/// Returns the client-final-message and the server signature expected in the server-final-message.
pub fn client_final(
    password: &str,
    client_first_bare: &str,
    server_first: &str,
    client_nonce: &str,
) -> Result<(String, Vec<u8>), String> {
    let (mut nonce, mut salt, mut iterations) = (None, None, None);
    for part in server_first.split(',') {
        match part.split_once('=') {
            Some(("r", v)) => nonce = Some(v),
            Some(("s", v)) => salt = Some(v),
            Some(("i", v)) => iterations = Some(v),
            _ => {}
        }
    }
    let nonce = nonce
        .filter(|n| n.starts_with(client_nonce))
        .ok_or("server nonce does not extend the client nonce")?;
    let salt = STANDARD
        .decode(salt.ok_or("server-first has no salt")?)
        .map_err(|e| e.to_string())?;
    let iterations: u32 = iterations
        .ok_or("server-first has no iteration count")?
        .parse()
        .map_err(|_| "bad iteration count")?;
    if iterations == 0 || iterations > MAX_ITERATIONS {
        return Err(format!("unsupported iteration count {iterations}"));
    }

    // ponytail: SASLprep skipped, so non-ASCII passwords will not match the server's normalized form.
    let mut salted = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, iterations, &mut salted);
    let client_key = hmac(&salted, b"Client Key");
    let stored_key = Sha256::digest(&client_key);
    let without_proof = format!("c=biws,r={nonce}");
    let auth_message = format!("{client_first_bare},{server_first},{without_proof}");
    let client_signature = hmac(&stored_key[..], auth_message.as_bytes());
    let proof: Vec<u8> = client_key
        .iter()
        .zip(&client_signature)
        .map(|(a, b)| a ^ b)
        .collect();
    let server_signature = hmac(&hmac(&salted, b"Server Key"), auth_message.as_bytes());
    Ok((
        format!("{without_proof},p={}", STANDARD.encode(proof)),
        server_signature,
    ))
}

pub fn verify_server(server_final: &str, expected_signature: &[u8]) -> Result<(), String> {
    if let Some(error) = server_final.strip_prefix("e=") {
        return Err(format!("server rejected SCRAM: {error}"));
    }
    match server_final.strip_prefix("v=") {
        Some(v) if v == STANDARD.encode(expected_signature) => Ok(()),
        _ => Err("server signature mismatch".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 7677 section 3.
    const NONCE: &str = "rOprNGfwEbeRWgbNEkqO";
    const SERVER_FIRST: &str =
        "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";

    #[test]
    fn rfc7677_vector() {
        let bare = client_first_bare("user", NONCE);
        assert_eq!(bare, "n=user,r=rOprNGfwEbeRWgbNEkqO");
        let (client_final, signature) = client_final("pencil", &bare, SERVER_FIRST, NONCE).unwrap();
        assert_eq!(
            client_final,
            "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,\
             p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="
        );
        verify_server("v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=", &signature).unwrap();
        assert!(verify_server("v=AAAA", &signature).is_err());
    }

    #[test]
    fn rejects_foreign_nonce() {
        let bare = client_first_bare("user", NONCE);
        assert!(client_final("pencil", &bare, "r=other,s=W22Z,i=4096", NONCE).is_err());
    }

    #[test]
    fn escapes_username() {
        assert_eq!(client_first_bare("a=b,c", "n"), "n=a=3Db=2Cc,r=n");
    }
}
