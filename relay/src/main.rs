use std::env::{self, VarError};
use std::process::ExitCode;
use std::str::FromStr;
use std::time::Duration;

use tokio::net::TcpListener;
use yiji_relay::{serve, Config};

fn var(name: &str) -> Result<Option<String>, String> {
    match env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(VarError::NotPresent) => Ok(None),
        Err(VarError::NotUnicode(_)) => Err(format!("{name} is not valid UTF-8")),
    }
}

fn positive<T: FromStr + Default + PartialEq>(name: &str) -> Result<Option<T>, String> {
    let Some(raw) = var(name)? else {
        return Ok(None);
    };
    match raw.parse::<T>() {
        Ok(n) if n != T::default() => Ok(Some(n)),
        _ => Err(format!("{name} must be a positive integer")),
    }
}

fn from_env() -> Result<(Config, String), String> {
    let text = |name| var(name).map(Option::unwrap_or_default);
    let (token, allow, origins) = (
        text("YIJI_TOKEN")?,
        text("YIJI_ALLOW")?,
        text("YIJI_ORIGINS")?,
    );
    let mut config = Config::new(&token, &allow, &origins)?;
    if let Some(n) = positive("YIJI_MAX_CONN")? {
        config.max_conn = n;
    }
    if let Some(n) = positive("YIJI_MAX_PENDING")? {
        config.max_pending = n;
    }
    if let Some(secs) = positive("YIJI_IDLE_SECS")? {
        config.idle = Duration::from_secs(secs);
    }
    let listen = var("YIJI_LISTEN")?.unwrap_or_else(|| "127.0.0.1:8080".into());
    Ok((config, listen))
}

#[tokio::main]
async fn main() -> ExitCode {
    let (config, listen) = match from_env() {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("yiji-relay: {e}");
            return ExitCode::FAILURE;
        }
    };
    let listener = match TcpListener::bind(&listen).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("yiji-relay: cannot listen on {listen}: {e}");
            return ExitCode::FAILURE;
        }
    };
    eprintln!("yiji-relay: listening on {listen}");
    serve(listener, config).await;
    ExitCode::SUCCESS
}
